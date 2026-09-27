"""LoRA SFT on River from format.py records; saves an inference checkpoint the proxy can serve.

    python format.py --eval ../posts.jsonl --out sft-dev.jsonl
    RIVER_API_KEY=... python sft.py --data sft-dev.jsonl --name af-v1 [--epochs 3 --batch 30 --lr 1e-4]
    RIVER_CHECKPOINT=river://... python ../../services/river/proxy.py     # serve it

Records are rendered with the package renderer for the base model (thinking off,
matching proxy.CHAT_KWARGS) and trained on the last assistant turn only, so the
fine-tune moves the same first answer token the proxy reads P(yes) from.
Cost guard: the run aborts if it exceeds --max-minutes of session time.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from pathlib import Path

import river_client
from river_client.renderers import TrainOnWhat, get_renderer

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "river"))

from proxy import DEFAULT_MODEL  # noqa: E402


def render(records: list[dict], base_model: str) -> list[dict]:
    tok = river_client.load_tokenizer(base_model=base_model)
    renderer = get_renderer(base_model, thinking=False, tokenizer=tok)
    out = []
    for r in records:
        msgs = [*r["messages"], {"role": "assistant", "content": r["completion"]}]
        out.append(renderer.build_training_example(msgs, train_on=TrainOnWhat.LAST_ASSISTANT).to_dict())
    return out


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
    data = render(records, args.base_model)
    print(f"{len(data)} examples, {sum(len(d['weights']) for d in data)} tokens")

    client = river_client.Client(api_key=os.environ["RIVER_API_KEY"], endpoint="api.river.ai")
    rng = random.Random(args.seed)
    t0 = time.perf_counter()
    losses = []
    with client.session(project="attention-filter", run=args.name) as session:
        print(f"session ready in {time.perf_counter() - t0:.1f}s")
        model = session.create_model(base_model=args.base_model, lora=river_client.LoraConfig(rank=args.rank, seed=args.seed))
        print(f"model ready in {time.perf_counter() - t0:.1f}s")
        for epoch in range(args.epochs):
            rng.shuffle(data)
            for i in range(0, len(data), args.batch):
                if (time.perf_counter() - t0) / 60 > args.max_minutes:
                    raise SystemExit(f"aborting: exceeded {args.max_minutes} min")
                fb, opt = model.train_step(data[i : i + args.batch], lr=args.lr, loss_fn="cross_entropy", grad_clip_norm=1.0)
                loss = fb.metrics.get("loss_mean")
                losses.append({"epoch": epoch, "step": model.step, "loss_mean": loss, "grad_norm": opt.metrics.get("grad_norm")})
                print(f"epoch {epoch} step {model.step} loss={loss} t={time.perf_counter() - t0:.0f}s")
        ckpt = model.save_weights(args.name, mode="inference")
    elapsed = time.perf_counter() - t0
    result = {
        "base_model": args.base_model,
        "checkpoint": ckpt.path,
        "examples": len(data),
        "epochs": args.epochs,
        "batch": args.batch,
        "lr": args.lr,
        "rank": args.rank,
        "session_seconds": round(elapsed, 1),
        "losses": losses,
    }
    args.out.write_text(json.dumps(result, indent=2) + "\n")
    print(f"checkpoint: {ckpt.path}  ({elapsed:.0f}s session time) -> {args.out}")


if __name__ == "__main__":
    main()
