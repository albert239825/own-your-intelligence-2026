# River proxy — attention-filter on River AI

FastAPI proxy that serves the extension's `/v1/systemone` contract (same wire
shape as `services/kev/adapter.py`, minus the `model` field) backed by River's
shared `chat_complete` inference. Each (rule, post) becomes one chat call built
with `prompt.build_messages`; `P(yes)` is read from the first answer token's
top-5 logprobs. Rules fan out concurrently on a dedicated
`ThreadPoolExecutor(max_inflight=256)` (the asyncio default executor's ~32
threads timed out 26/60 requests at concurrency 30 — 120 in-flight calls > 32
threads).

## River account / catalog

gRPC endpoint `api.river.ai` via `river-client==0.11.0` (Python ≥3.12).
Console: https://console.river.ai/ · Docs: https://docs.river.ai/.

Models visible to this personal key (`client.get_capabilities()`, 2026-09-27):
`Qwen/Qwen3.8-27B-FP8`, `Qwen/Qwen3.6-35B-A3B-FP8`, `Qwen/Qwen3.5-397B-A17B-FP8`,
`Qwen/Qwen3.5-122B-A10B-FP8`, `Qwen/Qwen3.5-9B` (smallest; used here),
`nvidia/Kimi-K2.6-NVFP4`, `nvidia/Kimi-K2.6-NVFP4-262K`, `nvidia/GLM-5.2-NVFP4`,
`nvidia/GLM-5.2-NVFP4-262K`, `zai-org/GLM-5.3-Flash`,
`deepseek-ai/DeepSeek-V4-Flash-0731`, `deepseek-ai/DeepSeek-V4.1-Flash`,
`nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4`.

## How it works

- **Inference (base):** `client.chat_complete(messages, base_model=..., max_tokens=4,
  temperature=0.0, logprobs=True, top_logprobs=5,
  chat_template_kwargs={"enable_thinking": False})` → OpenAI chat.completion
  JSON incl. `choices[0].logprobs.content[0].top_logprobs`.
- **Inference (tuned):** `client.chat_complete_from_checkpoint(messages,
  checkpoint_path="river://...", base_model=..., ...)` — same shape, serves a
  fine-tuned LoRA.
- **Training:** `client.session()` → `session.create_model(base_model,
  lora=river_client.LoraConfig(rank))` → renderer
  `get_renderer(model, thinking=False).build_training_example(messages,
  train_on=LAST_ASSISTANT).to_dict()` → `model.train_step(data, lr,
  loss_fn="cross_entropy")` → `model.save_weights(name, mode="inference")` →
  `river://<session-id>/sampler_weights/<name>`.
- **Logprobs:** available, yes. The proxy computes
  `P(yes) = mass(yes-like)/(mass(yes)+mass(no))` over top-5 first-token
  logprobs (`prompt.probability_from_choice`); the 0.9/0.1 message-text
  fallback exists only if logprobs are missing (never observed live).
- Dedicated OpenAI-compatible deployments exist but are gated (team key
  required; personal keys can't create them — docs-only), so the proxy uses the
  shared `chat_complete` path.
- **Pricing (docs-only):** usage-based/per-token for inference plus GPU-session
  time for training; no public numeric price list found and the API does not
  expose the account balance. The whole session below (165 s training + ~250
  chat calls) is small but unquantified in dollars — check the Console usage
  page.

## Measured latency (2026-09-27, Qwen/Qwen3.5-9B direct via client)

20 calls, ~80 prompt tokens, `max_tokens=4`: **p50 1596 ms, p95 1799 ms**;
first call after idle 2709 ms; one cold call after several minutes idle was
7.5 s (observed once via the proxy). Per rule ≈80 prompt + 2 completion tokens
(`<think></think>` framing + "yes"/"no") → ≈330 prompt tokens per 4-rule post.

## Gate B — burst through the proxy (local uvicorn → River, 2 rounds, base model)

ms; `server` = proxy `latency_ms` = fan-out wall for 4 River calls; `rtt` =
client round trip (proxy on the same VM, so rtt≈server; not browser wall-clock).

| conc | reqs | errors | server p50 | server p95 | rtt p50 | rtt p95 | wall/burst |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2 | 0 | 1729 | 1743 | 1731 | 1744 | 1731 |
| 8 | 16 | 0 | 2138 | 2482 | 2141 | 2484 | 2358 |
| 30 | 60 | 0 | 3112 | 4499 | 3116 | 4500 | 4493 |

## SFT smoke test (evals/river/format.py → sft.py)

- Data: `format.py --eval ../posts.jsonl` → 120 records (30 posts × 4 rules;
  balance rage_bait 3/27, hype 6/24, engagement_farming 5/25,
  substantive_critique 10/20), 15,356 tokens; no duplication/paraphrase needed.
- LoRA rank 16, 3 epochs, batch 30, lr 1e-4, cross_entropy, grad_clip 1.0 →
  12 steps; loss_mean 0.309 → 0.058 → 0.013 → 0.002 (epoch 0) then ≤1e-3
  (the trained span is 6 tokens, 5 of which are fixed think/eos framing, so the
  floor is trivially low — expect over-confidence, below).
- Session time 165 s (model ready at 18 s).
- Checkpoint: `river://894286df-abe9-4b4e-ae95-1317d3b0398a/sampler_weights/af-v1`.

## Gate A — holdout.jsonl (n=10) via proxy, run_quality.py, DEFAULT_POLICY thresholds

per rule: thr / prec / rec / tp / fp / fn / min+ / max-

| rule | base Qwen3.5-9B | tuned af-v1 |
| --- | --- | --- |
| rage_bait | 0.85 / 1.00 / 1.00 / 1/0/0 / 0.86 / 0.19 | prec 1.00 rec 1.00, min+ ≥0.98, max- 0.00 |
| hype | 0.85 / 1.00 / 1.00 / 2/0/0 / 0.88 / 0.42 | same |
| engagement_farming | 0.90 / 1.00 / 0.50 / 1/0/1 / 0.89 / 0.19 | same |
| substantive_critique | 0.70 / 0.75 / 1.00 / 3/1/0 / 0.92 / 0.84 | same |

- **Base:** hide precision 1.00 (4/4), hide recall 0.80 (fn: h-farm-02 at 0.89
  vs 0.90 thr), disagreement retention 1.00 (3/3), disposition agreement 0.90
  (9/10). → `evals/results/quality-20260927T215944Z.json`
- **Tuned af-v1:** every rule prec/rec 1.00; hide precision 1.00 (5/5), recall
  1.00, retention 1.00, agreement 1.00 (10/10). →
  `evals/results/quality-20260927T220011Z.json`
- **Caveat:** n=10, holdout topics mirror the 30 dev posts, and the tuned
  model's probabilities are saturated (0.00/1.00). This is a smoke test that
  the SFT path works end-to-end and moves the decision token — not a quality
  claim.

## Kev vs River (Kev numbers from evals/README.md on devin/track-m; kev-4b, one L40S, Modal)

| | Kev (kev-4b, Modal L40S) | River base (Qwen3.5-9B, shared) | River tuned (af-v1 LoRA) |
| --- | --- | --- | --- |
| server latency p50 @ conc 1 / 8 / 30 | 20 / 127 / 332 ms | 1729 / 2138 / 3112 ms | not measured (same path; expect ≈ base) |
| errors @ conc 30 | 0/90 | 0/60 | — |
| holdout disposition agreement | 0.50 (never crosses 0.85/0.90 thr; ranks correctly) | 0.90 | 1.00 (n=10, saturated) |
| holdout disagreement retention | 1.00 | 1.00 | 1.00 |
| cost | ~$47/day one warm L40S (min_containers=1) or ~1-2 min cold start at 0 | per-token, ≈330 prompt tokens/post; no numeric public price (docs-only); proxy is a $0-idle Modal CPU container | + GPU session time for training (165 s here) |
| fine-tune path | none in this repo | — | evals/river/format.py → sft.py → `RIVER_CHECKPOINT` redeploy |
| extension change | none | none (same /v1/systemone contract) | none |

## Runbook

```bash
python3.12 -m venv ~/.venvs/river && source ~/.venvs/river/bin/activate
pip install -r requirements.txt

# local
KEV_TOKEN=... RIVER_API_KEY=... python proxy.py          # PORT default 8080

# deploy (kev-auth secret already exists from services/kev)
modal secret create river RIVER_API_KEY=...
RIVER_CHECKPOINT=river://... modal deploy deploy.py       # RIVER_MODEL optional
modal app stop attention-filter-river
```

`min_containers=0` → idle cost ≈0.

**Live deployment:** `https://albert23982--attention-filter-river-api.modal.run`
serving `river:Qwen/Qwen3.5-9B@af-v1` (health verified; authenticated calls need
the `KEV_TOKEN` from the `kev-auth` secret). Extension: options page → Kev
endpoint field = that URL, token = `KEV_TOKEN`; no extension change needed.

| env var | default | meaning |
| --- | --- | --- |
| `RIVER_API_KEY` | required | River AI API key |
| `RIVER_MODEL` | `Qwen/Qwen3.5-9B` | base model id |
| `RIVER_CHECKPOINT` | — | `river://...` LoRA checkpoint (tuned serving) |
| `KEV_TOKEN` | — | bearer token; unset → no auth (logs a warning) |
| `RIVER_TIMEOUT_S` | `20` | per-request upstream + gRPC timeout |
| `PORT` | `8080` | local uvicorn port |

**Fine-tune on your corrections:**

```bash
# export feedback JSON from the extension, then
python ../../evals/river/format.py --export export.json --out sft-feedback.jsonl
python ../../evals/river/sft.py --data sft-feedback.jsonl --name <n>
RIVER_CHECKPOINT=river://<session>/sampler_weights/<n> modal deploy deploy.py
```

`evals/run_quality.py` and `evals/run_burst.py` work unchanged against the
proxy (`--endpoint http://localhost:8080`, token via `--token-file` or
`$KEV_TOKEN`) — that is how every number above was produced.
