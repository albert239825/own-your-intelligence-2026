import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type Feedback } from "../contracts";
import { TASK_INSTRUCTION } from "../policy/compile";
import { buildTrainingRecords, toJsonl } from "./training";

const fb = (over: Partial<Feedback>): Feedback => ({
  feedbackId: "f1",
  postId: "p1",
  contentHash: "h1",
  text: "post text",
  kind: "wrong_classification",
  desiredAction: "hide",
  policyRevision: 3,
  createdAt: 123,
  ...over,
});

const HIDE_RULE_COUNT = DEFAULT_POLICY.rules.filter(
  (r) => r.enabled && r.hideThreshold !== undefined,
).length;

describe("buildTrainingRecords", () => {
  it("wrong_classification + hide -> label 1 with the current policy's instruction", () => {
    const recs = buildTrainingRecords(DEFAULT_POLICY, [
      fb({ ruleId: "rage_bait", probabilities: { rage_bait: 0.42 } }),
    ]);
    expect(recs.length).toBe(1);
    const r = recs[0]!;
    expect(r.label).toBe(1);
    expect(r.state).toEqual({ post_text: "post text" });
    expect(r.question.type).toBe("noul");
    expect(r.question.instructions.task).toBe(TASK_INSTRUCTION);
    expect(r.question.instructions.rule).toBe(
      DEFAULT_POLICY.rules.find((x) => x.id === "rage_bait")!.instruction,
    );
    expect(r.meta).toMatchObject({
      postId: "p1",
      ruleId: "rage_bait",
      source: "wrong_classification",
      policyRevision: 3,
      modelProb: 0.42,
    });
  });

  it("wrong_classification + hide without ruleId (Other…) -> no record", () => {
    expect(
      buildTrainingRecords(DEFAULT_POLICY, [
        fb({ desiredAction: "hide", explanation: "spoilers" }),
      ]),
    ).toEqual([]);
  });

  it("wrong_classification + keep -> label 0", () => {
    const recs = buildTrainingRecords(DEFAULT_POLICY, [
      fb({ desiredAction: "keep", ruleId: "hype" }),
    ]);
    expect(recs.length).toBe(1);
    expect(recs[0]!.label).toBe(0);
    expect(recs[0]!.meta.ruleId).toBe("hype");
  });

  it("confirm_hide -> label 1", () => {
    const recs = buildTrainingRecords(DEFAULT_POLICY, [
      fb({ kind: "confirm_hide", desiredAction: "hide", ruleId: "engagement_farming" }),
    ]);
    expect(recs.length).toBe(1);
    expect(recs[0]!.label).toBe(1);
    expect(recs[0]!.meta.ruleId).toBe("engagement_farming");
    expect(recs[0]!.meta.source).toBe("confirm_hide");
  });

  it("confirm_show -> label 0 for every enabled hide rule", () => {
    const recs = buildTrainingRecords(DEFAULT_POLICY, [
      fb({ kind: "confirm_show", desiredAction: "keep", probabilities: { hype: 0.3 } }),
    ]);
    expect(recs.length).toBe(HIDE_RULE_COUNT);
    expect(new Set(recs.map((r) => r.meta.ruleId))).toEqual(
      new Set(["rage_bait", "hype", "engagement_farming"]),
    );
    expect(recs.every((r) => r.label === 0)).toBe(true);
    expect(recs.every((r) => r.meta.source === "confirm_show")).toBe(true);
    expect(recs.find((r) => r.meta.ruleId === "hype")!.meta.modelProb).toBe(0.3);
    expect(recs.find((r) => r.meta.ruleId === "rage_bait")!.meta.modelProb).toBeUndefined();
  });

  it("confirm_show also labels the custom rule when customInstruction is set", () => {
    const policy = { ...DEFAULT_POLICY, customInstruction: "less crypto" };
    const recs = buildTrainingRecords(policy, [
      fb({ kind: "confirm_show", desiredAction: "keep" }),
    ]);
    expect(recs.length).toBe(HIDE_RULE_COUNT + 1);
    const custom = recs.find((r) => r.meta.ruleId === "custom")!;
    expect(custom.label).toBe(0);
    expect(custom.question.instructions.rule).toBe("less crypto");
  });

  it("change_preference -> no records", () => {
    expect(
      buildTrainingRecords(DEFAULT_POLICY, [
        fb({ kind: "change_preference", ruleId: "rage_bait" }),
      ]),
    ).toEqual([]);
  });

  it("skips feedback whose ruleId isn't a known hide rule", () => {
    expect(
      buildTrainingRecords(DEFAULT_POLICY, [fb({ ruleId: "no_such_rule" })]),
    ).toEqual([]);
  });

  it("includes quoted_text only when quoteText is non-empty", () => {
    const withQ = buildTrainingRecords(DEFAULT_POLICY, [
      fb({ ruleId: "rage_bait", quoteText: "quoted stuff" }),
    ]);
    expect(withQ[0]!.state.quoted_text).toBe("quoted stuff");
    const withoutQ = buildTrainingRecords(DEFAULT_POLICY, [fb({ ruleId: "rage_bait" })]);
    expect("quoted_text" in withoutQ[0]!.state).toBe(false);
  });
});

describe("toJsonl", () => {
  it("one JSON object per line with trailing newline", () => {
    const recs = buildTrainingRecords(DEFAULT_POLICY, [
      fb({ ruleId: "rage_bait" }),
      fb({ kind: "confirm_hide", ruleId: "hype" }),
    ]);
    const jsonl = toJsonl(recs);
    expect(jsonl.endsWith("\n")).toBe(true);
    const lines = jsonl.trimEnd().split("\n");
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty("state");
      expect(parsed).toHaveProperty("question");
      expect(parsed).toHaveProperty("label");
      expect(parsed).toHaveProperty("meta");
    }
  });
});
