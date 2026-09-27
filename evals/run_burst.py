"""Gate B: burst latency of the Kev endpoint.

    python run_burst.py --endpoint https://<app>.modal.run --token-file ~/.kev_token

Fires 1, 8 and 30 concurrent requests (each level repeated --rounds times) built
from posts.jsonl and reports p50/p95 of:

  * server_ms  -- Kev's own `latency_ms` (model time inside the container)
  * rtt_ms     -- request round trip as seen by this script (includes network and
                  Modal's ingress; NOT the browser's wall clock, which also pays
                  for the content script, service worker and tab scheduling)

Writes results/burst-<timestamp>.json.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

from common import add_backend_args, load_jsonl, make_backend, request_body, results_path


def pct(xs: list[float], q: float) -> float | None:
    if not xs:
        return None
    ys = sorted(xs)
    k = (len(ys) - 1) * q
    lo, hi = int(k), min(int(k) + 1, len(ys) - 1)
    return ys[lo] + (ys[hi] - ys[lo]) * (k - lo)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    add_backend_args(ap)
    ap.add_argument("--data", default=str(Path(__file__).parent / "posts.jsonl"))
    ap.add_argument("--levels", default="1,8,30")
    ap.add_argument("--rounds", type=int, default=3, help="repeat each concurrency level this many times")
    args = ap.parse_args()
    if args.local:
        raise SystemExit("run_burst measures the served endpoint; --local is not supported")

    records = load_jsonl(Path(args.data))
    bodies = [request_body(r) for r in records]
    backend = make_backend(args)
    levels = [int(x) for x in args.levels.split(",")]

    def one(i: int) -> tuple[float, float | None] | Exception:
        t0 = time.perf_counter()
        try:
            _, server_ms = backend.answer(bodies[i % len(bodies)])
        except (httpx.HTTPError, OSError) as e:
            return e
        return (time.perf_counter() - t0) * 1000, server_ms

    print("warming up (2 requests)...")
    for i in range(2):
        one(i)

    results = []
    print()
    print(f"{'conc':>4s} {'reqs':>4s} {'err':>3s}  {'server p50':>10s} {'server p95':>10s}  {'rtt p50':>8s} {'rtt p95':>8s}  wall/burst")
    try:
        for n in levels:
            rtts, servers, walls, errors = [], [], [], []
            for _ in range(args.rounds):
                t0 = time.perf_counter()
                with ThreadPoolExecutor(max_workers=n) as ex:
                    out = list(ex.map(one, range(n)))
                walls.append((time.perf_counter() - t0) * 1000)
                errors += [repr(o) for o in out if isinstance(o, Exception)]
                ok = [o for o in out if not isinstance(o, Exception)]
                rtts += [o[0] for o in ok]
                servers += [o[1] for o in ok if o[1] is not None]
            row = {
                "concurrency": n,
                "requests": n * args.rounds,
                "errors": errors,
                "server_ms": {"p50": pct(servers, 0.5), "p95": pct(servers, 0.95), "n": len(servers)},
                "rtt_ms": {"p50": pct(rtts, 0.5), "p95": pct(rtts, 0.95)},
                "burst_wall_ms_mean": statistics.mean(walls),
            }
            results.append(row)
            sp50 = row["server_ms"]["p50"]
            sp95 = row["server_ms"]["p95"]
            fmt = lambda v: "n/a" if v is None else f"{v:.0f}"  # noqa: E731
            print(
                f"{n:4d} {row['requests']:4d} {len(errors):3d}  {fmt(sp50):>10s} {fmt(sp95):>10s}  "
                f"{fmt(row['rtt_ms']['p50']):>8s} {fmt(row['rtt_ms']['p95']):>8s}  {row['burst_wall_ms_mean']:10.0f}"
            )
            for e in errors:
                print(f"       error: {e}")
    finally:
        backend.close()

    print("\nserver_ms = model time reported by Kev; rtt_ms = this client's round trip. Neither is browser wall-clock.")
    out = results_path("burst")
    out.write_text(json.dumps({"backend": backend.name, "rounds": args.rounds, "levels": results}, indent=2))
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
