"""Proxy-side job API (/v1/train*, /v1/model*) and checkpoint hot-swap."""

import math
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "evals"))

from test_proxy import BODY, fake_response, make_fake  # noqa: E402
from train import MemoryStore, new_job  # noqa: E402

from proxy import Training, make_app  # noqa: E402

AUTH = {"authorization": "Bearer secret"}
BASE = "Qwen/Qwen3.5-9B"
CKPT = "river://abc/sampler_weights/af-j1"


def bundle(n: int) -> dict:
    return {
        "policy": {"rules": [{"id": "rage_bait", "instruction": "Is this rage bait?"}]},
        "feedback": [
            {
                "feedbackId": f"f{i}",
                "postId": f"p{i}",
                "ruleId": "rage_bait",
                "kind": "confirm_hide",
                "desiredAction": "hide",
                "text": f"angry post {i}",
                "createdAt": 1730000000000 + i,
            }
            for i in range(n)
        ],
        "overrides": {},
        "history": [],
    }


@pytest.fixture
def app():
    store = MemoryStore()
    launched: list[tuple[str, dict]] = []
    used: list[str | None] = []

    def chat_for(checkpoint):
        used.append(checkpoint)
        yes = fake_response(math.log(0.9), math.log(0.1))
        return make_fake({"": yes} if checkpoint else None)

    training = Training(
        store=store,
        launch=lambda job_id, b: launched.append((job_id, b)),
        chat_for=chat_for,
        base_model=BASE,
        min_labels=5,
        seed=[],
        cache_ttl_s=0.0,
    )
    client = TestClient(make_app(make_fake(), f"river:{BASE}", "secret", training=training))
    return client, store, launched, used


def test_routes_require_bearer(app) -> None:
    c, *_ = app
    assert c.post("/v1/train", json=bundle(6)).status_code == 401
    assert c.get("/v1/train").status_code == 401
    assert c.get("/v1/model").status_code == 401


def test_rejects_too_few_labels(app) -> None:
    c, store, launched, _ = app
    r = c.post("/v1/train", json=bundle(2), headers=AUTH)
    assert r.status_code == 400
    body = r.json()
    assert "at least 5" in body["detail"]
    assert body["stats"]["user_labels"] == 2
    assert launched == [] and store.list_ids() == []


def test_accepts_and_launches(app) -> None:
    c, store, launched, _ = app
    r = c.post("/v1/train", json=bundle(6), headers=AUTH)
    assert r.status_code == 202
    job_id = r.json()["job_id"]
    assert r.json()["dataset"]["user_labels"] == 6
    assert r.json()["dataset"]["by_rule"] == {"rage_bait": {"yes": 6, "no": 0}}
    assert launched == [(job_id, bundle(6))]
    assert store.get(job_id)["status"] == "queued"


def test_one_job_at_a_time(app) -> None:
    c, *_ = app
    assert c.post("/v1/train", json=bundle(6), headers=AUTH).status_code == 202
    r = c.post("/v1/train", json=bundle(6), headers=AUTH)
    assert r.status_code == 409
    assert "already running" in r.json()["detail"]


def test_list_strips_rows_and_detail_keeps_them(app) -> None:
    c, store, *_ = app
    job = new_job("j1", {"user_labels": 6}, None)
    job["eval"] = {"base": {"n": 2, "rows": [{"id": "h1"}]}, "tuned": {"n": 2, "rows": [{"id": "h1"}]}}
    job["status"] = "promoted"
    store.put("j1", job)
    store.put("j0", {**new_job("j0", {}, None), "created_at": "2000-01-01T00:00:00Z"})

    listed = c.get("/v1/train", headers=AUTH).json()["jobs"]
    assert [j["id"] for j in listed] == ["j1", "j0"]  # newest first
    assert "rows" not in listed[0]["eval"]["base"] and listed[0]["eval"]["base"]["n"] == 2

    detail = c.get("/v1/train/j1", headers=AUTH).json()
    assert detail["eval"]["base"]["rows"] == [{"id": "h1"}]
    assert c.get("/v1/train/nope", headers=AUTH).status_code == 404


def test_promote_swaps_the_served_checkpoint(app) -> None:
    c, store, _, used = app
    assert c.get("/health").json()["model_version"] == f"river:{BASE}"
    store.put("j1", {**new_job("j1", {}, None), "status": "rejected", "checkpoint": CKPT})

    r = c.post("/v1/train/j1/promote", headers=AUTH)
    assert r.status_code == 200
    assert r.json()["model_version"] == f"river:{BASE}@af-j1"
    assert r.json()["active"]["job_id"] == "j1"
    assert c.get("/health").json()["model_version"] == f"river:{BASE}@af-j1"

    used.clear()
    answers = c.post("/v1/systemone", json=BODY, headers=AUTH).json()
    assert answers["model_version"] == f"river:{BASE}@af-j1"
    assert set(used) == {CKPT}  # the checkpoint's chat fn served the request
    assert answers["answers"]["rage_bait"]["probability"] == pytest.approx(0.9, abs=0.01)

    assert c.post("/v1/model/reset", headers=AUTH).json() == {
        "model_version": f"river:{BASE}",
        "base_model": BASE,
        "active": None,
    }
    assert c.get("/health").json()["model_version"] == f"river:{BASE}"


def test_promote_without_checkpoint_conflicts(app) -> None:
    c, store, *_ = app
    store.put("j2", new_job("j2", {}, None))
    r = c.post("/v1/train/j2/promote", headers=AUTH)
    assert r.status_code == 409
    assert "no checkpoint" in r.json()["detail"]
    assert c.post("/v1/train/nope/promote", headers=AUTH).status_code == 404


def test_training_routes_503_when_unconfigured() -> None:
    c = TestClient(make_app(make_fake(), "river:test", None))
    assert c.post("/v1/train", json=bundle(6)).status_code == 503
    assert c.get("/v1/train").status_code == 503
    assert c.get("/v1/train/x").status_code == 503
    assert c.post("/v1/train/x/promote").status_code == 503
    assert c.get("/v1/model").status_code == 503
    assert c.post("/v1/model/reset").status_code == 503
    assert c.get("/health").json()["model_version"] == "river:test"
