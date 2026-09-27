import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from common import Record  # noqa: E402
from format import records_from_eval, records_from_export  # noqa: E402

EXPECTED = {"rage_bait": 1, "hype": 0, "engagement_farming": 0, "substantive_critique": 0}
EXPECTED2 = {"rage_bait": 0, "hype": 1, "engagement_farming": 0, "substantive_critique": 1}
RECORDS = [
    Record(id="p1", text="rage post", quote_text=None, expected=EXPECTED, expected_disposition="hide"),
    Record(id="p2", text="hype post", quote_text="quoted", expected=EXPECTED2, expected_disposition="hide"),
]


def test_records_from_eval() -> None:
    out = records_from_eval(RECORDS)
    assert len(out) == 8
    p1 = {r["meta"]["rule_id"]: r for r in out if r["meta"]["post_id"] == "p1"}
    assert p1["rage_bait"]["completion"] == "yes"
    assert p1["hype"]["completion"] == "no"
    for r in out:
        assert r["meta"]["source"] == "eval"
        assert r["meta"]["prompt_version"]
        assert r["messages"][0]["role"] == "system"
        assert r["messages"][1]["role"] == "user"
    assert "Rule:" in p1["rage_bait"]["messages"][1]["content"]
    assert "rage post" in p1["rage_bait"]["messages"][1]["content"]
    assert "Quoted post:" not in p1["rage_bait"]["messages"][1]["content"]
    p2 = {r["meta"]["rule_id"]: r for r in out if r["meta"]["post_id"] == "p2"}
    assert "Quoted post: quoted" in p2["hype"]["messages"][1]["content"]


def export() -> dict:
    return {
        "posts": {
            "a": {"text": "post a text", "quoteText": "qa", "causeRuleIds": ["rage_bait", "hype"]},
            "b": {"text": "post b text", "causeRuleIds": []},
            "c": {"text": "post c text"},
        },
        "feedback": [
            {"postId": "a", "ruleId": "rage_bait", "desiredAction": "hide", "text": "post a text", "createdAt": "2026-01-01T00:00:00Z"},
            {"postId": "a", "ruleId": "nonexistent_rule", "desiredAction": "hide", "text": "x", "createdAt": "2026-01-01T00:00:01Z"},
            {"postId": "zzz", "ruleId": "hype", "desiredAction": "keep", "createdAt": "2026-01-01T00:00:02Z"},
            {"postId": "a", "desiredAction": "hide", "text": "no rule id", "createdAt": "2026-01-01T00:00:03Z"},
            {"postId": "c", "ruleId": "hype", "desiredAction": "keep", "text": "post c text", "createdAt": "2026-01-01T00:00:04Z"},
        ],
        "overrides": [
            {"postId": "a", "action": "keep", "createdAt": "2026-01-02T00:00:00Z"},
            {"postId": "b", "action": "keep", "createdAt": "2026-01-02T00:00:01Z"},
            {"postId": "c", "action": "hide", "createdAt": "2026-01-02T00:00:02Z"},
            {"postId": "missing", "action": "keep", "createdAt": "2026-01-02T00:00:03Z"},
        ],
    }


def test_records_from_export() -> None:
    records, stats = records_from_export(export())
    by_key = {(r["meta"]["post_id"], r["meta"]["rule_id"]): r for r in records}
    # override keep on post "a" (later createdAt) wins over the feedback hide on rage_bait
    assert by_key[("a", "rage_bait")]["completion"] == "no"
    assert by_key[("a", "rage_bait")]["meta"]["source"] == "override"
    assert by_key[("a", "hype")]["completion"] == "no"
    # feedback keep on post "c"/hype survives (override hide on "c" is unattributable)
    assert by_key[("c", "hype")]["completion"] == "no"
    assert by_key[("c", "hype")]["meta"]["source"] == "feedback"
    assert "Quoted post: qa" in by_key[("a", "rage_bait")]["messages"][1]["content"]
    assert stats == {
        "feedback": 2,
        "overrides": 1,
        "skipped_no_rule": 2,
        "skipped_no_post": 2,
        "skipped_unattributed": 2,
        "deduped": 1,
    }


def test_export_rules_override() -> None:
    e = export()
    e["rules"] = [{"id": "rage_bait", "instruction": "USER EDITED RULE TEXT"}]
    records, _ = records_from_export(e)
    rage = [r for r in records if r["meta"]["rule_id"] == "rage_bait"]
    assert rage and all("USER EDITED RULE TEXT" in r["messages"][1]["content"] for r in rage)
    hype = [r for r in records if r["meta"]["rule_id"] == "hype"]
    assert hype and all("USER EDITED" not in r["messages"][1]["content"] for r in hype)


def test_export_dedupe_feedback_wins_when_later() -> None:
    e = {
        "posts": {"a": {"text": "t", "causeRuleIds": ["rage_bait"]}},
        "feedback": [{"postId": "a", "ruleId": "rage_bait", "desiredAction": "hide", "text": "t", "createdAt": "2026-02-01T00:00:00Z"}],
        "overrides": [{"postId": "a", "action": "keep", "createdAt": "2026-01-01T00:00:00Z"}],
    }
    records, stats = records_from_export(e)
    assert len(records) == 1
    assert records[0]["completion"] == "yes"
    assert records[0]["meta"]["source"] == "feedback"
    assert stats["deduped"] == 1


def test_main_writes_jsonl(tmp_path) -> None:
    from format import main

    eval_path = tmp_path / "posts.jsonl"
    eval_path.write_text(json.dumps({"id": "x", "text": "t", "expected": EXPECTED, "expected_disposition": "hide", "topic": ""}) + "\n")
    out = tmp_path / "out.jsonl"
    sys.argv = ["format.py", "--eval", str(eval_path), "--out", str(out)]
    main()
    lines = out.read_text().splitlines()
    assert len(lines) == 4
    assert json.loads(lines[0])["meta"]["post_id"] == "x"
