"""River fine-tune job: aggregate -> LoRA SFT -> holdout eval -> gate -> promote.

`run_job` is the whole lifecycle the proxy's POST /v1/train spawns: it turns an
extension export bundle into SFT records (evals/river/aggregate.py), trains a
LoRA on River, scores the base model and the new checkpoint on the holdout set
with the same metrics as evals/run_quality.py, and promotes the checkpoint into
the shared JobStore only if `gate` says it did not regress. Job records live in
the store so the proxy can serve the active checkpoint and list history without
a redeploy.

The pieces are reusable on their own: `run_sft` is also the body of
evals/river/sft.py's CLI, and `evaluate_checkpoint` is a Gate A run against a
River checkpoint without going through the HTTP proxy.
"""

from __future__ import annotations

import os
import random
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Protocol

from prompt import build_messages, probability_from_choice
from proxy import DEFAULT_MODEL, model_version_for, river_chat_sync

EVALS_DIR = Path(os.environ.get("AF_EVALS_DIR") or Path(__file__).resolve().parents[2] / "evals")
sys.path.insert(0, str(EVALS_DIR))
sys.path.insert(0, str(EVALS_DIR / "river"))

from aggregate import aggregate  # noqa: E402

from common import ALL_RULES, RULES, TASK_INSTRUCTION, Record, evaluate, summarize  # noqa: E402

STATUSES = ("queued", "training", "evaluating", "promoted", "rejected", "failed")


class TrainBudgetExceeded(RuntimeError):
    """Raised when a run exceeds TrainConfig.max_minutes of session time."""


@dataclass
class TrainConfig:
    base_model: str = DEFAULT_MODEL
    epochs: int = 3
    batch: int = 30
    lr: float = 1e-4
    rank: int = 16
    max_minutes: float = 15.0
    seed: int = 0


def render(records: list[dict], base_model: str) -> list[dict]:
    """format.py records -> River training examples, trained on the last
    assistant turn only so the fine-tune moves the same first answer token the
    proxy reads P(yes) from (thinking off, matching proxy.CHAT_KWARGS)."""
    import river_client
    from river_client.renderers import TrainOnWhat, get_renderer

    tok = river_client.load_tokenizer(base_model=base_model)
    renderer = get_renderer(base_model, thinking=False, tokenizer=tok)
    out = []
    for r in records:
        msgs = [*r["messages"], {"role": "assistant", "content": r["completion"]}]
        out.append(renderer.build_training_example(msgs, train_on=TrainOnWhat.LAST_ASSISTANT).to_dict())
    return out


def run_sft(client, records: list[dict], name: str, cfg: TrainConfig, log=print) -> dict:
    """LoRA SFT on River; returns the checkpoint path and run metadata."""
    import river_client

    data = render(records, cfg.base_model)
    log(f"{len(data)} examples, {sum(len(d['weights']) for d in data)} tokens")
    rng = random.Random(cfg.seed)
    t0 = time.perf_counter()
    losses: list[dict] = []
    with client.session(project="attention-filter", run=name) as session:
        log(f"session ready in {time.perf_counter() - t0:.1f}s")
        model = session.create_model(base_model=cfg.base_model, lora=river_client.LoraConfig(rank=cfg.rank, seed=cfg.seed))
        log(f"model ready in {time.perf_counter() - t0:.1f}s")
        for epoch in range(cfg.epochs):
            rng.shuffle(data)
            for i in range(0, len(data), cfg.batch):
                if (time.perf_counter() - t0) / 60 > cfg.max_minutes:
                    raise TrainBudgetExceeded(f"exceeded {cfg.max_minutes} min")
                fb, opt = model.train_step(data[i : i + cfg.batch], lr=cfg.lr, loss_fn="cross_entropy", grad_clip_norm=1.0)
                loss = fb.metrics.get("loss_mean")
                losses.append({"epoch": epoch, "step": model.step, "loss_mean": loss, "grad_norm": opt.metrics.get("grad_norm")})
                log(f"epoch {epoch} step {model.step} loss={loss} t={time.perf_counter() - t0:.0f}s")
        ckpt = model.save_weights(name, mode="inference")
    return {
        "base_model": cfg.base_model,
        "checkpoint": ckpt.path,
        "examples": len(data),
        "epochs": cfg.epochs,
        "batch": cfg.batch,
        "lr": cfg.lr,
        "rank": cfg.rank,
        "session_seconds": round(time.perf_counter() - t0, 1),
        "losses": losses,
    }


def evaluate_checkpoint(client, base_model: str, checkpoint: str | None, holdout: list[Record], workers: int = 16) -> dict:
    """Gate A metrics for one model: every (post, rule) pair in parallel, then
    the policy evaluator and run_quality's summary over the resulting rows."""
    jobs = [(rec, rid) for rec in holdout for rid in ALL_RULES]

    def one(job: tuple[Record, str]) -> float:
        rec, rid = job
        messages = build_messages(TASK_INSTRUCTION, RULES[rid], rec.text, rec.quote_text)
        return probability_from_choice(river_chat_sync(client, base_model, checkpoint, messages)["choices"][0])

    with ThreadPoolExecutor(max_workers=workers) as pool:
        answers = list(pool.map(one, jobs))

    rows = []
    for i, rec in enumerate(holdout):
        probs = {rid: answers[i * len(ALL_RULES) + j] for j, rid in enumerate(ALL_RULES)}
        rows.append(
            {
                "id": rec.id,
                "topic": rec.topic,
                "expected": rec.expected,
                "expected_disposition": rec.expected_disposition,
                "probabilities": probs,
                "disposition": evaluate(probs),
            }
        )
    return {**summarize(rows), "checkpoint": checkpoint, "rows": rows}


GATE_METRICS = (
    ("disposition_agreement", lambda m: m.get("disposition_agreement")),
    ("hide_precision", lambda m: (m.get("hide") or {}).get("precision")),
    ("disagreement_retention", lambda m: (m.get("disagreement_retention") or {}).get("value")),
)


def gate(base: dict, tuned: dict) -> tuple[bool, str]:
    """A checkpoint is promotable only if it does not regress the base model on
    disposition agreement, hide precision, or disagreement retention."""
    for label, get in GATE_METRICS:
        b, t = get(base), get(tuned)
        if b is None or t is None:
            continue
        if t < b:
            return False, f"{label} regressed: {t:.2f} < {b:.2f} (base)"
    return True, "tuned metrics met or exceeded base"


class JobStore(Protocol):
    def get(self, job_id: str) -> dict | None: ...

    def put(self, job_id: str, job: dict) -> None: ...

    def list_ids(self) -> list[str]: ...

    def active(self) -> dict | None: ...

    def set_active(self, active: dict | None) -> None: ...


class MemoryStore:
    """In-process JobStore (tests, local runs)."""

    def __init__(self) -> None:
        self._jobs: dict[str, dict] = {}
        self._ids: list[str] = []
        self._active: dict | None = None

    def get(self, job_id: str) -> dict | None:
        return self._jobs.get(job_id)

    def put(self, job_id: str, job: dict) -> None:
        if job_id not in self._jobs:
            self._ids.append(job_id)
        self._jobs[job_id] = job

    def list_ids(self) -> list[str]:
        return list(self._ids)

    def active(self) -> dict | None:
        return self._active

    def set_active(self, active: dict | None) -> None:
        self._active = active


class ModalDictStore:
    """JobStore over a modal.Dict (`job:<id>` records, `jobs` id list, `active`
    checkpoint descriptor), so the training container and every proxy container
    see the same state. Duck-typed on get/put — no modal import here."""

    def __init__(self, d) -> None:
        self.d = d

    def get(self, job_id: str) -> dict | None:
        return self.d.get(f"job:{job_id}")

    def put(self, job_id: str, job: dict) -> None:
        self.d.put(f"job:{job_id}", job)
        ids = self.d.get("jobs") or []
        if job_id not in ids:
            self.d.put("jobs", [*ids, job_id])

    def list_ids(self) -> list[str]:
        return list(self.d.get("jobs") or [])

    def active(self) -> dict | None:
        return self.d.get("active")

    def set_active(self, active: dict | None) -> None:
        self.d.put("active", active)


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def new_job(job_id: str, dataset: dict, cfg: TrainConfig) -> dict:
    return {
        "id": job_id,
        "status": "queued",
        "created_at": now(),
        "updated_at": now(),
        "name": f"af-{job_id}",
        "dataset": dataset,
        "config": asdict(cfg),
        "train": None,
        "eval": None,
        "gate": None,
        "checkpoint": None,
        "error": None,
    }


def run_job(
    client,
    job_id: str,
    bundle: dict,
    store: JobStore,
    cfg: TrainConfig,
    holdout: list[Record],
    seed: list[Record] | None = None,
    min_labels: int = 20,
    log=print,
) -> dict:
    """Train, evaluate and (if the gate passes) promote. Persists the job record
    after every transition so the extension can poll GET /v1/train/{id}."""
    records, dataset = aggregate(bundle, seed)
    job = store.get(job_id) or new_job(job_id, dataset, cfg)
    job["dataset"] = dataset

    def save(status: str, **fields) -> None:
        job.update(status=status, updated_at=now(), **fields)
        store.put(job_id, job)

    try:
        if dataset["user_labels"] < min_labels:
            raise ValueError(f"need at least {min_labels} labels, have {dataset['user_labels']}")
        save("training")
        train = run_sft(client, records, job["name"], cfg, log=log)
        save("evaluating", train=train, checkpoint=train["checkpoint"])

        base = evaluate_checkpoint(client, cfg.base_model, None, holdout)
        tuned = evaluate_checkpoint(client, cfg.base_model, train["checkpoint"], holdout)
        passed, reason = gate(base, tuned)
        log(f"gate {'passed' if passed else 'failed'}: {reason}")

        if passed:
            store.set_active(
                {
                    "checkpoint": train["checkpoint"],
                    "job_id": job_id,
                    "promoted_at": now(),
                    "model_version": model_version_for(cfg.base_model, train["checkpoint"]),
                    "eval": {k: v for k, v in tuned.items() if k != "rows"},
                }
            )
        save(
            "promoted" if passed else "rejected",
            eval={"base": base, "tuned": tuned},
            gate={"passed": passed, "reason": reason},
        )
    except Exception as e:
        log(f"job failed: {type(e).__name__}: {e}")
        save("failed", error=f"{type(e).__name__}: {e}")
    return job
