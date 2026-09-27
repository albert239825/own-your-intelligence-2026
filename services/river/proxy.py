"""Extension <-> River System One proxy.

Same wire contract as services/kev/adapter.py: the extension posts

    {"state": {"post_text", "quoted_text"?, "link_text"?},
     "questions": {<ruleId>: {"type": "noul", "instructions": {"task", "rule"}}}}

and reads `answers[<ruleId>].probability`. Each (rule, post) becomes one
River chat_complete call built with prompt.build_messages; P(yes) is read from
the first token's logprobs via prompt.probability_from_choice. Calls fan out
concurrently (rules are independent; ~1.6s p50 each).
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import secrets
import time
from collections.abc import Awaitable, Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Literal

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from prompt import build_messages, probability_from_choice

log = logging.getLogger("river-proxy")

DEFAULT_MODEL = "Qwen/Qwen3.5-9B"
CHAT_KWARGS = {
    "max_tokens": 4,
    "temperature": 0.0,
    "logprobs": True,
    "top_logprobs": 5,
    "chat_template_kwargs": {"enable_thinking": False},
}


class PostState(BaseModel):
    post_text: str
    quoted_text: str | None = None
    link_text: str | None = None


class RuleInstructions(BaseModel):
    task: str
    rule: str


class NoulQuestion(BaseModel):
    type: Literal["noul"]
    instructions: RuleInstructions


class SystemOneBody(BaseModel):
    state: PostState
    questions: dict[str, NoulQuestion] = Field(min_length=1)


ChatFn = Callable[[list[dict]], Awaitable[dict]]
"""messages -> parsed OpenAI chat.completion body; raises on failure."""


@dataclass
class Training:
    """Enables /v1/train* and serving whatever checkpoint the store says is
    active. `launch(job_id, bundle)` starts the job out of band (a Modal spawn);
    `chat_for(checkpoint)` builds the ChatFn for a checkpoint (None = base
    model). The active checkpoint is re-read from the store every `cache_ttl_s`
    so a promotion reaches every container without a redeploy."""

    store: Any
    launch: Callable[[str, dict], Any]
    base_model: str
    chat_for: Callable[[str | None], ChatFn] | None = None  # filled in by app_from_env
    min_labels: int = 20
    seed: list | None = None
    cache_ttl_s: float = 5.0
    _cache: dict = field(default_factory=lambda: {"at": 0.0, "active": None})

    def active(self, fresh: bool = False) -> dict | None:
        now = time.monotonic()
        if fresh or now - self._cache["at"] > self.cache_ttl_s:
            self._cache = {"at": now, "active": self.store.active()}
        return self._cache["active"]

    def invalidate(self) -> None:
        self._cache = {"at": 0.0, "active": None}

    def jobs(self) -> list[dict]:
        got = (self.store.get(jid) for jid in self.store.list_ids())
        return sorted((j for j in got if j), key=lambda j: j.get("created_at") or "", reverse=True)


def _without_rows(job: dict) -> dict:
    """List view: drop the per-post eval rows, keep the metrics."""
    ev = job.get("eval")
    if not ev:
        return job
    return {**job, "eval": {side: {k: v for k, v in (m or {}).items() if k != "rows"} for side, m in ev.items()}}


def make_app(chat: ChatFn, model_version: str, token: str | None, timeout_s: float = 20.0, training: Training | None = None) -> FastAPI:
    """`chat` answers one OpenAI-style chat (prompt.build_messages output) with
    the parsed completion body. `token` enables bearer auth on /v1/*; /health is
    open. CORS is wide open since the bearer token is the access control. With
    `training`, /v1/systemone serves the store's active checkpoint instead of
    `chat` and the /v1/train* job API is mounted."""
    app = FastAPI(title="attention-filter-river")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["POST", "GET"], allow_headers=["Authorization", "Content-Type"])

    async def require_bearer(request: Request) -> None:
        if token is None:
            return
        got = request.headers.get("authorization", "")
        if not hmac.compare_digest(got, f"Bearer {token}"):
            raise HTTPException(401, "missing or invalid bearer token")

    def current() -> tuple[ChatFn, str]:
        """(chat function, model_version) for the checkpoint in force right now."""
        if training is None:
            return chat, model_version
        active = training.active() or {}
        checkpoint = active.get("checkpoint")
        return training.chat_for(checkpoint), active.get("model_version") or model_version_for(training.base_model, checkpoint)

    def require_training() -> Training:
        if training is None:
            raise HTTPException(503, "training not configured")
        return training

    @app.get("/health")
    async def health() -> dict:
        return {"ok": True, "model_version": current()[1]}

    @app.post("/v1/systemone", dependencies=[Depends(require_bearer)])
    async def systemone(body: SystemOneBody) -> JSONResponse:
        chat_fn, version = current()
        items = list(body.questions.items())
        messages = [
            build_messages(q.instructions.task, q.instructions.rule, body.state.post_text, body.state.quoted_text, body.state.link_text)
            for _, q in items
        ]
        started = time.perf_counter()
        try:
            responses = await asyncio.wait_for(asyncio.gather(*(chat_fn(m) for m in messages)), timeout_s)
        except (TimeoutError, asyncio.TimeoutError):
            log.warning("upstream timeout after %ss (%d rules)", timeout_s, len(items))
            raise HTTPException(502, f"river upstream timeout after {timeout_s}s") from None
        except Exception as e:
            log.warning("upstream error: %s: %s", type(e).__name__, e)
            raise HTTPException(502, f"river upstream error: {type(e).__name__}: {e}") from None
        latency_ms = (time.perf_counter() - started) * 1000
        answers = {}
        prompt_tokens = completion_tokens = 0
        for (rid, _), resp in zip(items, responses, strict=True):
            p = probability_from_choice(resp["choices"][0])
            answers[rid] = {"type": "noul", "noul": p, "probability": p}
            usage = resp.get("usage") or {}
            prompt_tokens += int(usage.get("prompt_tokens") or 0)
            completion_tokens += int(usage.get("completion_tokens") or 0)
        out = {"model_version": version, "answers": answers, "latency_ms": latency_ms}
        if prompt_tokens or completion_tokens:
            out["usage"] = {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens}
        return JSONResponse(out)

    @app.get("/v1/model", dependencies=[Depends(require_bearer)])
    async def model_state() -> dict:
        t = require_training()
        return {"model_version": current()[1], "base_model": t.base_model, "active": t.active(fresh=True)}

    @app.post("/v1/train", dependencies=[Depends(require_bearer)])
    async def train_start(bundle: dict) -> JSONResponse:
        """Body is the extension's ExportBundle; the SFT dataset is built here
        (plus the bundled seed posts) so the extension never sees records."""
        t = require_training()
        from train import aggregate, new_job

        _, dataset = aggregate(bundle, t.seed)
        if dataset["user_labels"] < t.min_labels:
            detail = f"need at least {t.min_labels} labels, have {dataset['user_labels']}"
            return JSONResponse({"detail": detail, "stats": dataset}, status_code=400)
        running = [j for j in t.jobs() if j.get("status") in ("queued", "training", "evaluating")]
        if running:
            raise HTTPException(409, f"job {running[0]['id']} is already running")

        job_id = f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{secrets.token_hex(2)}"
        t.store.put(job_id, new_job(job_id, dataset, None))
        t.launch(job_id, bundle)
        log.info("train job %s queued (%d user labels)", job_id, dataset["user_labels"])
        return JSONResponse({"job_id": job_id, "dataset": dataset}, status_code=202)

    @app.get("/v1/train", dependencies=[Depends(require_bearer)])
    async def train_list() -> dict:
        return {"jobs": [_without_rows(j) for j in require_training().jobs()]}

    @app.get("/v1/train/{job_id}", dependencies=[Depends(require_bearer)])
    async def train_get(job_id: str) -> dict:
        job = require_training().store.get(job_id)
        if not job:
            raise HTTPException(404, f"no job {job_id}")
        return job

    @app.post("/v1/train/{job_id}/promote", dependencies=[Depends(require_bearer)])
    async def train_promote(job_id: str) -> dict:
        """Manual promote or rollback; a passing job promotes itself."""
        t = require_training()
        job = t.store.get(job_id)
        if not job:
            raise HTTPException(404, f"no job {job_id}")
        if not job.get("checkpoint"):
            raise HTTPException(409, f"job {job_id} has no checkpoint")
        t.store.set_active(
            {
                "checkpoint": job["checkpoint"],
                "job_id": job_id,
                "promoted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "model_version": model_version_for(t.base_model, job["checkpoint"]),
            }
        )
        t.invalidate()
        return await model_state()

    @app.post("/v1/model/reset", dependencies=[Depends(require_bearer)])
    async def model_reset() -> dict:
        t = require_training()
        t.store.set_active(None)
        t.invalidate()
        return await model_state()

    return app


def make_river_chat(client, base_model: str, checkpoint: str | None = None, timeout_s: float = 20.0, max_inflight: int = 256) -> ChatFn:
    """Wraps river_client.Client (synchronous gRPC) in an async ChatFn. With
    `checkpoint` (river://...) uses chat_complete_from_checkpoint to serve a
    fine-tuned LoRA; otherwise chat_complete against `base_model`. Blocking
    calls run on a dedicated pool of `max_inflight` threads (one per in-flight
    rule) rather than asyncio's small default executor."""
    pool = ThreadPoolExecutor(max_workers=max_inflight, thread_name_prefix="river")

    def call(messages: list[dict]) -> dict:
        return river_chat_sync(client, base_model, checkpoint, messages, timeout_s)

    async def chat(messages: list[dict]) -> dict:
        return await asyncio.get_running_loop().run_in_executor(pool, call, messages)

    return chat


def river_chat_sync(client, base_model: str, checkpoint: str | None, messages: list[dict], timeout_s: float = 20.0) -> dict:
    """One blocking River chat completion in the proxy's answer shape (CHAT_KWARGS,
    LoRA checkpoint when given). Shared with the offline eval in train.py."""
    kwargs = dict(CHAT_KWARGS, base_model=base_model, timeout=timeout_s)
    if checkpoint:
        result = client.chat_complete_from_checkpoint(messages, checkpoint_path=checkpoint, **kwargs)
    else:
        result = client.chat_complete(messages, **kwargs)
    if result.status_code != 200:
        raise RuntimeError(f"river status {result.status_code}")
    return json.loads(result.response_json)


def model_version_for(base_model: str, checkpoint: str | None) -> str:
    if checkpoint:
        return f"river:{base_model}@{checkpoint.rstrip('/').rsplit('/', 1)[-1]}"
    return f"river:{base_model}"


def app_from_env(training: Training | None = None) -> FastAPI:
    """RIVER_API_KEY (required), RIVER_MODEL (default DEFAULT_MODEL),
    RIVER_CHECKPOINT (optional river:// LoRA fallback when nothing is promoted),
    KEV_TOKEN (optional bearer; unset -> no auth), RIVER_TIMEOUT_S (default 20).
    `training` (deploy.py) mounts the job API; without it the proxy only serves
    RIVER_CHECKPOINT and /v1/train* answers 503."""
    import river_client

    api_key = os.environ.get("RIVER_API_KEY")
    if not api_key:
        raise RuntimeError("RIVER_API_KEY is required")
    base_model = os.environ.get("RIVER_MODEL", DEFAULT_MODEL)
    checkpoint = os.environ.get("RIVER_CHECKPOINT") or None
    token = os.environ.get("KEV_TOKEN") or None
    if token is None:
        log.warning("KEV_TOKEN unset: /v1/* endpoints are unauthenticated")
    timeout_s = float(os.environ.get("RIVER_TIMEOUT_S", "20"))
    client = river_client.Client(api_key=api_key)
    chat = make_river_chat(client, base_model, checkpoint, timeout_s)
    if training is not None and training.chat_for is None:
        chats: dict[str | None, ChatFn] = {checkpoint: chat}
        training.chat_for = lambda ck: chats.setdefault(ck, make_river_chat(client, base_model, ck or checkpoint, timeout_s))
    return make_app(chat, model_version_for(base_model, checkpoint), token, timeout_s, training)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app_from_env(), host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
