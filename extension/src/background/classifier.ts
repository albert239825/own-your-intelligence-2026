import type { Classifier, Policy, PostSnapshot } from "../contracts";
import { compileQuestions } from "../policy/compile";
import { requiredRuleIds } from "../policy/evaluate";

const RAGE = /idiot|moron|destroy|clown|pathetic|disgrace/i;
const HYPE = /revolutionary|game.?changer|100x|insane|mind.?blowing/i;
const FARMING = /agree\?|rt if|like if|follow me/i;
const CRITIQUE_SIGNAL =
  /because|however|measured|benchmark|method|evidence|limitation|reproduc/i;

const HIGH = 0.95;
const LOW = 0.05;

/**
 * Deterministic keyword classifier for dev + fixture demo. Not a model —
 * exists so the full pipeline runs without an endpoint.
 */
export class MockClassifier implements Classifier {
  readonly modelVersion = "mock-0.1";

  async classify(post: PostSnapshot, policy: Policy): Promise<Record<string, number>> {
    const text = `${post.text}\n${post.quoteText ?? ""}`;
    const scores: Record<string, number> = {
      rage_bait: RAGE.test(text) ? HIGH : LOW,
      hype: HYPE.test(text) ? HIGH : LOW,
      engagement_farming: FARMING.test(text) ? HIGH : LOW,
      substantive_critique:
        text.length > 200 && CRITIQUE_SIGNAL.test(text) ? 0.9 : 0.1,
    };
    const probs: Record<string, number> = {};
    for (const id of requiredRuleIds(policy)) {
      probs[id] = scores[id] ?? LOW;
    }
    return probs;
  }
}

export interface KevSettings {
  endpoint: string;
  token: string;
}

export const DEFAULT_KEV_ENDPOINT =
  "https://albert23982--attention-filter-kev-api.modal.run";

/**
 * Real classifier: POST {endpoint}/v1/systemone with bearer auth.
 * Response shape verified against services/kev adapter.py:
 * `{ model_version, answers: { [ruleId]: { probability } } }`.
 */
export class KevClassifier implements Classifier {
  private _modelVersion = "kev-4b-0.1";
  get modelVersion(): string {
    return this._modelVersion;
  }

  constructor(private settings: KevSettings) {}

  async classify(
    post: PostSnapshot,
    policy: Policy,
    signal?: AbortSignal,
  ): Promise<Record<string, number>> {
    const { questions } = compileQuestions(policy);
    const body = {
      state: {
        post_text: post.text,
        quoted_text: post.quoteText,
        link_text: post.linkText,
      },
      questions,
    };

    const timeout = AbortSignal.timeout(2500);
    const endpoint = (this.settings.endpoint || DEFAULT_KEV_ENDPOINT).replace(/\/$/, "");
    const res = await fetch(`${endpoint}/v1/systemone`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.settings.token}`,
      },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) throw new Error(`kev endpoint ${res.status}`);

    const json = (await res.json()) as {
      model_version?: string;
      answers?: Record<string, { probability?: number }>;
    };
    if (json.model_version) this._modelVersion = json.model_version;
    const probs: Record<string, number> = {};
    for (const id of requiredRuleIds(policy)) {
      const p = json.answers?.[id]?.probability;
      if (typeof p === "number") probs[id] = p;
    }
    return probs;
  }
}
