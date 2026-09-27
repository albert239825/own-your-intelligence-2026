import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  type Override,
  type Policy,
  type PostSnapshot,
} from "../contracts";
import { evaluate, requiredRuleIds } from "./evaluate";

const post: PostSnapshot = {
  platform: "x",
  postId: "p1",
  contentHash: "h1",
  text: "some post text",
  complete: true,
  extractorVersion: "x-0.1",
};

const probs = (over: Record<string, number>) => ({
  rage_bait: 0.05,
  hype: 0.05,
  engagement_farming: 0.05,
  substantive_critique: 0.1,
  ...over,
});

describe("evaluate", () => {
  it("shows when disabled", () => {
    const r = evaluate({ post, policy: DEFAULT_POLICY, probabilities: probs({ rage_bait: 0.99 }), enabled: false });
    expect(r.disposition).toBe("show");
  });

  it("honors a keep override (contentHash must match)", () => {
    const override: Override = { postId: "p1", contentHash: "h1", action: "keep", createdAt: 0 };
    const r = evaluate({ post, policy: DEFAULT_POLICY, probabilities: probs({ rage_bait: 0.99 }), override, enabled: true });
    expect(r.disposition).toBe("show");
    expect(r.source).toBe("override");
  });

  it("honors a hide override", () => {
    const override: Override = { postId: "p1", contentHash: "h1", action: "hide", createdAt: 0 };
    const r = evaluate({ post, policy: DEFAULT_POLICY, probabilities: probs({}), override, enabled: true });
    expect(r.disposition).toBe("hide");
    expect(r.source).toBe("override");
  });

  it("ignores an override with a different contentHash", () => {
    const override: Override = { postId: "p1", contentHash: "other", action: "hide", createdAt: 0 };
    const r = evaluate({ post, policy: DEFAULT_POLICY, probabilities: probs({}), override, enabled: true });
    expect(r.disposition).toBe("show");
  });

  it("returns unsupported for incomplete posts", () => {
    const r = evaluate({ post: { ...post, complete: false }, policy: DEFAULT_POLICY, probabilities: probs({ rage_bait: 0.99 }), enabled: true });
    expect(r.disposition).toBe("unsupported");
  });

  it("returns unsupported for empty text", () => {
    const r = evaluate({ post: { ...post, text: "  " }, policy: DEFAULT_POLICY, probabilities: probs({}), enabled: true });
    expect(r.disposition).toBe("unsupported");
  });

  it("shows via fallback when probabilities are null", () => {
    const r = evaluate({ post, policy: DEFAULT_POLICY, probabilities: null, enabled: true });
    expect(r.disposition).toBe("show");
    expect(r.source).toBe("fallback");
  });

  it("hides when a rule fires past threshold", () => {
    const r = evaluate({ post, policy: DEFAULT_POLICY, probabilities: probs({ rage_bait: 0.9 }), enabled: true });
    expect(r.disposition).toBe("hide");
    expect(r.causeRuleIds).toEqual(["rage_bait"]);
  });

  it("does not hide just under threshold", () => {
    // rage_bait hideThreshold is 0.70 in DEFAULT_POLICY
    const r = evaluate({ post, policy: DEFAULT_POLICY, probabilities: probs({ rage_bait: 0.69 }), enabled: true });
    expect(r.disposition).toBe("show");
  });

  it("exception >= 0.7 protects the post", () => {
    const r = evaluate({ post, policy: DEFAULT_POLICY, probabilities: probs({ rage_bait: 0.99, substantive_critique: 0.75 }), enabled: true });
    expect(r.disposition).toBe("show");
    expect(r.causeRuleIds).toEqual([]);
    expect(r.exceptionRuleIds).toEqual(["substantive_critique"]);
  });

  it("exception 0.3-0.7 yields uncertain", () => {
    const r = evaluate({ post, policy: DEFAULT_POLICY, probabilities: probs({ rage_bait: 0.99, substantive_critique: 0.5 }), enabled: true });
    expect(r.disposition).toBe("uncertain");
    expect(r.exceptionRuleIds).toEqual(["substantive_critique"]);
  });

  it("exception < 0.3 does not protect", () => {
    const r = evaluate({ post, policy: DEFAULT_POLICY, probabilities: probs({ rage_bait: 0.99, substantive_critique: 0.2 }), enabled: true });
    expect(r.disposition).toBe("hide");
    expect(r.causeRuleIds).toEqual(["rage_bait"]);
  });

  it("engagement_farming has no exceptions", () => {
    const r = evaluate({ post, policy: DEFAULT_POLICY, probabilities: probs({ engagement_farming: 0.95, substantive_critique: 0.99 }), enabled: true });
    expect(r.disposition).toBe("hide");
    expect(r.causeRuleIds).toEqual(["engagement_farming"]);
  });

  it("custom instruction becomes a hide rule", () => {
    const policy: Policy = { ...DEFAULT_POLICY, customInstruction: "hide posts about crypto" };
    const r = evaluate({ post, policy, probabilities: probs({ custom: 0.9 }), enabled: true });
    expect(r.disposition).toBe("hide");
    expect(r.causeRuleIds).toEqual(["custom"]);
  });
});

describe("requiredRuleIds", () => {
  it("includes hide rules and their exceptions", () => {
    const ids = requiredRuleIds(DEFAULT_POLICY);
    expect(ids).toContain("rage_bait");
    expect(ids).toContain("hype");
    expect(ids).toContain("engagement_farming");
    expect(ids).toContain("substantive_critique"); // exception of rage_bait + hype
  });

  it("includes custom when customInstruction set", () => {
    const ids = requiredRuleIds({ ...DEFAULT_POLICY, customInstruction: "x" });
    expect(ids).toContain("custom");
  });

  it("skips disabled rules", () => {
    const policy: Policy = {
      ...DEFAULT_POLICY,
      rules: DEFAULT_POLICY.rules.map((r) => ({ ...r, enabled: r.id !== "rage_bait" })),
    };
    const ids = requiredRuleIds(policy);
    expect(ids).not.toContain("rage_bait");
    expect(ids).toContain("substantive_critique"); // still exception of hype
  });
});
