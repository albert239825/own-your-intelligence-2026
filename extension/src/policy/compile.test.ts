import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type Policy } from "../contracts";
import { compileQuestions, TASK_INSTRUCTION } from "./compile";
import { requiredRuleIds } from "./evaluate";

describe("compileQuestions", () => {
  it("emits exactly one question per requiredRuleIds entry", () => {
    const { questions } = compileQuestions(DEFAULT_POLICY);
    expect(Object.keys(questions).sort()).toEqual(requiredRuleIds(DEFAULT_POLICY).sort());
  });

  it("includes the task preamble and the rule instruction verbatim", () => {
    const { questions } = compileQuestions(DEFAULT_POLICY);
    for (const rule of DEFAULT_POLICY.rules) {
      const q = questions[rule.id];
      expect(q?.type).toBe("noul");
      expect(q?.instructions.task).toBe(TASK_INSTRUCTION);
      expect(q?.instructions.rule).toBe(rule.instruction);
    }
  });

  it("adds a custom question when customInstruction is set", () => {
    const policy: Policy = { ...DEFAULT_POLICY, customInstruction: "hide crypto" };
    const { questions } = compileQuestions(policy);
    expect(questions.custom?.instructions.rule).toBe("hide crypto");
    expect(Object.keys(questions).sort()).toEqual(requiredRuleIds(policy).sort());
  });

  it("excludes disabled rules but keeps referenced exceptions", () => {
    const policy: Policy = {
      ...DEFAULT_POLICY,
      rules: DEFAULT_POLICY.rules.map((r) => ({ ...r, enabled: r.id !== "rage_bait" })),
    };
    const { questions } = compileQuestions(policy);
    expect(questions.rage_bait).toBeUndefined();
    expect(questions.substantive_critique).toBeDefined();
  });
});
