"""Gate A: label quality of the Kev endpoint under DEFAULT_POLICY.

    python run_quality.py --endpoint https://<app>.modal.run --token-file ~/.kev_token
    python run_quality.py --local --device mps          # in-process kev model
    python run_quality.py ... --data holdout.jsonl      # default: posts.jsonl

Reports per-rule precision/recall (rule fires when p >= its hide threshold;
0.7 for substantive_critique, the exception-keep level), hide precision/recall,
and disagreement retention: the fraction of expected-show records labeled
substantive_critique=1 that the policy keeps visible (not hidden). Writes
results/quality-<timestamp>.json.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from common import (
    ALL_RULES,
    EXCEPTION_KEEP,
    HIDE_THRESHOLDS,
    add_backend_args,
    evaluate,
    load_jsonl,
    make_backend,
    request_body,
    results_path,
)

FIRE_THRESHOLDS = {**HIDE_THRESHOLDS, "substantive_critique": EXCEPTION_KEEP}


def prf(tp: int, fp: int, fn: int) -> tuple[float | None, float | None]:
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / (tp + fn) if tp + fn else None
    return precision, recall


def fmt(x: float | None) -> str:
    return "  n/a" if x is None else f"{x:5.2f}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    add_backend_args(ap)
    ap.add_argument("--data", default=str(Path(__file__).parent / "posts.jsonl"))
    args = ap.parse_args()

    records = load_jsonl(Path(args.data))
    backend = make_backend(args)
    rows = []
    try:
        for rec in records:
            probs, latency = backend.answer(request_body(rec))
            disposition = evaluate(probs)
            rows.append(
                {
                    "id": rec.id,
                    "topic": rec.topic,
                    "expected": rec.expected,
                    "expected_disposition": rec.expected_disposition,
                    "probabilities": probs,
                    "disposition": disposition,
                    "latency_ms": latency,
                }
            )
            flag = "" if disposition == rec.expected_disposition else "  <-- MISMATCH"
            probs_s = " ".join(f"{r[:4]}={probs[r]:.2f}" for r in ALL_RULES)
            print(f"{rec.id:22s} want {rec.expected_disposition:4s} got {disposition:9s} {probs_s}{flag}")
    finally:
        backend.close()

    per_rule = {}
    for rid in ALL_RULES:
        t = FIRE_THRESHOLDS[rid]
        tp = sum(1 for r in rows if r["expected"][rid] and r["probabilities"][rid] >= t)
        fp = sum(1 for r in rows if not r["expected"][rid] and r["probabilities"][rid] >= t)
        fn = sum(1 for r in rows if r["expected"][rid] and r["probabilities"][rid] < t)
        p, rc = prf(tp, fp, fn)
        pos = [r["probabilities"][rid] for r in rows if r["expected"][rid]]
        neg = [r["probabilities"][rid] for r in rows if not r["expected"][rid]]
        per_rule[rid] = {
            "threshold": t,
            "tp": tp,
            "fp": fp,
            "fn": fn,
            "precision": p,
            "recall": rc,
            "min_positive": min(pos) if pos else None,
            "max_negative": max(neg) if neg else None,
        }

    hid = [r for r in rows if r["disposition"] == "hide"]
    tp = sum(1 for r in hid if r["expected_disposition"] == "hide")
    fp = len(hid) - tp
    fn = sum(1 for r in rows if r["expected_disposition"] == "hide" and r["disposition"] != "hide")
    hide_p, hide_r = prf(tp, fp, fn)

    critiques = [r for r in rows if r["expected_disposition"] == "show" and r["expected"]["substantive_critique"]]
    retained = sum(1 for r in critiques if r["disposition"] != "hide")
    retention = retained / len(critiques) if critiques else None

    agree = sum(1 for r in rows if r["disposition"] == r["expected_disposition"])
    uncertain = sum(1 for r in rows if r["disposition"] == "uncertain")

    print()
    print(f"{'rule':22s} {'thr':>5s} {'prec':>6s} {'rec':>6s}   tp fp fn   {'min+':>5s} {'max-':>5s}")
    for rid, m in per_rule.items():
        print(
            f"{rid:22s} {m['threshold']:5.2f} {fmt(m['precision']):>6s} {fmt(m['recall']):>6s}   "
            f"{m['tp']:2d} {m['fp']:2d} {m['fn']:2d}   {fmt(m['min_positive']):>5s} {fmt(m['max_negative']):>5s}"
        )
    print("(min+ / max- = lowest probability on an expected-positive / highest on an expected-negative; separable iff min+ > max-)")
    print()
    print(f"hide precision          {fmt(hide_p)}   (tp={tp} fp={fp})")
    print(f"hide recall             {fmt(hide_r)}   (fn={fn})")
    print(f"disagreement retention  {fmt(retention)}   ({retained}/{len(critiques)} expected-show critiques stay visible)")
    print(f"disposition agreement   {agree / len(rows):5.2f}   ({agree}/{len(rows)}, {uncertain} uncertain)")

    summary = {
        "backend": backend.name,
        "data": str(args.data),
        "n": len(rows),
        "per_rule": per_rule,
        "hide": {"precision": hide_p, "recall": hide_r, "tp": tp, "fp": fp, "fn": fn},
        "disagreement_retention": {"value": retention, "retained": retained, "total": len(critiques)},
        "disposition_agreement": agree / len(rows),
        "uncertain": uncertain,
        "rows": rows,
    }
    out = results_path("quality")
    out.write_text(json.dumps(summary, indent=2))
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
