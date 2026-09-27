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
    add_backend_args,
    evaluate,
    load_jsonl,
    make_backend,
    request_body,
    results_path,
    summarize,
)


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

    metrics = summarize(rows)
    per_rule = metrics["per_rule"]
    hide, retention = metrics["hide"], metrics["disagreement_retention"]

    print()
    print(f"{'rule':22s} {'thr':>5s} {'prec':>6s} {'rec':>6s}   tp fp fn   {'min+':>5s} {'max-':>5s}")
    for rid, m in per_rule.items():
        print(
            f"{rid:22s} {m['threshold']:5.2f} {fmt(m['precision']):>6s} {fmt(m['recall']):>6s}   "
            f"{m['tp']:2d} {m['fp']:2d} {m['fn']:2d}   {fmt(m['min_positive']):>5s} {fmt(m['max_negative']):>5s}"
        )
    print("(min+ / max- = lowest probability on an expected-positive / highest on an expected-negative; separable iff min+ > max-)")
    print()
    agree = round(metrics["disposition_agreement"] * len(rows))
    print(f"hide precision          {fmt(hide['precision'])}   (tp={hide['tp']} fp={hide['fp']})")
    print(f"hide recall             {fmt(hide['recall'])}   (fn={hide['fn']})")
    kept = f"({retention['retained']}/{retention['total']} expected-show critiques stay visible)"
    print(f"disagreement retention  {fmt(retention['value'])}   {kept}")
    print(f"disposition agreement   {metrics['disposition_agreement']:5.2f}   ({agree}/{len(rows)}, {metrics['uncertain']} uncertain)")

    summary = {"backend": backend.name, "data": str(args.data), **metrics, "rows": rows}
    out = results_path("quality")
    out.write_text(json.dumps(summary, indent=2))
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
