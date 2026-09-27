# Attention Filter — architecture and build timeline

Status: proposal for alignment before build. Supersedes the scheduler/monorepo detail in the
research plan (`attention-filter-technical-plan.md`); that doc remains the source register.

## 1. What we are building (one paragraph)

A Chrome MV3 extension that filters the X feed the user already has, according to preferences the
user states in plain language. Posts are classified by Kev (open decision model) running on a
Modal GPU the user controls. A deterministic evaluator turns per-rule probabilities into
hide/show; the placeholder shows the exact rule that fired. Rage bait disappears, substantive
disagreement stays. Corrections are saved as exact overrides or rule edits and change behavior
on the same feed and on unseen posts. Everything (rules, corrections, history, endpoint) is local
and exportable. Fine-tuning the weights on saved corrections is a real, scripted path (Modal H100,
~$1/run) that we run only if labeled data exists.

## 2. Decisions taken

| Decision | Choice | Why |
|---|---|---|
| Model | Kev-4B on Modal L40S, standard endpoint, 1 warm container | Single forward pass per post; upstream ~40 ms model time; fine-tunable |
| Fallback model | Kev-0.8B (speed) or any small LLM behind the same `Classifier` interface (quality) | Same contract, weaker ownership claim; decide at Gate A |
| River | Roadmap mention only | Cannot train Kev (catalog bases, generative loss) |
| GBrain | Stretch: optional storage backend for kept posts + corrections | Behind `Store` interface; never on the demo critical path |
| Repo shape | Single npm package + `services/` + `evals/` | 4-hour window; no monorepo |
| Pending behavior | Post visible while classifying; look-ahead prefetch | Avoid loading-placeholder flicker; accept rare flash of bait |
| Learning claim in demo | Exact override + rule edit; in-context examples only if Gate D passes | Honest |
| Labels | User labels come only from onboarding preferences + post interactions (keep / should-hide / shouldn't-hide). A ~30-post dev set written by us is for testing the model before the demo, not training | No labeling work for the user |
| Onboarding | First-install page: preset rule toggles + one free-text "what I want / don't want" field | Sets initial policy revision |
| Demo target | Fixture feed (reproducible) + live X smoke | Live X reshuffles between refreshes |

## 3. Architecture

```
X feed DOM
  │ MutationObserver + IntersectionObserver
  ▼
content/x-adapter.ts   discover · extract(PostSnapshot) · render(collapse/reveal) · restore
  │
content/scheduler.ts   visible-first priority queue · in-flight cap 4 · dedupe · stale rejection
  │  chrome.runtime.sendMessage(CLASSIFY_POST)
  ▼
background/worker.ts   validate msg · load policy · cache lookup · fetch endpoint · persist
  │                        │
  │                        ▼
  │              services/kev  (Modal, POST /v1/systemone, bearer token)
  ▼
policy/evaluate.ts     pure: (policy, probs, overrides) → {disposition, causeRuleIds, trace}
  │
  ▼ DecisionResult back to content script → adapter.render()

options/  (settings: rule cards + free-text; review: hidden history, correct, export)
storage/  (chrome.storage.local; Store interface; GBrain adapter = stretch)
evals/    (labeled posts JSONL, replay + burst harness, Python)
```

### Repository layout

```
extension/
  manifest.json
  src/contracts.ts        PostSnapshot, Policy, Rule, DecisionRequest/Result, messages (zod)
  src/policy/evaluate.ts  deterministic evaluator + trace   (pure, unit-tested)
  src/policy/compile.ts   Policy → Kev questions payload
  src/content/index.ts    lifecycle, scheduler
  src/content/x-adapter.ts
  src/background/index.ts worker: messaging, cache, endpoint client, storage
  src/background/classifier.ts   Classifier interface: KevClassifier | MockClassifier
  src/options/            onboarding, settings + review page (plain TS + HTML, no React)
  fixtures/feed.html      deterministic fixture feed (~30 posts) for dev + demo fallback
services/kev/
  deploy.py               Modal app: pinned Kev SHA + checkpoint, min_containers=1
  README.md               runbook: deploy, warm, verify, teardown
evals/
  posts.jsonl             ~30-post dev set (action + per-rule labels), written by us
  holdout.jsonl           ~10 unseen posts for the transfer check
  run_quality.py          Gate A: precision / false-hide / disagreement retention
  run_burst.py            Gate B: 1 / 8 / 30-post bursts, p50/p95 wall clock
docs/
  ARCHITECTURE.md         this file
  DEMO.md                 demo script + measured numbers
```

### Core contracts (frozen at T+0)

```ts
type Disposition = "show" | "hide" | "uncertain" | "unsupported";

interface PostSnapshot { platform: "x"; postId: string; url?: string; contentHash: string;
  text: string; quoteText?: string; linkText?: string; complete: boolean; extractorVersion: string; }

interface Rule { id: string; title: string; instruction: string; enabled: boolean;
  hideThreshold: number; exceptionRuleIds: string[]; }          // exceptions are rule-scoped
interface Policy { schemaVersion: 1; revision: number; rules: Rule[]; customInstruction?: string; }

interface DecisionResult { requestId: string; postId: string; contentHash: string; policyRevision: number;
  modelVersion: string; disposition: Disposition; causeRuleIds: string[]; exceptionRuleIds: string[];
  probabilities: Record<string, number>; source: "model" | "cache" | "override" | "fallback"; elapsedMs: number; }

interface Classifier { classify(post: PostSnapshot, policy: Policy): Promise<Record<string, number>>; }
```

Evaluator precedence: disabled/unsupported/stale → show · exact override → user action · each
enabled hide rule ≥ threshold → check only its attached exceptions (≥0.70 keeps, 0.30–0.70 keeps as
uncertain, <0.30 hide) · hide if any rule remains actionable.

Feedback (hidden post; bar click reveals in place, UI only): **Keep this post** (exact override
keep + `wrong_classification`/keep) · **Good call** (re-collapses as `· Noted`, `confirm_hide`) ·
**Change the filter** (inline instruction + threshold edit → SAVE_POLICY → new revision →
reevaluate mounted posts, plus `change_preference`). Shown post: **Hide** pill → pick a rule or
"Other…" → exact override hide + `wrong_classification`/hide; thresholds untouched.

Cache key: `contentHash + policyRevision + modelVersion + compilerVersion`.

## 4. Default policy (v1)

| Rule id | Instruction (shown to user verbatim) | Threshold | Exceptions |
|---|---|---|---|
| `rage_bait` | Is this post rage bait — is its main purpose provoking anger through insults, caricature, or unsupported outrage (criticism or disagreement alone does not count)? | 0.70 | `substantive_critique` |
| `hype` | Is this post hype — does it promote a product, model, or trend with superlatives and no concrete evidence, demo, or result? | 0.60 | `substantive_critique` |
| `engagement_farming` | Is this post engagement farming — is its main purpose to solicit replies, likes, or reposts (content-free polls, "agree?", "RT if", follow-for-follow)? | 0.50 | — |
| `substantive_critique` (exception only) | Does the post develop a specific criticism or argument with reasons, methods, limitations, or evidence? | — | — |
| `custom` | User's free-text instruction, sent as one additional question | 0.85 | — |

## 5. Gates (go/no-go)

| Gate | Test | Pass |
|---|---|---|
| A — quality | `run_quality.py` on ~30-post dev set (bait/critique pairs + controls), rules-only | ≥95% disagreement retention, ≥95% hide precision, hides a meaningful share of bait |
| B — latency | `run_burst.py` from the demo laptop against warm endpoint | 30-post burst: first 8 < 500 ms p95, all < 1.5 s p95; single warm post < 300 ms p95 |
| C — browser | fixture feed + live X: scroll, node reuse, disable/restore, stale response, reload | no unrelated element hidden; reveal sticks; override survives reload |
| D — attribution | freeze feed+model; one correction; reevaluate same feed; then holdout | changed decision on the corrected post (override) and ≥1 holdout change from a rule edit, logged |

If A fails: narrow rules, raise thresholds, then try 9B, then LLM fallback. If B fails: reduce
concurrency / context, then H100. Never drop rules to make a benchmark.

## 6. Build timeline (≈3.5 h, relative to build start T)

Parallel tracks: **M** (model/serving), **X** (extension). One integrator (Albert) reviews.

| Window | Track M | Track X | Decision at boundary |
|---|---|---|---|
| T+0:00–0:20 | Modal + HF auth; `deploy.py` from pinned Kev SHA; start warm-up | `contracts.ts`, `evaluate.ts` + tests, manifest, fixture feed, `MockClassifier`; extension loads and collapses one fixture post | Contracts frozen |
| T+0:20–1:00 | Write ~30-post dev set + 10 holdout; `run_quality.py`; **Gate A** | `x-adapter.ts` against live logged-in X: discover/extract/render/restore; node-reuse + stale guard | Keep 4B or fall back |
| T+1:00–1:45 | `run_burst.py` from laptop; **Gate B**; tune cap/context | `KevClassifier` in worker; scheduler; cache; first live hide with real model | One complete live flow |
| T+1:45–2:30 | Calibrate thresholds from Gate A output | Options page: rule cards, custom field; placeholder controls (reveal / keep / correct); review page; overrides + policy revisions persisted | Correction semantics demoable |
| T+2:30–3:00 | **Gate D** on fixture + holdout; record numbers in `DEMO.md` | Reevaluate-on-policy-change; degraded-state indicator; disable/restore | Freeze model + policy |
| T+3:00–3:30 | Stretch: GBrain store adapter *or* fine-tune run if ≥ few hundred labels (unlikely) | Live-X reliability pass; export JSON | No new core features |
| T+3:30–end | Rehearse on fixture; record fallback video; teardown plan | — | Submit |

Cut order if behind: GBrain → export → review-page search → custom free-text rule → `hype` rule.
Never cut: live hide/reveal, matched-rule placeholder, keep/correct, the bait-vs-critique pair.

## 7. Demo (90–120 s)

1. Fixture feed: critique, useful announcement, bait on the same topics. Filter off.
2. Read the user's rules aloud. Enable. Bait collapses; critique stays. Click a placeholder → rule shown.
3. Reveal one (nothing learned). Correct another: "change what I want" → edit rule text.
4. Reevaluate same feed → decision changes, attributable. Scroll to holdout post → changed too;
   unrelated bait still hidden.
5. Show endpoint setting + export: it's yours. Mention fine-tune path and GBrain if built.

## 8. Accounts / secrets

Required: Modal (`MODAL_TOKEN_ID`/`SECRET`), Hugging Face read token, logged-in X account on the
demo laptop, GitHub write access. Stretch: Postgres (Supabase/Neon) for GBrain. Not needed: River,
Memorable, QM, LLM API key (only for synthetic data if we fine-tune).

## 9. Open items

- Confirm event's actual build window and prebuilt-code rules.
- Team size beyond Albert + coding agents.
