import { z } from "zod";
import {
  CUSTOM_RULE_ID,
  EXTRACTOR_VERSION,
  FeedbackSchema,
  OverrideSchema,
  PolicySchema,
  type DecisionResult,
  type Disposition,
  type Feedback,
  type Override,
  type Policy,
  type PostSnapshot,
  type Rule,
} from "../contracts";
import { MockClassifier } from "../background/classifier";
import { compileQuestions, TASK_INSTRUCTION } from "../policy/compile";
import { evaluate, type Evaluation } from "../policy/evaluate";

// Pure state/DOM-free helpers shared by the options page, popup, and tests.

export interface Settings {
  endpoint: string;
  token: string;
  classifier: "mock" | "kev";
  onboarded: boolean;
}
export const DEFAULT_SETTINGS: Settings = {
  endpoint: "",
  token: "",
  classifier: "mock",
  onboarded: false,
};

export type Aggressiveness = "cautious" | "balanced" | "aggressive";
export const AGGRESSIVENESS_THRESHOLDS: Record<Aggressiveness, number> = {
  cautious: 0.95,
  balanced: 0.85,
  aggressive: 0.7,
};

/** Rules that carry a hideThreshold (exception-only rules excluded). */
function thresholdRules(policy: Policy): Rule[] {
  return policy.rules.filter((r) => r.hideThreshold !== undefined);
}

/** Returns the preset whose threshold every enabled hide rule matches, else "custom". */
export function detectAggressiveness(policy: Policy): Aggressiveness | "custom" {
  const rules = thresholdRules(policy).filter((r) => r.enabled);
  for (const [name, t] of Object.entries(AGGRESSIVENESS_THRESHOLDS) as [
    Aggressiveness,
    number,
  ][]) {
    if (rules.length > 0 && rules.every((r) => r.hideThreshold === t)) return name;
  }
  return "custom";
}

/** Sets hideThreshold on every rule that has one. Pure, returns new Policy (same revision). */
export function applyAggressiveness(policy: Policy, a: Aggressiveness): Policy {
  const t = AGGRESSIVENESS_THRESHOLDS[a];
  return {
    ...policy,
    rules: policy.rules.map((r) =>
      r.hideThreshold === undefined ? r : { ...r, hideThreshold: t },
    ),
  };
}

/** One-line plain-English descriptions shown next to preset toggles, keyed by rule id. */
export const RULE_BLURBS: Record<string, { catches: string; spares: string }> = {
  rage_bait: {
    catches: "Insults, pile-ons, and outrage bait",
    spares: "Criticism and disagreement with reasons",
  },
  hype: {
    catches: "Superlatives and promotion with no evidence",
    spares: "Announcements and demos with concrete results",
  },
  engagement_farming: {
    catches: "'Agree?', 'RT if', content-free polls, follow-begging",
    spares: "Real questions and discussions",
  },
  substantive_critique: {
    catches: "Keeps argued, evidence-backed criticism visible",
    spares: "Acts as a safety net for the hide rules above",
  },
};

export interface PolicyDraft {
  rules: Rule[];
  customInstruction?: string;
}

/**
 * Build the next policy: revision = current.revision + 1, schemaVersion 1,
 * trims customInstruction (empty -> undefined). Throws via PolicySchema.parse.
 */
export function nextPolicy(current: Policy, draft: PolicyDraft): Policy {
  const customInstruction = draft.customInstruction?.trim() || undefined;
  return PolicySchema.parse({
    schemaVersion: 1,
    revision: current.revision + 1,
    rules: draft.rules,
    customInstruction,
  });
}

const NEVER_HIDE_MARKER = "\nNever hide posts about: ";

/** Combine "less/more of" and "always keep" into one customInstruction string. */
export function joinCustomInstruction(
  lessMore: string,
  alwaysKeep: string,
): string | undefined {
  const lm = lessMore.trim();
  const ak = alwaysKeep.trim();
  const parts: string[] = [];
  if (lm) parts.push(lm);
  if (ak) parts.push(`Never hide posts about: ${ak}`);
  const joined = parts.join("\n");
  return joined || undefined;
}

/** Inverts joinCustomInstruction; lenient about formatting. */
export function splitCustomInstruction(s: string | undefined): {
  lessMore: string;
  alwaysKeep: string;
} {
  if (!s) return { lessMore: "", alwaysKeep: "" };
  const idx = s.indexOf(NEVER_HIDE_MARKER);
  if (idx === -1) {
    // Lenient: also match the marker without leading newline.
    const m = s.match(/Never hide posts about:\s*(.*)$/s);
    if (m && m.index !== undefined) {
      return {
        lessMore: s.slice(0, m.index).trim(),
        alwaysKeep: (m[1] ?? "").trim(),
      };
    }
    return { lessMore: s, alwaysKeep: "" };
  }
  return {
    lessMore: s.slice(0, idx).trim(),
    alwaysKeep: s.slice(idx + NEVER_HIDE_MARKER.length).trim(),
  };
}

function examplePost(postId: string, text: string): PostSnapshot {
  return {
    platform: "x",
    postId,
    contentHash: `example-${postId}`,
    text,
    complete: true,
    extractorVersion: EXTRACTOR_VERSION,
  };
}

export const EXAMPLE_POSTS: {
  label: "bait" | "critique" | "neutral";
  expect: Disposition;
  post: PostSnapshot;
}[] = [
  {
    label: "bait",
    expect: "hide",
    post: examplePost(
      "example-bait",
      "Anyone still defending that launch is an idiot. These clowns have been wrong every single year. Pathetic.",
    ),
  },
  {
    label: "critique",
    expect: "show",
    post: examplePost(
      "example-critique",
      "The launch post calls the old baseline pathetic, but that framing hides the real story. Because the reported score comes from a private benchmark with no reproducible harness, the method section matters more than the headline number. The evidence shows the gap narrows once sampling budgets match, which is a serious limitation the announcement never mentions.",
    ),
  },
  {
    label: "neutral",
    expect: "show",
    post: examplePost(
      "example-neutral",
      "We shipped version 2.3 of the client today. Changelog and upgrade notes are on the docs site.",
    ),
  },
];

export interface PreviewRow {
  label: string;
  text: string;
  evaluation: Evaluation;
}

/** Runs MockClassifier + evaluate() for each EXAMPLE_POST under the given policy. */
export async function previewExamples(policy: Policy): Promise<PreviewRow[]> {
  const classifier = new MockClassifier();
  const rows: PreviewRow[] = [];
  for (const { label, post } of EXAMPLE_POSTS) {
    const probabilities = await classifier.classify(post, policy);
    const evaluation = evaluate({ post, policy, probabilities, enabled: true });
    rows.push({ label, text: post.text, evaluation });
  }
  return rows;
}

export interface ExportBundle {
  exportedAt: string;
  policy: Policy;
  feedback: Feedback[];
  overrides: Record<string, Override>;
}

/** Never includes token/endpoint — those live in settings, not the bundle. */
export function buildExport(
  policy: Policy,
  feedback: Feedback[],
  overrides: Record<string, Override>,
): ExportBundle {
  return {
    exportedAt: new Date().toISOString(),
    policy,
    feedback,
    overrides,
  };
}

export type ImportResult =
  | { ok: true; policy: Policy; feedback: Feedback[]; overrides: Record<string, Override> }
  | { ok: false; error: string };

/** Accepts a full ExportBundle or a bare Policy JSON. */
export function parseImport(json: string): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${String(e)}` };
  }
  const isBundle =
    typeof raw === "object" && raw !== null && "policy" in raw;
  const policyRaw = isBundle ? (raw as { policy: unknown }).policy : raw;
  const parsed = PolicySchema.safeParse(policyRaw);
  if (!parsed.success) {
    return { ok: false, error: `Invalid policy: ${parsed.error.message}` };
  }
  let feedback: Feedback[] = [];
  let overrides: Record<string, Override> = {};
  if (isBundle) {
    const bundle = raw as { feedback?: unknown; overrides?: unknown };
    if (bundle.feedback !== undefined) {
      const fb = FeedbackSchema.array().safeParse(bundle.feedback);
      if (!fb.success) {
        return { ok: false, error: `Invalid feedback: ${fb.error.message}` };
      }
      feedback = fb.data;
    }
    if (bundle.overrides !== undefined) {
      const ov = z.record(OverrideSchema).safeParse(bundle.overrides);
      if (!ov.success) {
        return { ok: false, error: `Invalid overrides: ${ov.error.message}` };
      }
      overrides = ov.data;
    }
  }
  return { ok: true, policy: parsed.data, feedback, overrides };
}

export interface HistoryCounts {
  hiddenTotal: number;
  hiddenToday: number;
  uncertainTotal: number;
  total: number;
}

/**
 * DecisionResult has no timestamp, so "today" needs a sidecar `seenAt` map
 * (requestId -> ms epoch) recorded by whoever saw the result. When no map is
 * provided we cannot know times at all, so hiddenToday falls back to
 * hiddenTotal — the UI labels it "this session" to stay honest.
 */
export function historyCounts(
  history: DecisionResult[],
  seenAt?: Record<string, number>,
  now = Date.now(),
): HistoryCounts {
  const today = new Date(now).toDateString();
  let hiddenTotal = 0;
  let hiddenToday = 0;
  let uncertainTotal = 0;
  for (const h of history) {
    if (h.disposition === "hide") {
      hiddenTotal++;
      if (!seenAt) hiddenToday++;
      else {
        const t = seenAt[h.requestId];
        if (t !== undefined && new Date(t).toDateString() === today) {
          hiddenToday++;
        }
      }
    } else if (h.disposition === "uncertain") {
      uncertainTotal++;
    }
  }
  return { hiddenTotal, hiddenToday, uncertainTotal, total: history.length };
}

export interface ReviewRow {
  result: DecisionResult;
  causeTitles: string[];
  exceptionTitles: string[];
}

function ruleTitle(policy: Policy, id: string): string {
  if (id === CUSTOM_RULE_ID) return "Your custom filter";
  return policy.rules.find((r) => r.id === id)?.title ?? id;
}

/** Hide/uncertain rows, deduped by postId keeping the newest (history is newest-first). */
export function reviewRows(history: DecisionResult[], policy: Policy): ReviewRow[] {
  const seen = new Set<string>();
  const rows: ReviewRow[] = [];
  for (const result of history) {
    if (result.disposition !== "hide" && result.disposition !== "uncertain") {
      continue;
    }
    if (seen.has(result.postId)) continue;
    seen.add(result.postId);
    rows.push({
      result,
      causeTitles: result.causeRuleIds.map((id) => ruleTitle(policy, id)),
      exceptionTitles: result.exceptionRuleIds.map((id) => ruleTitle(policy, id)),
    });
  }
  return rows;
}

export interface PromptDescription {
  taskInstruction: string;
  compilerVersion: string;
  policyRevision: number;
  entries: { id: string; title: string; question: string }[];
}

/** What the model is asked: TASK_INSTRUCTION + one entry per compiled question. */
export function describePrompt(policy: Policy): PromptDescription {
  const compiled = compileQuestions(policy);
  const entries = Object.entries(compiled.questions).map(([id, q]) => ({
    id,
    title: ruleTitle(policy, id),
    question: q.instructions.rule,
  }));
  return {
    taskInstruction: TASK_INSTRUCTION,
    compilerVersion: compiled.compilerVersion,
    policyRevision: policy.revision,
    entries,
  };
}

