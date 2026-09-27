"""Modal app: River base/fine-tuned model behind the extension's /v1/systemone contract (see proxy.py),
plus the fine-tune job API (/v1/train*, see train.py).

    modal deploy deploy.py          # from services/river/; prints https://<workspace>--attention-filter-river-api.modal.run
    modal app stop attention-filter-river

    RIVER_MODEL=Qwen/Qwen3.5-9B RIVER_CHECKPOINT=river://... modal deploy deploy.py   # pin a fine-tuned LoRA

Secrets (create once in the Modal dashboard or with `modal secret create`):
    kev-auth      KEV_TOKEN=<random>     bearer token the extension sends
    river         RIVER_API_KEY=<key>    River AI API key

Job records and the active checkpoint live in the modal.Dict `attention-filter-river-jobs`,
so POST /v1/train/{id}/promote (or a job that passes its gate) swaps the served
checkpoint for every container within seconds — no redeploy. RIVER_MODEL /
RIVER_CHECKPOINT are read at deploy time and baked into the image env;
RIVER_CHECKPOINT is only the fallback for when nothing has been promoted.
"""

from __future__ import annotations

import os

import modal

APP_NAME = "attention-filter-river"
JOBS_DICT = f"{APP_NAME}-jobs"

app = modal.App(APP_NAME)

image = modal.Image.debian_slim(python_version="3.12").uv_pip_install(
    "river-client==0.11.0",
    "fastapi==0.141.1",
    "pydantic==2.13.5",
)
deploy_env = {k: os.environ[k] for k in ("RIVER_MODEL", "RIVER_CHECKPOINT") if os.environ.get(k)}
image = image.env({**deploy_env, "AF_EVALS_DIR": "/root/evals"})
image = image.add_local_dir(os.path.join(os.path.dirname(__file__), "..", "..", "evals"), "/root/evals")
image = image.add_local_python_source("proxy", "prompt", "train")

secrets = [modal.Secret.from_name("kev-auth"), modal.Secret.from_name("river")]


def jobs_dict():
    return modal.Dict.from_name(JOBS_DICT, create_if_missing=True)


@app.function(image=image, secrets=secrets, min_containers=0, timeout=45 * 60, cpu=2, memory=4096)
def train_job(job_id: str, bundle: dict) -> dict:
    """SFT + holdout eval + auto-promote for one submitted export bundle."""
    import river_client
    from train import ModalDictStore, TrainConfig, eval_posts, run_job

    client = river_client.Client(api_key=os.environ["RIVER_API_KEY"])
    cfg = TrainConfig(base_model=os.environ.get("RIVER_MODEL") or TrainConfig.base_model)
    return run_job(
        client,
        job_id,
        bundle,
        ModalDictStore(jobs_dict()),
        cfg,
        holdout=eval_posts("holdout"),
        seed=eval_posts("posts"),
    )


@app.function(
    image=image,
    secrets=secrets,
    min_containers=0,
    scaledown_window=120,
    timeout=120,
    cpu=1,
    memory=1024,
)
@modal.concurrent(max_inputs=64)
@modal.asgi_app(label=f"{APP_NAME}-api")
def web():
    from train import ModalDictStore, TrainConfig, eval_posts

    from proxy import Training, app_from_env

    training = Training(
        store=ModalDictStore(jobs_dict()),
        launch=lambda job_id, bundle: train_job.spawn(job_id, bundle),
        base_model=os.environ.get("RIVER_MODEL") or TrainConfig.base_model,
        seed=eval_posts("posts"),
    )
    return app_from_env(training)
