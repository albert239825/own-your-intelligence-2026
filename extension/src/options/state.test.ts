import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type DecisionResult, type Feedback, type Policy } from "../contracts";
import { hideRules } from "../policy/evaluate";
import {
  applyAggressiveness,
  buildExport,
  detectAggressiveness,
  historyCounts,
  joinCustomInstruction,
  nextPolicy,
  parseImport,
  actionRows,
  previewExamples,
  reviewRows,
  splitCustomInstruction,
} from "./state";

describe("nextPolicy", () => {
  it("increments revision and drops empty customInstruction", () => {
    const next = nextPolicy(DEFAULT_POLICY, {
      rules: DEFAULT_POLICY.rules,
      customInstruction: "   ",
    });
    expect(next.revision).toBe(DEFAULT_POLICY.revision + 1);
    expect(next.customInstruction).toBeUndefined();
  });

  it("carries customThreshold only when customInstruction is non-empty", () => {
    const withCustom = nextPolicy(DEFAULT_POLICY, {
      rules: DEFAULT_POLICY.rules,
      customInstruction: "less crypto",
      customThreshold: 0.6,
    });
    expect(withCustom.customInstruction).toBe("less crypto");
    expect(withCustom.customThreshold).toBe(0.6);

    const without = nextPolicy(DEFAULT_POLICY, {
      rules: DEFAULT_POLICY.rules,
      customInstruction: "   ",
      customThreshold: 0.6,
    });
    expect(without.customInstruction).toBeUndefined();
    expect(without.customThreshold).toBeUndefined();
  });

  it("throws when a rule instruction is empty", () => {
    const rules = DEFAULT_POLICY.rules.map((r) =>
      r.id === "rage_bait" ? { ...r, instruction: "" } : r,
    );
    expect(() => nextPolicy(DEFAULT_POLICY, { rules })).toThrow();
  });
});

describe("disabled rule", () => {
  it("excludes rage_bait and the bait post shows", async () => {
    const rules = DEFAULT_POLICY.rules.map((r) =>
      r.id === "rage_bait" ? { ...r, enabled: false } : r,
    );
    const policy = nextPolicy(DEFAULT_POLICY, { rules });
    expect(hideRules(policy).map((r) => r.id)).not.toContain("rage_bait");
    const rows = await previewExamples(policy);
    expect(rows.find((r) => r.label === "bait")?.evaluation.disposition).toBe("show");
  });
});

describe("aggressiveness", () => {
  it("DEFAULT_POLICY detects as balanced", () => {
    expect(detectAggressiveness(DEFAULT_POLICY)).toBe("balanced");
  });

  it("apply/detect round trips relative to defaults; exception-only rule untouched", () => {
    const p = applyAggressiveness(DEFAULT_POLICY, "cautious");
    expect(detectAggressiveness(p)).toBe("cautious");
    const crit = p.rules.find((r) => r.id === "substantive_critique")!;
    expect(crit.hideThreshold).toBeUndefined();
    const t = (id: string) => p.rules.find((r) => r.id === id)!.hideThreshold;
    expect(t("rage_bait")).toBeCloseTo(0.8);
    expect(t("hype")).toBeCloseTo(0.7);
    expect(t("engagement_farming")).toBeCloseTo(0.6);
    const aggr = applyAggressiveness(DEFAULT_POLICY, "aggressive");
    const ta = (id: string) => aggr.rules.find((r) => r.id === id)!.hideThreshold;
    expect(ta("rage_bait")).toBeCloseTo(0.55);
    expect(ta("hype")).toBeCloseTo(0.45);
    expect(ta("engagement_farming")).toBeCloseTo(0.35);
    expect(detectAggressiveness(aggr)).toBe("aggressive");
  });

  it("detects custom when one threshold differs", () => {
    const p = applyAggressiveness(DEFAULT_POLICY, "balanced");
    const rules = p.rules.map((r) =>
      r.id === "rage_bait" ? { ...r, hideThreshold: 0.8 } : r,
    );
    expect(detectAggressiveness({ ...p, rules })).toBe("custom");
  });
});

describe("customInstruction join/split", () => {
  it("round trips both fields", () => {
    const joined = joinCustomInstruction("less crypto", "family news");
    expect(joined).toBe("less crypto\nNever hide posts about: family news");
    expect(splitCustomInstruction(joined)).toEqual({
      lessMore: "less crypto",
      alwaysKeep: "family news",
    });
  });

  it("handles empty cases", () => {
    expect(joinCustomInstruction(" ", "")).toBeUndefined();
    expect(joinCustomInstruction("", "x")).toBe("Never hide posts about: x");
    expect(splitCustomInstruction("Never hide posts about: x")).toEqual({
      lessMore: "",
      alwaysKeep: "x",
    });
    expect(splitCustomInstruction(undefined)).toEqual({ lessMore: "", alwaysKeep: "" });
    expect(splitCustomInstruction(joinCustomInstruction("only less", ""))).toEqual({
      lessMore: "only less",
      alwaysKeep: "",
    });
  });
});

describe("parseImport / buildExport", () => {
  it("rejects non-JSON", () => {
    const res = parseImport("{not json");
    expect(res.ok).toBe(false);
  });

  it("rejects schemaVersion 2", () => {
    const res = parseImport(JSON.stringify({ ...DEFAULT_POLICY, schemaVersion: 2 }));
    expect(res.ok).toBe(false);
  });

  it("rejects a rule without instruction", () => {
    const bad = {
      ...DEFAULT_POLICY,
      rules: DEFAULT_POLICY.rules.map((r) =>
        r.id === "hype" ? { ...r, instruction: "" } : r,
      ),
    };
    expect(parseImport(JSON.stringify(bad)).ok).toBe(false);
  });

  it("accepts a bare DEFAULT_POLICY", () => {
    const res = parseImport(JSON.stringify(DEFAULT_POLICY));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.policy.revision).toBe(DEFAULT_POLICY.revision);
  });

  it("round-trips a full bundle and never contains token/endpoint", () => {
    const bundle = buildExport(DEFAULT_POLICY, [], { p1: { postId: "p1", contentHash: "h", action: "keep", createdAt: 1 } });
    const json = JSON.stringify(bundle);
    expect(json).not.toContain("token");
    expect(json).not.toContain("endpoint");
    const res = parseImport(json);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.policy).toEqual(DEFAULT_POLICY);
      expect(res.overrides.p1?.action).toBe("keep");
    }
  });

  it("rejects a bundle with invalid feedback", () => {
    const bundle = { ...buildExport(DEFAULT_POLICY, [], {}), feedback: [{ bad: true }] };
    expect(parseImport(JSON.stringify(bundle)).ok).toBe(false);
  });
});

describe("previewExamples", () => {
  it("bait hides via rage_bait, critique kept by exception, neutral shows", async () => {
    const rows = await previewExamples(DEFAULT_POLICY);
    const bait = rows.find((r) => r.label === "bait")!;
    expect(bait.evaluation.disposition).toBe("hide");
    expect(bait.evaluation.causeRuleIds).toEqual(["rage_bait"]);
    const critique = rows.find((r) => r.label === "critique")!;
    expect(critique.evaluation.disposition).toBe("show");
    expect(critique.evaluation.exceptionRuleIds).toContain("substantive_critique");
    const neutral = rows.find((r) => r.label === "neutral")!;
    expect(neutral.evaluation.disposition).toBe("show");
    expect(neutral.evaluation.causeRuleIds).toEqual([]);
  });

  it("critique hides once the exception is removed", async () => {
    const rules = DEFAULT_POLICY.rules.map((r) => ({
      ...r,
      exceptionRuleIds: r.exceptionRuleIds.filter((e) => e !== "substantive_critique"),
    }));
    const rows = await previewExamples({ ...DEFAULT_POLICY, rules });
    expect(rows.find((r) => r.label === "critique")!.evaluation.disposition).toBe("hide");
  });
});

describe("historyCounts / reviewRows", () => {
  const mk = (over: Partial<DecisionResult>): DecisionResult => ({
    requestId: "r1",
    postId: "p1",
    contentHash: "h1",
    policyRevision: 1,
    modelVersion: "mock-0.1",
    disposition: "hide",
    causeRuleIds: ["rage_bait"],
    exceptionRuleIds: [],
    probabilities: { rage_bait: 0.95 },
    source: "model",
    elapsedMs: 1,
    ...over,
  });

  it("counts hidden and uncertain; today falls back without seenAt", () => {
    const history = [
      mk({ requestId: "r1", postId: "p1" }),
      mk({ requestId: "r2", postId: "p2", disposition: "uncertain" }),
      mk({ requestId: "r3", postId: "p3", disposition: "show" }),
    ];
    const c = historyCounts(history);
    expect(c).toEqual({ hiddenTotal: 1, hiddenToday: 1, uncertainTotal: 1, total: 3 });
    const now = Date.now();
    const c2 = historyCounts(history, { r1: now - 2 * 86400000 }, now);
    expect(c2.hiddenToday).toBe(0);
  });

  it("dedupes by postId keeping newest, filters to hide/uncertain", () => {
    const history = [
      mk({ requestId: "new", postId: "p1", causeRuleIds: ["hype"] }),
      mk({ requestId: "old", postId: "p1", causeRuleIds: ["rage_bait"] }),
      mk({ requestId: "r3", postId: "p2", disposition: "show" }),
      mk({ requestId: "r4", postId: "p3", disposition: "uncertain" }),
    ];
    const rows = reviewRows(history, DEFAULT_POLICY);
    expect(rows.map((r) => r.result.requestId)).toEqual(["new", "r4"]);
    expect(rows[0]!.causeTitles).toEqual(["Hype"]);
  });
});

describe("actionRows", () => {
  const fb = (over: Partial<Feedback>): Feedback => ({
    feedbackId: "f1",
    postId: "p1",
    contentHash: "h",
    text: "post text",
    kind: "confirm_hide",
    desiredAction: "hide",
    policyRevision: 3,
    createdAt: 100,
    ...over,
  });

  it("maps each kind to badge, tone, and trainable", () => {
    const rows = actionRows([
      fb({ feedbackId: "a", kind: "wrong_classification", desiredAction: "hide", ruleId: "rage_bait" }),
      fb({ feedbackId: "b", kind: "wrong_classification", desiredAction: "keep", ruleId: "hype" }),
      fb({ feedbackId: "c", kind: "confirm_hide", ruleId: "rage_bait" }),
      fb({ feedbackId: "d", kind: "confirm_show" }),
      fb({ feedbackId: "e", kind: "change_preference" }),
    ], DEFAULT_POLICY);
    const by = Object.fromEntries(rows.map((r) => [r.feedback.feedbackId, r]));
    expect(by.a).toMatchObject({ badge: "Hidden by you", tone: "hide", trainable: true, ruleTitle: "Rage bait" });
    expect(by.b).toMatchObject({ badge: "Kept (was hidden)", tone: "show", trainable: true, ruleTitle: "Hype" });
    expect(by.c).toMatchObject({ badge: "Good call (hidden)", tone: "hide", trainable: true });
    expect(by.d).toMatchObject({ badge: "Good (kept)", tone: "show", trainable: true, ruleTitle: undefined });
    expect(by.e).toMatchObject({ badge: "Filter changed", tone: "uncertain", trainable: false });
  });

  it("sorts by createdAt newest first and titles the custom rule", () => {
    const rows = actionRows([
      fb({ feedbackId: "old", createdAt: 10 }),
      fb({ feedbackId: "new", kind: "confirm_show", createdAt: 30 }),
      fb({ feedbackId: "mid", kind: "wrong_classification", desiredAction: "hide", ruleId: "custom", createdAt: 20 }),
    ], DEFAULT_POLICY);
    expect(rows.map((r) => r.feedback.feedbackId)).toEqual(["new", "mid", "old"]);
    expect(rows[1]!.ruleTitle).toBe("Your custom filter");
  });
});
