"""LoRA SFT on River from format.py records; saves an inference checkpoint the proxy can serve.

    python format.py --eval ../posts.jsonl --out sft-dev.jsonl
    RIVER_API_KEY=... python sft.py --data sft-dev.jsonl --name af-v1 [--epochs 3 --batch 30 --lr 1e-4]
    RIVER_CHECKPOINT=river://... python ../../services/river/proxy.py     # serve it

Thin CLI over services/river/train.py (the same code the proxy's /v1/train job
runs). Cost guard: the run aborts if it exceeds --max-minutes of session time.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import river_client

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "river"))

from train import TrainConfig, run_sft  # noqa: E402

from proxy import DEFAULT_MODEL  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--name", required=True, help="checkpoint name")
    ap.add_argument("--base-model", default=DEFAULT_MODEL)
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--batch", type=int, default=30)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--max-minutes", type=float, default=15.0)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", type=Path, default=Path("sft-result.json"))
    args = ap.parse_args()

    records = [json.loads(line) for line in args.data.read_text().splitlines() if line.strip()]
    cfg = TrainConfig(
        base_model=args.base_model,
        epochs=args.epochs,
        batch=args.batch,
        lr=args.lr,
        rank=args.rank,
        max_minutes=args.max_minutes,
        seed=args.seed,
    )
    client = river_client.Client(api_key=os.environ["RIVER_API_KEY"], endpoint="api.river.ai")
    result = run_sft(client, records, args.name, cfg)
    args.out.write_text(json.dumps(result, indent=2) + "\n")
    print(f"checkpoint: {result['checkpoint']}  ({result['session_seconds']:.0f}s session time) -> {args.out}")


if __name__ == "__main__":
    main()
