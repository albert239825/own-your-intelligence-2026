import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;
export const EXTRACTOR_VERSION = "x-0.1";
export const COMPILER_VERSION = "compile-0.1";

export const DispositionSchema = z.enum(["show", "hide", "uncertain", "unsupported"]);
export type Disposition = z.infer<typeof DispositionSchema>;

export const PostSnapshotSchema = z.object({
  platform: z.literal("x"),
  postId: z.string().min(1),
  url: z.string().optional(),
  contentHash: z.string().min(1),
  text: z.string(),
  quoteText: z.string().optional(),
  linkText: z.string().optional(),
  complete: z.boolean(),
  extractorVersion: z.string(),
});
export type PostSnapshot = z.infer<typeof PostSnapshotSchema>;

export const RuleSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  instruction: z.string().min(1),
  enabled: z.boolean(),
  /** Hide when P(yes) >= hideThreshold. Exception-only rules leave this undefined. */
  hideThreshold: z.number().min(0).max(1).optional(),
  /** Rule ids whose "yes" answer protects a post from this rule. */
  exceptionRuleIds: z.array(z.string()).default([]),
});
export type Rule = z.infer<typeof RuleSchema>;

export const PolicySchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  revision: z.number().int().nonnegative(),
  rules: z.array(RuleSchema),
  customInstruction: z.string().optional(),
});
export type Policy = z.infer<typeof PolicySchema>;

export const OverrideSchema = z.object({
  postId: z.string(),
  contentHash: z.string(),
  action: z.enum(["keep", "hide"]),
  createdAt: z.number(),
});
export type Override = z.infer<typeof OverrideSchema>;

export const DecisionResultSchema = z.object({
  requestId: z.string(),
  postId: z.string(),
  contentHash: z.string(),
  policyRevision: z.number(),
  modelVersion: z.string(),
  disposition: DispositionSchema,
  causeRuleIds: z.array(z.string()),
  exceptionRuleIds: z.array(z.string()),
  probabilities: z.record(z.string(), z.number()),
  source: z.enum(["model", "cache", "override", "fallback"]),
  elapsedMs: z.number(),
});
export type DecisionResult = z.infer<typeof DecisionResultSchema>;

export const FeedbackSchema = z.object({
  feedbackId: z.string(),
  postId: z.string(),
  contentHash: z.string(),
  text: z.string(),
  kind: z.enum(["wrong_classification", "change_preference"]),
  desiredAction: z.enum(["keep", "hide"]),
  ruleId: z.string().optional(),
  explanation: z.string().optional(),
  policyRevision: z.number(),
  createdAt: z.number(),
});
export type Feedback = z.infer<typeof FeedbackSchema>;

export const DecisionRequestSchema = z.object({
  requestId: z.string(),
  post: PostSnapshotSchema,
  policyRevision: z.number(),
});
export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;

export const MessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("CLASSIFY_POST"), request: DecisionRequestSchema }),
  z.object({ type: z.literal("GET_POLICY") }),
  z.object({ type: z.literal("SAVE_POLICY"), policy: PolicySchema }),
  z.object({ type: z.literal("SET_OVERRIDE"), override: OverrideSchema }),
  z.object({ type: z.literal("SAVE_FEEDBACK"), feedback: FeedbackSchema }),
  z.object({ type: z.literal("GET_HISTORY") }),
  z.object({ type: z.literal("CLEAR_HISTORY") }),
  z.object({ type: z.literal("SET_ENABLED"), enabled: z.boolean() }),
  z.object({ type: z.literal("GET_ENABLED") }),
]);
export type Message = z.infer<typeof MessageSchema>;

/** Broadcast from worker to content scripts when policy/enabled state changes. */
export const BroadcastSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("POLICY_CHANGED"), revision: z.number() }),
  z.object({ type: z.literal("ENABLED_CHANGED"), enabled: z.boolean() }),
]);
export type Broadcast = z.infer<typeof BroadcastSchema>;

export interface Classifier {
  readonly modelVersion: string;
  /** Returns P(yes) per rule id for every enabled rule (and exception rules they reference). */
  classify(post: PostSnapshot, policy: Policy, signal?: AbortSignal): Promise<Record<string, number>>;
}

export const DEFAULT_POLICY: Policy = {
  schemaVersion: 1,
  revision: 1,
  rules: [
    {
      id: "rage_bait",
      title: "Rage bait",
      instruction:
        "Is this post rage bait — is its main purpose provoking anger through insults, caricature, or unsupported outrage (criticism or disagreement alone does not count)?",
      enabled: true,
      hideThreshold: 0.7,
      exceptionRuleIds: ["substantive_critique"],
    },
    {
      id: "hype",
      title: "Hype",
      instruction:
        "Is this post hype — does it promote a product, model, or trend with superlatives and no concrete evidence, demo, or result?",
      enabled: true,
      hideThreshold: 0.6,
      exceptionRuleIds: ["substantive_critique"],
    },
    {
      id: "engagement_farming",
      title: "Engagement farming",
      instruction:
        "Is this post engagement farming — is its main purpose to solicit replies, likes, or reposts (content-free polls, 'agree?', 'RT if', follow-for-follow)?",
      enabled: true,
      hideThreshold: 0.5,
      exceptionRuleIds: [],
    },
    {
      id: "substantive_critique",
      title: "Substantive critique (exception)",
      instruction:
        "Does the post develop a specific criticism or argument with reasons, methods, limitations, or evidence? A bare link, number, or insult is not sufficient.",
      enabled: true,
      exceptionRuleIds: [],
    },
  ],
};

export const CUSTOM_RULE_ID = "custom";
