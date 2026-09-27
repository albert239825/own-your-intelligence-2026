from pathlib import Path

from common import ALL_RULES, QUESTIONS, evaluate, load_jsonl, request_body

HERE = Path(__file__).parent


def test_evaluate_matches_evaluate_ts():
    assert evaluate({"rage_bait": 0.9, "hype": 0.1, "engagement_farming": 0.1, "substantive_critique": 0.1}) == "hide"
    assert evaluate({"rage_bait": 0.9, "hype": 0.1, "engagement_farming": 0.1, "substantive_critique": 0.75}) == "show"
    assert evaluate({"rage_bait": 0.9, "hype": 0.1, "engagement_farming": 0.1, "substantive_critique": 0.5}) == "uncertain"
    assert evaluate({"rage_bait": 0.1, "hype": 0.1, "engagement_farming": 0.95, "substantive_critique": 0.99}) == "hide"
    assert evaluate({"rage_bait": 0.69, "hype": 0.59, "engagement_farming": 0.49, "substantive_critique": 0.0}) == "show"


def test_datasets_are_consistent_with_policy():
    for name in ("posts.jsonl", "holdout.jsonl"):
        recs = load_jsonl(HERE / name)
        assert len({r.id for r in recs}) == len(recs)
        for r in recs:
            assert r.expected_disposition in ("show", "hide"), r.id
            ideal = {rid: float(r.expected[rid]) for rid in ALL_RULES}
            assert evaluate(ideal) == r.expected_disposition, r.id
    assert len(load_jsonl(HERE / "posts.jsonl")) == 30
    assert len(load_jsonl(HERE / "holdout.jsonl")) == 10


def test_request_body_shape():
    rec = load_jsonl(HERE / "posts.jsonl")[-1]
    body = request_body(rec)
    assert body["state"]["quoted_text"] == rec.quote_text
    assert set(body["questions"]) == set(ALL_RULES)
    assert body["questions"] is QUESTIONS
    for q in body["questions"].values():
        assert q["type"] == "noul" and set(q["instructions"]) == {"task", "rule"}
