"""Aggregate an extension "train on my corrections" bundle into SFT records.

The extension POSTs an ExportBundle (`extension/src/options/state.ts`):

    {"exportedAt", "policy": {"revision", "rules": [{"id", "title",
       "instruction", "enabled", "hideThreshold"?, "exceptionRuleIds"}]},
     "feedback": [Feedback...], "overrides": {<postId>: Override} | [Override...],
     "history"?: [DecisionResult + {"post": {"text", "quoteText"?}, "at"}...]}

`bundle_to_export` drops `kind == "change_preference"` feedback (the user
edited the rule text, so the old label is stale) and normalizes the rest into
format.py's export shape
(`{rules, feedback, overrides(list), posts}`); `aggregate` runs
`records_from_export` on it and appends `records_from_eval` on a seed eval set
(posts.jsonl by default) so a handful of corrections doesn't wipe base
behaviour — user records always win on (post_id, rule_id) collisions.

    python aggregate.py --bundle export.json [--seed ../posts.jsonl | --no-seed] --out sft.jsonl
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "river"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from common import Record, load_jsonl  # noqa: E402
from format import records_from_eval, records_from_export  # noqa: E402

DEFAULT_SEED = Path(__file__).resolve().parents[1] / "posts.jsonl"


def bundle_to_export(bundle: dict) -> dict:
    """ExportBundle -> format.py export shape. `posts` = latest-by-`at` history
    entry per postId (carries text + quoteText + causeRuleIds); `overrides`
    accepts both the dict and list forms; rule text comes from `policy.rules`."""
    posts: dict[str, dict] = {}
    for h in bundle.get("history") or []:
        post_id = h.get("postId")
        post = h.get("post") or {}
        if not post_id or not post.get("text"):
            continue
        at = h.get("at") or 0
        cur = posts.get(post_id)
        if cur is None or at >= cur["_at"]:
            posts[post_id] = {
                "text": post["text"],
                "quoteText": post.get("quoteText"),
                "causeRuleIds": h.get("causeRuleIds") or [],
                "_at": at,
            }
    posts = {pid: {k: v for k, v in p.items() if k != "_at"} for pid, p in posts.items()}

    overrides = bundle.get("overrides") or []
    if isinstance(overrides, dict):
        overrides = list(overrides.values())

    rules = [
        {"id": r["id"], "instruction": r["instruction"]}
        for r in (bundle.get("policy") or {}).get("rules") or []
        if r.get("id") and r.get("instruction")
    ]

    feedback = []
    for fb in bundle.get("feedback") or []:
        if fb.get("kind") == "change_preference":
            continue
        fb = dict(fb)
        if not fb.get("quoteText") and (p := posts.get(fb.get("postId") or "")):
            fb["quoteText"] = p.get("quoteText")
        feedback.append(fb)

    return {"rules": rules, "feedback": feedback, "overrides": overrides, "posts": posts}


def aggregate(bundle: dict, seed: list[Record] | None = None) -> tuple[list[dict], dict]:
    """(records, stats). `seed=None` loads evals/posts.jsonl; pass [] for no
    seed. Seed records never override a user record for the same
    (post_id, rule_id)."""
    export = bundle_to_export(bundle)
    user_records, stats = records_from_export(export)
    skipped_change_preference = sum(1 for fb in bundle.get("feedback") or [] if fb.get("kind") == "change_preference")

    if seed is None:
        seed = load_jsonl(DEFAULT_SEED)
    seen = {(r["meta"]["post_id"], r["meta"]["rule_id"]) for r in user_records}
    merged = list(user_records)
    n_seed = 0
    for rec in records_from_eval(seed):
        key = (rec["meta"]["post_id"], rec["meta"]["rule_id"])
        if key in seen:
            continue
        seen.add(key)
        merged.append(rec)
        n_seed += 1

    by_rule: dict[str, dict[str, int]] = {}
    for r in user_records:
        counts = by_rule.setdefault(r["meta"]["rule_id"], {"yes": 0, "no": 0})
        counts[r["completion"]] += 1

    stats = {
        **stats,
        "user_labels": len(user_records),
        "seed_labels": n_seed,
        "skipped_change_preference": skipped_change_preference,
        "by_rule": by_rule,
    }
    return merged, stats


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bundle", type=Path, required=True, help="extension ExportBundle JSON")
    ap.add_argument("--seed", type=Path, default=None, help="eval JSONL to mix in (default: ../posts.jsonl)")
    ap.add_argument("--no-seed", action="store_true", help="user labels only")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    bundle = json.loads(args.bundle.read_text())
    if args.no_seed:
        seed: list[Record] | None = []
    elif args.seed:
        seed = load_jsonl(args.seed)
    else:
        seed = None
    records, stats = aggregate(bundle, seed)
    args.out.write_text("\n".join(json.dumps(r) for r in records) + ("\n" if records else ""))
    print(json.dumps(stats))
    print(f"wrote {args.out} ({len(records)} records)")


if __name__ == "__main__":
    main()
