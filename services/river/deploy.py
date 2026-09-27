"""Modal app: River base/fine-tuned model behind the extension's /v1/systemone contract (see proxy.py).

    modal deploy deploy.py          # from services/river/; prints https://<workspace>--attention-filter-river-api.modal.run
    modal app stop attention-filter-river

    RIVER_MODEL=Qwen/Qwen3.5-9B RIVER_CHECKPOINT=river://... modal deploy deploy.py   # serve a fine-tuned LoRA

Secrets (create once in the Modal dashboard or with `modal secret create`):
    kev-auth      KEV_TOKEN=<random>     bearer token the extension sends
    river         RIVER_API_KEY=<key>    River AI API key

RIVER_MODEL / RIVER_CHECKPOINT are read from the environment at deploy time and
baked into the image env (only when set); redeploy to change them.
"""

from __future__ import annotations

import os

import modal

APP_NAME = "attention-filter-river"

app = modal.App(APP_NAME)

image = modal.Image.debian_slim(python_version="3.12").uv_pip_install(
    "river-client==0.11.0",
    "fastapi==0.141.1",
    "pydantic==2.13.5",
)
deploy_env = {k: os.environ[k] for k in ("RIVER_MODEL", "RIVER_CHECKPOINT") if os.environ.get(k)}
if deploy_env:
    image = image.env(deploy_env)
image = image.add_local_python_source("proxy", "prompt")


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("kev-auth"), modal.Secret.from_name("river")],
    min_containers=0,
    scaledown_window=120,
    timeout=120,
    cpu=1,
    memory=1024,
)
@modal.concurrent(max_inputs=64)
@modal.asgi_app(label=f"{APP_NAME}-api")
def web():
    from proxy import app_from_env

    return app_from_env()
