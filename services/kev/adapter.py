"""Extension <-> Kev System One adapter.

The extension (extension/src/background/classifier.ts) posts

    {"state": {"post_text", "quoted_text"?, "link_text"?},
     "questions": {<ruleId>: {"type": "noul", "instructions": {"task", "rule"}}}}

and reads `answers[<ruleId>].probability`. Kev's native /v1/systemone accepts the
same request (state and instructions may be JSON objects; kev.api.render flattens
them to "key: value" lines) but answers `{"type": "noul", "noul": p}`. This
module owns the mapping and the FastAPI front so it can be tested with a fake
model and reused unchanged inside the Modal container (deploy.py).
"""

from __future__ import annotations

import hmac
from collections.abc import Awaitable, Callable
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

STATE_FIELDS = ("post_text", "quoted_text", "link_text")


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
    model: str = "kev-latest"


def to_kev_request(body: SystemOneBody) -> dict:
    """Extension body -> kev.api.SystemOneRequest payload. Empty optional fields are
    dropped so the model never sees a bare `quoted_text:` label."""
    state = {k: v for k in STATE_FIELDS if (v := getattr(body.state, k))}
    questions = {rid: {"type": "noul", "instructions": q.instructions.model_dump()} for rid, q in body.questions.items()}
    return {"state": state, "model": body.model, "questions": questions}


def from_kev_response(kev: dict, model_version: str) -> dict:
    """Kev native response -> extension response. Keeps Kev's `noul` alongside
    `probability` so TypeSafe clients keep working against the same route."""
    answers = {}
    for rid, a in kev["answers"].items():
        if a.get("type") != "noul" or "noul" not in a:
            raise ValueError(f"unexpected Kev answer for {rid!r}: {a!r}")
        p = float(a["noul"])
        answers[rid] = {"type": "noul", "noul": p, "probability": p}
    out = {"model_version": model_version, "answers": answers}
    if "latency_ms" in kev:
        out["latency_ms"] = kev["latency_ms"]
    if "usage" in kev:
        out["usage"] = kev["usage"]
    return out


AnswerFn = Callable[[dict], Awaitable[dict]]


def make_app(answer: AnswerFn, model_version: str, token: str | None) -> FastAPI:
    """`answer` takes a kev.api.SystemOneRequest-shaped dict and returns Kev's
    native response body. `token` enables bearer auth on /v1/*; /health is open.
    CORS is wide open (any origin, incl. chrome-extension://) since the bearer
    token is the access control; the extension's service worker fetch is subject
    to CORS until the user grants the optional host permission."""
    app = FastAPI(title="attention-filter-kev")
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
        kev = await answer(to_kev_request(body))
        return JSONResponse(from_kev_response(kev, model_version))

    return app
