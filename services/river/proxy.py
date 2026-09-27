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
import time
from collections.abc import Awaitable, Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Literal

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


def make_app(chat: ChatFn, model_version: str, token: str | None, timeout_s: float = 20.0) -> FastAPI:
    """`chat` answers one OpenAI-style chat (prompt.build_messages output) with
    the parsed completion body. `token` enables bearer auth on /v1/*; /health is
    open. CORS is wide open since the bearer token is the access control."""
    app = FastAPI(title="attention-filter-river")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["POST", "GET"], allow_headers=["Authorization", "Content-Type"])

    async def require_bearer(request: Request) -> None:
        if token is None:
            return
        got = request.headers.get("authorization", "")
        if not hmac.compare_digest(got, f"Bearer {token}"):
            raise HTTPException(401, "missing or invalid bearer token")

    @app.get("/health")
    async def health() -> dict:
        return {"ok": True, "model_version": model_version}

    @app.post("/v1/systemone", dependencies=[Depends(require_bearer)])
    async def systemone(body: SystemOneBody) -> JSONResponse:
        items = list(body.questions.items())
        messages = [
            build_messages(q.instructions.task, q.instructions.rule, body.state.post_text, body.state.quoted_text, body.state.link_text)
            for _, q in items
        ]
        started = time.perf_counter()
        try:
            responses = await asyncio.wait_for(asyncio.gather(*(chat(m) for m in messages)), timeout_s)
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
        out = {"model_version": model_version, "answers": answers, "latency_ms": latency_ms}
        if prompt_tokens or completion_tokens:
            out["usage"] = {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens}
        return JSONResponse(out)

    return app


def make_river_chat(client, base_model: str, checkpoint: str | None = None, timeout_s: float = 20.0, max_inflight: int = 256) -> ChatFn:
    """Wraps river_client.Client (synchronous gRPC) in an async ChatFn. With
    `checkpoint` (river://...) uses chat_complete_from_checkpoint to serve a
    fine-tuned LoRA; otherwise chat_complete against `base_model`. Blocking
    calls run on a dedicated pool of `max_inflight` threads (one per in-flight
    rule) rather than asyncio's small default executor."""
    pool = ThreadPoolExecutor(max_workers=max_inflight, thread_name_prefix="river")

    def call(messages: list[dict]) -> dict:
        kwargs = dict(CHAT_KWARGS, base_model=base_model, timeout=timeout_s)
        if checkpoint:
            result = client.chat_complete_from_checkpoint(messages, checkpoint_path=checkpoint, **kwargs)
        else:
            result = client.chat_complete(messages, **kwargs)
        if result.status_code != 200:
            raise RuntimeError(f"river status {result.status_code}")
        return json.loads(result.response_json)

    async def chat(messages: list[dict]) -> dict:
        return await asyncio.get_running_loop().run_in_executor(pool, call, messages)

    return chat


def model_version_for(base_model: str, checkpoint: str | None) -> str:
    if checkpoint:
        return f"river:{base_model}@{checkpoint.rstrip('/').rsplit('/', 1)[-1]}"
    return f"river:{base_model}"


def app_from_env() -> FastAPI:
    """RIVER_API_KEY (required), RIVER_MODEL (default DEFAULT_MODEL),
    RIVER_CHECKPOINT (optional river:// LoRA), KEV_TOKEN (optional bearer;
    unset -> no auth), RIVER_TIMEOUT_S (default 20)."""
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
    return make_app(chat, model_version_for(base_model, checkpoint), token, timeout_s)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app_from_env(), host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
