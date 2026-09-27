import json
import sys
from contextlib import contextmanager
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "evals"))

import train as T  # noqa: E402

from common import ALL_RULES, RULES, Record  # noqa: E402

HIDE = {"rage_bait": 1, "hype": 0, "engagement_farming": 0, "substantive_critique": 0}
SHOW = {"rage_bait": 0, "hype": 0, "engagement_farming": 0, "substantive_critique": 1}
HOLDOUT = [
    Record(id="h1", text="rage post", quote_text=None, expected=HIDE, expected_disposition="hide"),
    Record(id="h2", text="critique post", quote_text=None, expected=SHOW, expected_disposition="show"),
]


class FakeModel:
    def __init__(self) -> None:
        self.step = 0
        self.batches: list[int] = []

    def train_step(self, batch, **kwargs):
        self.step += 1
        self.batches.append(len(batch))
        metrics = type("M", (), {"metrics": {"loss_mean": 0.5, "grad_norm": 1.0}})
        return metrics(), metrics()

    def save_weights(self, name, mode):
        return type("C", (), {"path": f"river://fake/sampler_weights/{name}"})()


class FakeClient:
    """Stands in for river_client.Client: a training session plus chat
    completions that answer "yes" only for the (post substring, rule) pairs
    configured for that checkpoint (`"base"` for the un-tuned model)."""

    def __init__(self, yes: dict[str, set[tuple[str, str]]] | None = None) -> None:
        self.model = FakeModel()
        self.runs: list[str] = []
        self.chat_calls: list[str | None] = []
        self.yes = yes or {}

    @contextmanager
    def session(self, project, run):
        self.runs.append(run)
        yield type("S", (), {"create_model": lambda _self, **kw: self.model})()

    def _answer(self, messages, checkpoint):
        self.chat_calls.append(checkpoint)
        content = messages[1]["content"]
        rule = next((rid for rid in ALL_RULES if RULES[rid] in content), "?")
        pairs = self.yes.get(checkpoint or "base", set())
        word = "yes" if any(sub in content and rid == rule for sub, rid in pairs) else "no"
        body = {"choices": [{"message": {"content": word}}]}
        return type("R", (), {"status_code": 200, "response_json": json.dumps(body)})()

    def chat_complete(self, messages, **kwargs):
        return self._answer(messages, None)

    def chat_complete_from_checkpoint(self, messages, checkpoint_path, **kwargs):
        return self._answer(messages, checkpoint_path)


@pytest.fixture(autouse=True)
def no_tokenizer(monkeypatch):
    monkeypatch.setattr(T, "render", lambda records, base_model: [{"weights": [1], "rec": r} for r in records])
    monkeypatch.setitem(sys.modules, "river_client", type("RC", (), {"LoraConfig": lambda **kw: kw}))


def test_run_sft_result_and_batching() -> None:
    client = FakeClient()
    cfg = T.TrainConfig(epochs=2, batch=3)
    result = T.run_sft(client, [{"messages": [], "completion": "yes"}] * 7, "af-x", cfg, log=lambda *a: None)
    assert result["checkpoint"] == "river://fake/sampler_weights/af-x"
    assert result["examples"] == 7
    assert client.model.batches == [3, 3, 1, 3, 3, 1]  # 2 epochs x ceil(7/3)
    assert len(result["losses"]) == 6
    assert result["base_model"] == T.DEFAULT_MODEL and result["epochs"] == 2


def test_run_sft_budget_raises_typed_error() -> None:
    cfg = T.TrainConfig(max_minutes=-1.0)
    with pytest.raises(T.TrainBudgetExceeded):
        T.run_sft(FakeClient(), [{"messages": [], "completion": "yes"}], "af-x", cfg, log=lambda *a: None)


def test_evaluate_checkpoint_scores_every_rule() -> None:
    client = FakeClient(yes={"river://ck": {("rage post", "rage_bait")}})
    out = T.evaluate_checkpoint(client, T.DEFAULT_MODEL, "river://ck", HOLDOUT, workers=2)
    assert len(client.chat_calls) == len(HOLDOUT) * len(ALL_RULES)
    assert set(client.chat_calls) == {"river://ck"}
    assert out["n"] == 2
    assert out["checkpoint"] == "river://ck"
    assert [r["disposition"] for r in out["rows"]] == ["hide", "show"]
    assert out["disposition_agreement"] == 1.0


def test_gate_requires_no_regression() -> None:
    base = {"disposition_agreement": 0.8, "hide": {"precision": 1.0}, "disagreement_retention": {"value": 1.0}}
    better = {"disposition_agreement": 0.9, "hide": {"precision": 1.0}, "disagreement_retention": {"value": 1.0}}
    assert T.gate(base, better)[0] is True
    worse = {**better, "hide": {"precision": 0.5}}
    passed, reason = T.gate(base, worse)
    assert passed is False
    assert "hide_precision" in reason and "0.50" in reason and "1.00" in reason


def bundle(n: int = 12) -> dict:
    return {
        "policy": {"rules": [{"id": "rage_bait", "instruction": "rage rule?"}]},
        "feedback": [
            {
                "feedbackId": f"f{i}",
                "postId": f"p{i}",
                "ruleId": "rage_bait",
                "kind": "confirm_hide",
                "desiredAction": "hide",
                "text": f"post {i}",
                "createdAt": 1730000000000 + i,
            }
            for i in range(n)
        ],
        "overrides": {},
        "history": [],
    }


def test_run_job_promotes_when_gate_passes(monkeypatch) -> None:
    # tuned answers "yes" on the rage post -> matches expectations; base never does
    client = FakeClient(yes={"river://fake/sampler_weights/af-j1": {("rage post", "rage_bait")}})
    store = T.MemoryStore()
    seen: list[str] = []
    monkeypatch.setattr(T, "aggregate", lambda b, s: ([{"messages": [], "completion": "yes"}] * 4, {"user_labels": 12, "seed_labels": 0}))

    def log(msg):
        seen.append(str(msg))

    job = T.run_job(client, "j1", bundle(), store, T.TrainConfig(epochs=1), HOLDOUT, seed=[], min_labels=10, log=log)
    assert job["status"] == "promoted"
    assert job["gate"]["passed"] is True
    assert job["checkpoint"] == "river://fake/sampler_weights/af-j1"
    assert job["eval"]["base"]["disposition_agreement"] < job["eval"]["tuned"]["disposition_agreement"]
    assert store.get("j1")["status"] == "promoted"
    assert store.list_ids() == ["j1"]
    active = store.active()
    assert active["checkpoint"] == job["checkpoint"] and active["job_id"] == "j1"
    assert active["model_version"].endswith("@af-j1")
    assert client.runs == ["af-j1"]


def test_run_job_rejects_regression_without_promoting(monkeypatch) -> None:
    # base is right on the rage post, tuned is not -> regression
    client = FakeClient(yes={"base": {("rage post", "rage_bait")}})
    store = T.MemoryStore()
    monkeypatch.setattr(T, "aggregate", lambda b, s: ([{"messages": [], "completion": "yes"}] * 4, {"user_labels": 12, "seed_labels": 0}))
    job = T.run_job(client, "j2", bundle(), store, T.TrainConfig(epochs=1), HOLDOUT, seed=[], min_labels=10, log=lambda *a: None)
    assert job["status"] == "rejected"
    assert job["gate"]["passed"] is False
    assert job["checkpoint"]  # checkpoint kept for a manual promote
    assert store.active() is None


def test_run_job_records_failure(monkeypatch) -> None:
    store = T.MemoryStore()
    monkeypatch.setattr(T, "aggregate", lambda b, s: ([{"messages": [], "completion": "yes"}], {"user_labels": 12, "seed_labels": 0}))
    monkeypatch.setattr(T, "run_sft", lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("river down")))
    job = T.run_job(FakeClient(), "j3", bundle(), store, T.TrainConfig(), HOLDOUT, seed=[], min_labels=10, log=lambda *a: None)
    assert job["status"] == "failed"
    assert job["error"] == "RuntimeError: river down"
    assert store.active() is None


def test_run_job_needs_min_labels(monkeypatch) -> None:
    store = T.MemoryStore()
    monkeypatch.setattr(T, "aggregate", lambda b, s: ([], {"user_labels": 3, "seed_labels": 0}))
    job = T.run_job(FakeClient(), "j4", bundle(3), store, T.TrainConfig(), HOLDOUT, seed=[], min_labels=10, log=lambda *a: None)
    assert job["status"] == "failed"
    assert "at least 10" in job["error"]


class FakeDict:
    def __init__(self) -> None:
        self.d: dict = {}

    def get(self, k, default=None):
        return self.d.get(k, default)

    def put(self, k, v):
        self.d[k] = v


def test_modal_dict_store_roundtrip() -> None:
    store = T.ModalDictStore(FakeDict())
    assert store.get("a") is None and store.list_ids() == [] and store.active() is None
    store.put("a", {"id": "a", "status": "queued"})
    store.put("a", {"id": "a", "status": "training"})
    store.put("b", {"id": "b", "status": "queued"})
    assert store.list_ids() == ["a", "b"]
    assert store.get("a")["status"] == "training"
    store.set_active({"checkpoint": "river://x"})
    assert store.active()["checkpoint"] == "river://x"
    store.set_active(None)
    assert store.active() is None
