// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";
import { DEFAULT_POLICY, type Policy } from "../contracts";
import { createController, type Controller } from "./controller";
import { xAdapter } from "./x-adapter";
import { fakeClassify, makeAppTweet } from "./test-utils";

const policy = (revision: number): Policy => ({ ...DEFAULT_POLICY, revision });

function setup(opts: { enabled?: boolean; policyRevision?: number } = {}) {
  const fc = fakeClassify();
  const onKeep = vi.fn();
  const onCorrect = vi.fn();
  const controller = createController({
    adapter: xAdapter,
    classify: fc.classify,
    getPolicy: () => Promise.resolve(policy(opts.policyRevision ?? 1)),
    getEnabled: () => Promise.resolve(opts.enabled ?? true),
    onKeep,
    onCorrect,
    log: () => {},
  });
  return { fc, controller, onKeep, onCorrect };
}

const collapsed = (node: Element) => node.getAttribute("data-af-state") === "collapsed";
// Count placeholder UIs only (the injected <style> also carries data-af-owned).
const owned = () => document.querySelectorAll("[data-af-owned].af-placeholder").length;

beforeEach(() => {
  document.body.innerHTML = "";
});

async function startWith(
  controller: Controller,
  tweets: HTMLElement[],
): Promise<void> {
  for (const t of tweets) document.body.appendChild(t);
  await controller.start();
  await controller.idle();
}

describe("controller", () => {
  it("recycled node: stale classify result is not rendered", async () => {
    const { fc, controller } = setup();
    const a = makeAppTweet({ id: "100", text: "tweet A" });
    document.body.appendChild(a);
    await controller.start();
    await controller.idle();
    expect(fc.callsFor("100").length).toBe(1);
    const keyA = controller.currentKey(a);
    expect(keyA).not.toBeNull();

    // X recycles the article in place: swap status link + text to tweet B.
    a.querySelector('a[href*="/status/"]')!.setAttribute("href", "/user/status/200");
    a.querySelector('[data-testid="tweetText"] span')!.textContent = "tweet B";
    await controller.idle(); // MO fires, recycle -> re-extract -> classify B

    expect(fc.callsFor("200").length).toBe(1);
    // Old key no longer valid for this node.
    expect(controller.currentKey(a)).not.toBe(keyA);

    // A's late result must not render.
    fc.resolve("100", "hide");
    await controller.idle();
    expect(collapsed(a)).toBe(false);

    // B's result renders normally.
    fc.resolve("200", "hide");
    await controller.idle();
    expect(collapsed(a)).toBe(true);
    expect(a.querySelector("[data-af-owned]")?.textContent).toContain("Hidden");
    controller.stop();
  });

  it("render/restore: collapse, reveal, keep", async () => {
    const { fc, controller, onKeep } = setup();
    const t = makeAppTweet({ id: "300", text: "hide me" });
    await startWith(controller, [t]);
    fc.resolve("300", "hide");
    await controller.idle();

    expect(collapsed(t)).toBe(true);
    expect(t.classList.contains("af-collapsed")).toBe(true);
    const ph = t.querySelector("[data-af-owned]")!;
    expect(ph.getAttribute("role")).toBe("group");
    const buttons = [...ph.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).toContain("Reveal");
    expect(buttons).toContain("Keep this post");
    expect(buttons).toContain("Correct filter");

    // Reveal: placeholder gone, class + state removed, children restored.
    [...ph.querySelectorAll("button")].find((b) => b.textContent === "Reveal")!.click();
    expect(t.querySelector("[data-af-owned]")).toBeNull();
    expect(t.classList.contains("af-collapsed")).toBe(false);
    expect(t.getAttribute("data-af-state")).toBeNull();

    // Re-hide through the adapter's real render path, then Keep.
    const snapshot = (await xAdapter.extract(t))!;
    const { makeResult } = await import("./test-utils");
    xAdapter.render(
      t,
      makeResult(snapshot, "hide"),
      { ruleTitle: (id) => id, onKeep, onCorrect: () => {} },
    );
    expect(collapsed(t)).toBe(true);
    const ph2 = t.querySelector("[data-af-owned]")!;
    [...ph2.querySelectorAll("button")].find((b) => b.textContent === "Keep this post")!.click();
    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(onKeep.mock.calls[0]![0].postId).toBe("300");
    expect(t.querySelector("[data-af-owned]")).toBeNull();
    expect(t.classList.contains("af-collapsed")).toBe(false);
    expect(t.getAttribute("data-af-state")).toBeNull();

    // restore() is defensive: removes all owned nodes and the class.
    t.classList.add("af-collapsed");
    const stray = document.createElement("div");
    stray.setAttribute("data-af-owned", "");
    t.appendChild(stray);
    xAdapter.restore(t);
    expect(t.querySelector("[data-af-owned]")).toBeNull();
    expect(t.classList.contains("af-collapsed")).toBe(false);
    controller.stop();
  });

  it("ENABLED_CHANGED false restores all; true re-scans", async () => {
    const { fc, controller } = setup();
    const t1 = makeAppTweet({ id: "401", text: "one" });
    const t2 = makeAppTweet({ id: "402", text: "two" });
    await startWith(controller, [t1, t2]);
    fc.resolve("401", "hide");
    fc.resolve("402", "hide");
    await controller.idle();
    expect(collapsed(t1)).toBe(true);
    expect(collapsed(t2)).toBe(true);

    controller.handleBroadcast({ type: "ENABLED_CHANGED", enabled: false });
    expect(owned()).toBe(0);
    expect(t1.classList.contains("af-collapsed")).toBe(false);
    expect(t2.classList.contains("af-collapsed")).toBe(false);

    controller.handleBroadcast({ type: "ENABLED_CHANGED", enabled: true });
    await controller.idle();
    expect(fc.callsFor("401").length).toBe(2);
    expect(fc.callsFor("402").length).toBe(2);
    controller.stop();
  });

  it("POLICY_CHANGED re-evaluates mounted posts under new revision", async () => {
    const { fc, controller } = setup({ policyRevision: 1 });
    const t = makeAppTweet({ id: "500", text: "reevaluate me" });
    await startWith(controller, [t]);
    fc.resolve("500", "hide");
    await controller.idle();
    expect(collapsed(t)).toBe(true);

    controller.handleBroadcast({ type: "POLICY_CHANGED", revision: 2 });
    await controller.idle();
    const calls = fc.callsFor("500");
    expect(calls.length).toBe(2);
    expect(calls[1]!.policyRevision).toBe(2);
    fc.resolve("500", "hide", 2);
    await controller.idle();
    expect(collapsed(t)).toBe(true);
    controller.stop();
  });

  it("own-mutation guard: placeholder churn does not reschedule", async () => {
    const extractSpy = vi.spyOn(xAdapter, "extract");
    const { fc, controller } = setup();
    const t = makeAppTweet({ id: "600", text: "loop guard" });
    await startWith(controller, [t]);
    fc.resolve("600", "hide");
    await controller.idle();
    const extractCount = extractSpy.mock.calls.length;
    const classifyCount = fc.callsFor("600").length;
    expect(collapsed(t)).toBe(true);

    // Click Reveal (removes owned node), then mutate inside the placeholder
    // while it exists. Re-hide to simulate re-render churn.
    const ph = t.querySelector("[data-af-owned]")!;
    ph.appendChild(document.createElement("span")); // mutation inside owned
    [...ph.querySelectorAll("button")].find((b) => b.textContent === "Reveal")!.click();
    await controller.idle();

    expect(extractSpy.mock.calls.length).toBe(extractCount);
    expect(fc.callsFor("600").length).toBe(classifyCount);
    extractSpy.mockRestore();
    controller.stop();
  });

  it("show result and classify rejection leave the node untouched", async () => {
    const { fc, controller } = setup();
    const t1 = makeAppTweet({ id: "701", text: "keep" });
    const t2 = makeAppTweet({ id: "702", text: "error" });
    await startWith(controller, [t1, t2]);
    fc.resolve("701", "show");
    fc.reject("702", new Error("boom"));
    await controller.idle();
    expect(collapsed(t1)).toBe(false);
    expect(collapsed(t2)).toBe(false);
    expect(owned()).toBe(0);
    controller.stop();
  });

  it("observer starts even when the page boots disabled", async () => {
    const { fc, controller } = setup({ enabled: false });
    const t = makeAppTweet({ id: "800", text: "late enable" });
    await startWith(controller, [t]);
    expect(fc.calls.length).toBe(0);
    controller.handleBroadcast({ type: "ENABLED_CHANGED", enabled: true });
    await controller.idle();
    expect(fc.callsFor("800").length).toBe(1);
    controller.stop();
  });
});
