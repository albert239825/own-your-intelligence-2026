import type { Disposition, Override, Policy, PostSnapshot, Rule } from "../contracts";
import { CUSTOM_RULE_ID } from "../contracts";

export const EXCEPTION_KEEP = 0.7;
export const EXCEPTION_UNCERTAIN = 0.3;

export interface RuleTrace {
  ruleId: string;
  probability: number | undefined;
  threshold: number;
  fired: boolean;
  /** Exception that protected the post, if any, with its probability. */
  protectedBy?: { ruleId: string; probability: number; uncertain: boolean };
}

export interface Evaluation {
  disposition: Disposition;
  causeRuleIds: string[];
  exceptionRuleIds: string[];
  source: "model" | "override" | "fallback";
  trace: RuleTrace[];
}

export interface EvaluateInput {
  post: PostSnapshot;
  policy: Policy;
  probabilities: Record<string, number> | null;
  override?: Override;
  enabled: boolean;
}

/** Rules that carry a hideThreshold, plus the synthetic custom rule when customInstruction is set. */
export function hideRules(policy: Policy): Rule[] {
  const rules = policy.rules.filter((r) => r.enabled && r.hideThreshold !== undefined);
  if (policy.customInstruction && policy.customInstruction.trim().length > 0) {
    rules.push({
      id: CUSTOM_RULE_ID,
      title: "Your custom filter",
      instruction: policy.customInstruction,
      enabled: true,
      hideThreshold: 0.85,
      exceptionRuleIds: [],
    });
  }
  return rules;
}

/** Every rule id whose probability the classifier must return for this policy. */
export function requiredRuleIds(policy: Policy): string[] {
  const ids = new Set<string>();
  for (const r of hideRules(policy)) {
    ids.add(r.id);
    for (const e of r.exceptionRuleIds) ids.add(e);
  }
  return [...ids];
}

export function evaluate(input: EvaluateInput): Evaluation {
  const { post, policy, probabilities, override, enabled } = input;
  const empty: Evaluation = { disposition: "show", causeRuleIds: [], exceptionRuleIds: [], source: "fallback", trace: [] };

  if (!enabled) return empty;
  if (override && override.contentHash === post.contentHash) {
    return {
      ...empty,
      disposition: override.action === "hide" ? "hide" : "show",
      source: "override",
    };
  }
  if (!post.complete || post.text.trim().length === 0) return { ...empty, disposition: "unsupported" };
  if (!probabilities) return empty;

  const trace: RuleTrace[] = [];
  const causes: string[] = [];
  const exceptions = new Set<string>();
  let anyUncertain = false;

  for (const rule of hideRules(policy)) {
    const p = probabilities[rule.id];
    const threshold = rule.hideThreshold ?? 1;
    const t: RuleTrace = { ruleId: rule.id, probability: p, threshold, fired: false };
    trace.push(t);
    if (p === undefined || p < threshold) continue;

    let protectedBy: RuleTrace["protectedBy"];
    for (const exId of rule.exceptionRuleIds) {
      const pe = probabilities[exId];
      if (pe === undefined) continue;
      if (pe >= EXCEPTION_KEEP) {
        protectedBy = { ruleId: exId, probability: pe, uncertain: false };
        break;
      }
      if (pe >= EXCEPTION_UNCERTAIN) {
        protectedBy = { ruleId: exId, probability: pe, uncertain: true };
        break;
      }
    }
    if (protectedBy) {
      t.protectedBy = protectedBy;
      exceptions.add(protectedBy.ruleId);
      if (protectedBy.uncertain) anyUncertain = true;
      continue;
    }
    t.fired = true;
    causes.push(rule.id);
  }

  let disposition: Disposition = "show";
  if (causes.length > 0) disposition = "hide";
  else if (anyUncertain) disposition = "uncertain";

  return { disposition, causeRuleIds: causes, exceptionRuleIds: [...exceptions], source: "model", trace };
}
