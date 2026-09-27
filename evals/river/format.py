"""Convert eval sets and extension feedback exports into River SFT records.

Each output line is one (post, rule) chat in the proxy's prompt shape
(services/river/prompt.py) plus the yes/no completion the fine-tune trains on:

    {"messages": build_messages(...), "completion": "yes"|"no",
     "meta": {"post_id", "rule_id", "source": "feedback"|"override"|"eval",
              "prompt_version"}}

    python format.py --eval ../posts.jsonl --out sft-dev.jsonl
    python format.py --export export.json --out sft-feedback.jsonl

Export shape (extension feedback export):

    {"feedback": [{"postId", "ruleId"?, "desiredAction": "hide"|"keep",
                   "text", "createdAt"}...],
     "overrides": [{"postId", "action": "keep"|"hide", "createdAt"}...],
     "posts": {<postId>: {"text", "quoteText"?, "causeRuleIds"?: [...]}},
     "rules"?: [{"id", "instruction"}...]}   # user-edited rule text

Labels: feedback hide -> yes / keep -> no for its ruleId; an override "keep"
means "no" for every rule in posts[postId].causeRuleIds; override "hide" is
unattributable and skipped. Latest createdAt wins per (post_id, rule_id).
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Iterable
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "river"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from common import ALL_RULES, RULES, TASK_INSTRUCTION, Record, load_jsonl  # noqa: E402
from prompt import PROMPT_VERSION, build_messages  # noqa: E402


def _record(post_id: str, rule_id: str, source: str, text: str, quote_text: str | None, rule_text: str, label: str) -> dict:
    return {
        "messages": build_messages(TASK_INSTRUCTION, rule_text, text, quote_text),
        "completion": label,
        "meta": {"post_id": post_id, "rule_id": rule_id, "source": source, "prompt_version": PROMPT_VERSION},
    }


def records_from_eval(records: list[Record]) -> list[dict]:
    """One record per post x ALL_RULES; "yes" iff expected[rule] == 1."""
    out = []
    for rec in records:
        for rid in ALL_RULES:
            label = "yes" if rec.expected[rid] == 1 else "no"
            out.append(_record(rec.id, rid, "eval", rec.text, rec.quote_text, RULES[rid], label))
    return out


def _rules_for_export(export: dict, rules: dict[str, str] | None) -> dict[str, str]:
    out = dict(rules or RULES)
    for r in export.get("rules") or []:
        out[r["id"]] = r["instruction"]
    return out


def _order(v) -> tuple:
    """Type-safe ordering key for createdAt: numbers and numeric strings sort
    together before anything else (extension uses ms epoch ints; old exports
    used ISO strings)."""
    try:
        return (0, float(v))
    except (TypeError, ValueError):
        return (1, str(v))


def records_from_export(export: dict, rules: dict[str, str] | None = None) -> tuple[list[dict], dict]:
    """(records, stats) from a feedback export. Dedupe by (post_id, rule_id),
    latest createdAt wins across feedback and overrides."""
    rule_text = _rules_for_export(export, rules)
    posts = export.get("posts") or {}
    stats = {"feedback": 0, "overrides": 0, "skipped_no_rule": 0, "skipped_no_post": 0, "skipped_unattributed": 0, "deduped": 0}

    # (post_id, rule_id) -> (createdAt order key, record)
    best: dict[tuple[str, str], tuple[tuple, dict]] = {}

    def put(post_id: str, rid: str, source: str, created_at, rec: dict) -> None:
        key = (post_id, rid)
        order = _order(created_at)
        if key in best:
            stats["deduped"] += 1
            if order <= best[key][0]:
                return
        best[key] = (order, rec)

    for fb in export.get("feedback") or []:
        rid = fb.get("ruleId")
        if not rid or rid not in rule_text:
            stats["skipped_no_rule"] += 1
            continue
        post_id = fb.get("postId") or ""
        text = fb.get("text") or (posts.get(post_id) or {}).get("text")
        if not text:
            stats["skipped_no_post"] += 1
            continue
        action = fb.get("desiredAction")
        if action not in ("hide", "keep"):
            stats["skipped_unattributed"] += 1
            continue
        quote = (posts.get(post_id) or {}).get("quoteText")
        label = "yes" if action == "hide" else "no"
        stats["feedback"] += 1
        put(post_id, rid, "feedback", fb.get("createdAt") or "", _record(post_id, rid, "feedback", text, quote, rule_text[rid], label))

    for ov in export.get("overrides") or []:
        post_id = ov.get("postId") or ""
        post = posts.get(post_id)
        if not post or not post.get("text"):
            stats["skipped_no_post"] += 1
            continue
        if ov.get("action") != "keep":
            stats["skipped_unattributed"] += 1
            continue
        causes = [rid for rid in (post.get("causeRuleIds") or []) if rid in rule_text]
        if not causes:
            stats["skipped_unattributed"] += 1
            continue
        stats["overrides"] += 1
        for rid in causes:
            put(
                post_id,
                rid,
                "override",
                ov.get("createdAt") or "",
                _record(post_id, rid, "override", post["text"], post.get("quoteText"), rule_text[rid], "no"),
            )

    return [rec for _, rec in best.values()], stats


def _write(records: Iterable[dict], out_path: Path) -> None:
    lines = [json.dumps(r) for r in records]
    out_path.write_text("\n".join(lines) + ("\n" if lines else ""))


def _summarize(records: list[dict]) -> None:
    print(f"{len(records)} records")
    by_rule: dict[str, dict[str, int]] = {}
    for r in records:
        counts = by_rule.setdefault(r["meta"]["rule_id"], {"yes": 0, "no": 0})
        counts[r["completion"]] += 1
    for rid, counts in by_rule.items():
        print(f"  {rid}: yes={counts['yes']} no={counts['no']}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--eval", type=Path, help="eval JSONL (posts.jsonl shape)")
    src.add_argument("--export", type=Path, help="extension feedback export JSON")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    if args.eval:
        records = records_from_eval(load_jsonl(args.eval))
        stats = None
    else:
        export = json.loads(args.export.read_text())
        records, stats = records_from_export(export)
    _write(records, args.out)
    _summarize(records)
    if stats:
        print("stats:", json.dumps(stats))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
