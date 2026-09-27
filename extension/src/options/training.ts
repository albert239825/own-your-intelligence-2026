import type { Feedback, Policy } from "../contracts";
import { TASK_INSTRUCTION } from "../policy/compile";
import { hideRules } from "../policy/evaluate";

export interface TrainingRecord {
  state: { post_text: string; quoted_text?: string };
  question: { type: "noul"; instructions: { task: string; rule: string } };
  label: 0 | 1;
  meta: {
    postId: string;
    contentHash: string;
    ruleId: string;
    source: Feedback["kind"];
    policyRevision: number;
    modelProb?: number;
    createdAt: number;
  };
}

/**
 * Turn saved user feedback into fine-tune records: one record per
 * (feedback, hide rule) pair using the *current* policy's instruction text.
 * Feedback whose ruleId isn't a known hide rule is skipped; `change_preference`
 * emits nothing (it edits the policy rather than labeling the post).
 */
export function buildTrainingRecords(policy: Policy, feedback: Feedback[]): TrainingRecord[] {
  const rules = hideRules(policy);
  const byId = new Map(rules.map((r) => [r.id, r]));
  const records: TrainingRecord[] = [];

  const emit = (fb: Feedback, ruleId: string, label: 0 | 1) => {
    const rule = byId.get(ruleId);
    if (!rule) return;
    const state: TrainingRecord["state"] = { post_text: fb.text };
    if (fb.quoteText) state.quoted_text = fb.quoteText;
    records.push({
      state,
      question: { type: "noul", instructions: { task: TASK_INSTRUCTION, rule: rule.instruction } },
      label,
      meta: {
        postId: fb.postId,
        contentHash: fb.contentHash,
        ruleId,
        source: fb.kind,
        policyRevision: fb.policyRevision,
        modelProb: fb.probabilities?.[ruleId],
        createdAt: fb.createdAt,
      },
    });
  };

  for (const fb of feedback) {
    switch (fb.kind) {
      case "wrong_classification":
        if (fb.ruleId === undefined) break; // "Other…" free text: no rule to label
        emit(fb, fb.ruleId, fb.desiredAction === "hide" ? 1 : 0);
        break;
      case "confirm_hide":
        if (fb.ruleId === undefined) break;
        emit(fb, fb.ruleId, 1);
        break;
      case "confirm_show":
        // Positive confirmation: post is a negative example for every hide rule.
        for (const rule of rules) emit(fb, rule.id, 0);
        break;
      case "change_preference":
        break;
    }
  }
  return records;
}

export function toJsonl(records: TrainingRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}
