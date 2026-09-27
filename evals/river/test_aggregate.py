import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aggregate import aggregate, bundle_to_export  # noqa: E402

from common import Record  # noqa: E402

EXPECTED = {"rage_bait": 1, "hype": 0, "engagement_farming": 0, "substantive_critique": 0}
SEED = [Record(id="seed1", text="seed post", quote_text=None, expected=EXPECTED, expected_disposition="hide")]


def fb(fid: str, post_id: str, rule_id: str, kind: str, action: str, created_at) -> dict:
    return {
        "feedbackId": fid,
        "postId": post_id,
        "ruleId": rule_id,
        "kind": kind,
        "desiredAction": action,
        "text": f"post {post_id}",
        "createdAt": created_at,
    }


def hist(post_id: str, causes: list[str], text: str, at: int, quote: str | None = None) -> dict:
    post = {"text": text} | ({"quoteText": quote} if quote else {})
    return {"postId": post_id, "causeRuleIds": causes, "disposition": "hide", "post": post, "at": at}


def bundle() -> dict:
    return {
        "exportedAt": "2026-03-01T00:00:00Z",
        "policy": {
            "revision": 7,
            "rules": [
                {"id": "rage_bait", "title": "Rage bait", "instruction": "USER RAGE RULE", "enabled": True},
                {"id": "hype", "title": "Hype", "instruction": "USER HYPE RULE", "enabled": True},
                {"id": "no_instruction", "title": "Broken"},
            ],
        },
        "feedback": [
            fb("f1", "a", "rage_bait", "confirm_hide", "hide", 1730000000000),
            fb("f2", "b", "hype", "confirm_show", "keep", 1730000001000),
            fb("f3", "b", "hype", "change_preference", "hide", 1730000009000),
        ],
        "overrides": {
            "c": {"postId": "c", "contentHash": "h", "action": "keep", "createdAt": 1730000002000},
        },
        "history": [
            hist("a", ["rage_bait"], "post a", 1730000000000, quote="qa"),
            hist("c", ["hype"], "post c OLD", 1730000000000),
            hist("c", ["rage_bait", "hype"], "post c NEW", 1730000005000),
        ],
    }


def test_bundle_to_export_shapes() -> None:
    e = bundle_to_export(bundle())
    assert e["rules"] == [{"id": "rage_bait", "instruction": "USER RAGE RULE"}, {"id": "hype", "instruction": "USER HYPE RULE"}]
    # latest-by-`at` history entry wins and supplies text + causeRuleIds
    assert e["posts"]["c"] == {"text": "post c NEW", "quoteText": None, "causeRuleIds": ["rage_bait", "hype"]}
    assert e["posts"]["a"]["quoteText"] == "qa"
    # change_preference dropped; quoteText backfilled from history
    assert [f["feedbackId"] for f in e["feedback"]] == ["f1", "f2"]
    assert e["feedback"][0]["quoteText"] == "qa"


def test_overrides_dict_and_list_agree() -> None:
    as_dict = bundle()
    as_list = bundle()
    as_list["overrides"] = list(as_dict["overrides"].values())
    assert bundle_to_export(as_dict)["overrides"] == bundle_to_export(as_list)["overrides"]


def test_aggregate_labels_and_stats() -> None:
    records, stats = aggregate(bundle(), seed=[])
    by_key = {(r["meta"]["post_id"], r["meta"]["rule_id"]): r for r in records}
    assert by_key[("a", "rage_bait")]["completion"] == "yes"  # confirm_hide
    assert by_key[("b", "hype")]["completion"] == "no"  # confirm_show
    # override keep on c -> "no" for both cause rules from the latest history entry
    assert by_key[("c", "rage_bait")]["completion"] == "no"
    assert by_key[("c", "hype")]["completion"] == "no"
    assert "USER RAGE RULE" in by_key[("a", "rage_bait")]["messages"][1]["content"]
    assert stats["user_labels"] == 4
    assert stats["seed_labels"] == 0
    assert stats["skipped_change_preference"] == 1
    assert stats["by_rule"] == {"rage_bait": {"yes": 1, "no": 1}, "hype": {"yes": 0, "no": 2}}


def test_numeric_created_at_latest_wins() -> None:
    b = bundle()
    b["feedback"] = [
        fb("f1", "a", "rage_bait", "confirm_hide", "hide", 1730000000000),
        fb("f2", "a", "rage_bait", "wrong_classification", "keep", 9),
    ]
    b["overrides"] = {}
    b["history"] = [h for h in b["history"] if h["postId"] == "a"]
    records, stats = aggregate(b, seed=[])
    # 9 < 1730000000000 numerically (as strings "9" would have sorted last)
    assert [r["completion"] for r in records] == ["yes"]
    assert stats["deduped"] == 1


def test_seed_is_appended_and_user_wins_collisions() -> None:
    records, stats = aggregate(bundle(), seed=SEED)
    assert stats["seed_labels"] == 4  # one seed post x 4 rules
    assert len(records) == stats["user_labels"] + stats["seed_labels"]
    assert {r["meta"]["source"] for r in records} == {"feedback", "override", "eval"}

    collide = [Record(id="a", text="seed version of post a", quote_text=None, expected=EXPECTED, expected_disposition="hide")]
    records, stats = aggregate(bundle(), seed=collide)
    by_key = {(r["meta"]["post_id"], r["meta"]["rule_id"]): r for r in records}
    assert by_key[("a", "rage_bait")]["meta"]["source"] == "feedback"
    assert stats["seed_labels"] == 3  # rage_bait dropped in favour of the user label


def test_default_seed_is_posts_jsonl() -> None:
    _, stats = aggregate(bundle())
    assert stats["seed_labels"] > 0


def test_main_writes_jsonl(tmp_path) -> None:
    from aggregate import main

    bundle_path = tmp_path / "export.json"
    bundle_path.write_text(json.dumps(bundle()))
    out = tmp_path / "sft.jsonl"
    sys.argv = ["aggregate.py", "--bundle", str(bundle_path), "--no-seed", "--out", str(out)]
    main()
    lines = out.read_text().splitlines()
    assert len(lines) == 4
    assert json.loads(lines[0])["meta"]["post_id"] == "a"
