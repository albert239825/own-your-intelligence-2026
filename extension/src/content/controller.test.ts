// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";
import { DEFAULT_POLICY, type Policy } from "../contracts";
import { createController, type Controller } from "./controller";
import { xAdapter } from "./x-adapter";
import { fakeClassify, makeAppTweet, makeResult } from "./test-utils";

const policy = (revision: number): Policy => ({ ...DEFAULT_POLICY, revision });

function setup(opts: { enabled?: boolean; policyRevision?: number } = {}) {
  const fc = fakeClassify();
  const onKeep = vi.fn();
  const onCorrect = vi.fn();
  const onHide = vi.fn();
  const onSavePolicy = vi.fn();
  const controller = createController({
    adapter: xAdapter,
    classify: fc.classify,
    getPolicy: () => Promise.resolve(policy(opts.policyRevision ?? 1)),
    getEnabled: () => Promise.resolve(opts.enabled ?? true),
    onKeep,
    onCorrect,
    onHide,
    onSavePolicy,
    log: () => {},
  });
  return { fc, controller, onKeep, onCorrect, onHide, onSavePolicy };
}

const collapsed = (node: Element) => node.getAttribute("data-af-state") === "collapsed";
// Count placeholder UIs only (the injected <style> also carries data-af-owned).
const owned = () => document.querySelectorAll("[data-af-owned].af-placeholder").length;
const bar = (node: Element) => node.querySelector<HTMLElement>(".af-bar")!;
const chip = (node: Element, label: string) =>
  [...node.querySelectorAll<HTMLButtonElement>(".af-chips button")].find(
    (b) => b.textContent === label,
  )!;

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

  it("render/restore: collapsed bar, bar-click reveals in place, keep", async () => {
    const { fc, controller, onKeep, onCorrect } = setup();
    const t = makeAppTweet({ id: "300", text: "hide me" });
    await startWith(controller, [t]);
    fc.resolve("300", "hide");
    await controller.idle();

    expect(collapsed(t)).toBe(true);
    expect(t.classList.contains("af-collapsed")).toBe(true);
    const ph = t.querySelector("[data-af-owned]")!;
    expect(ph.getAttribute("role")).toBe("group");
    // Collapsed: only the one-line bar, chips hidden.
    expect(bar(t).textContent).toBe("Hidden · Rage bait");
    expect(t.querySelector<HTMLElement>(".af-chips")!.hidden).toBe(true);

    // Bar click: expands in place (children visible), chips shown, nothing stored.
    bar(t).click();
    expect(t.classList.contains("af-collapsed")).toBe(false);
    expect(t.getAttribute("data-af-state")).toBe("expanded");
    expect(t.querySelector<HTMLElement>(".af-chips")!.hidden).toBe(false);
    const labels = [...t.querySelectorAll(".af-chips button")].map((b) => b.textContent);
    expect(labels).toEqual(["Keep this post", "Good call", "Change the filter"]);
    expect(onKeep).not.toHaveBeenCalled();
    expect(onCorrect).not.toHaveBeenCalled();

    // Bar click again re-collapses (UI only).
    bar(t).click();
    expect(collapsed(t)).toBe(true);

    // Re-hide through the adapter's real render path, then Keep.
    const snapshot = (await xAdapter.extract(t))!;
    xAdapter.render(
      t,
      makeResult(snapshot, "hide"),
      { ruleTitle: (id) => id, onKeep, onCorrect },
    );
    expect(collapsed(t)).toBe(true);
    bar(t).click();
    chip(t, "Keep this post").click();
    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(onKeep.mock.calls[0]![0].postId).toBe("300");
    expect(onCorrect).toHaveBeenCalledTimes(1);
    expect(onCorrect.mock.calls[0]![0]).toMatchObject({
      kind: "wrong_classification",
      desiredAction: "keep",
      ruleId: "rage_bait",
      postId: "300",
    });
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

    // Mutate inside the placeholder, expand via the bar, then Keep (removes
    // the owned node): none of this may reschedule the post.
    const ph = t.querySelector("[data-af-owned]")!;
    ph.appendChild(document.createElement("span")); // mutation inside owned
    bar(t).click();
    await controller.idle();
    chip(t, "Keep this post").click();
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

  it("virtualizer scroll-back: re-inserted copy re-renders without re-classify; Reveal/Keep stick", async () => {
    const { fc, controller, onKeep } = setup();
    const make = () => makeAppTweet({ id: "900", text: "virtualized" });
    const t1 = make();
    await startWith(controller, [t1]);
    fc.resolve("900", "hide");
    await controller.idle();
    expect(collapsed(t1)).toBe(true);
    const classifyCount = fc.callsFor("900").length;

    // Virtualizer removes the article and inserts a fresh identical node.
    t1.remove();
    const t2 = make();
    document.body.appendChild(t2);
    await controller.idle();
    expect(collapsed(t2)).toBe(true);
    expect(fc.callsFor("900").length).toBe(classifyCount); // no re-classify

    // Bar-click reveal on the fresh copy → key recorded; next re-insert stays visible.
    bar(t2).click();
    t2.remove();
    const t3 = make();
    document.body.appendChild(t3);
    await controller.idle();
    expect(collapsed(t3)).toBe(false);
    expect(t3.querySelector("[data-af-owned]")).toBeNull();

    // Keep variant on a different post: same "stays visible" behaviour.
    const makeK = () => makeAppTweet({ id: "901", text: "kept" });
    const k1 = makeK();
    document.body.appendChild(k1);
    await controller.idle();
    fc.resolve("901", "hide");
    await controller.idle();
    bar(k1).click();
    chip(k1, "Keep this post").click();
    expect(onKeep).toHaveBeenCalledTimes(1);
    k1.remove();
    const k2 = makeK();
    document.body.appendChild(k2);
    await controller.idle();
    expect(collapsed(k2)).toBe(false);
    expect(k2.querySelector("[data-af-owned]")).toBeNull();
    controller.stop();
  });

  it("skeleton article transitions to a post once content arrives", async () => {
    const { fc, controller } = setup();
    const skeleton = makeAppTweet({ id: "unused", text: "unused", bare: true });
    document.body.appendChild(skeleton);
    await controller.start();
    await controller.idle();
    expect(fc.calls.length).toBe(0); // no postId: nothing classified

    // X fills the skeleton in place: status link + tweetText appear.
    skeleton.innerHTML = `
      <div><a href="/user/status/950"><time datetime="2026-09-27T10:00:00.000Z">Sep 27</time></a></div>
      <div data-testid="tweetText" dir="auto"><span>late content</span></div>`;
    await controller.idle();
    expect(fc.callsFor("950").length).toBe(1);
    fc.resolve("950", "hide");
    await controller.idle();
    expect(collapsed(skeleton)).toBe(true);
    controller.stop();
  });

  it("Good call re-collapses with Noted and emits confirm_hide feedback", async () => {
    const { fc, controller, onCorrect, onKeep } = setup();
    const t = makeAppTweet({ id: "1000", text: "good call" });
    await startWith(controller, [t]);
    fc.resolve("1000", "hide");
    await controller.idle();

    bar(t).click();
    expect(collapsed(t)).toBe(false);
    chip(t, "Good call").click();
    expect(collapsed(t)).toBe(true);
    expect(t.classList.contains("af-collapsed")).toBe(true);
    expect(bar(t).textContent).toBe("Hidden · Rage bait · Noted");
    expect(t.querySelector<HTMLElement>(".af-chips")!.hidden).toBe(true);
    expect(onKeep).not.toHaveBeenCalled();
    expect(onCorrect).toHaveBeenCalledTimes(1);
    expect(onCorrect.mock.calls[0]![0]).toMatchObject({
      kind: "confirm_hide",
      desiredAction: "hide",
      ruleId: "rage_bait",
      postId: "1000",
    });

    // Noted persists across a re-expand for this node.
    bar(t).click();
    expect(bar(t).textContent).toBe("Hidden · Rage bait · Noted");

    bar(t).click();
    expect(collapsed(t)).toBe(true);

    // A re-inserted copy is collapsed (re-collapsing cancels the bar-click reveal).
    t.remove();
    const t2 = makeAppTweet({ id: "1000", text: "good call" });
    document.body.appendChild(t2);
    await controller.idle();
    expect(collapsed(t2)).toBe(true);
    controller.stop();
  });

  it("Hide on a shown post: pill menu collapses with Noted, emits override hide + feedback", async () => {
    const { fc, controller, onHide, onCorrect } = setup();
    const t = makeAppTweet({ id: "1100", text: "looks fine" });
    await startWith(controller, [t]);
    fc.resolve("1100", "show");
    await controller.idle();

    expect(collapsed(t)).toBe(false);
    const pill = t.querySelector<HTMLButtonElement>("[data-af-owned].af-hide-pill")!;
    expect(pill.textContent).toBe("Hide");
    expect(t.querySelector(".af-menu")).toBeNull();

    pill.click();
    const menu = t.querySelector<HTMLElement>("[data-af-owned].af-menu")!;
    const entries = [...menu.querySelectorAll("button")].map((b) => b.textContent);
    // Enabled hide rules only (exception rule excluded) + Other free text.
    expect(entries).toEqual(["Rage bait", "Hype", "Engagement farming"]);
    expect(menu.querySelector<HTMLInputElement>("input")!.placeholder).toBe("Other…");

    [...menu.querySelectorAll("button")].find((b) => b.textContent === "Hype")!.click();
    expect(collapsed(t)).toBe(true);
    expect(bar(t).textContent).toBe("Hidden · Hype · Noted");
    expect(t.querySelector(".af-menu")).toBeNull();
    expect(t.querySelector(".af-hide-pill")).toBeNull();
    expect(onHide).toHaveBeenCalledTimes(1);
    expect(onHide.mock.calls[0]![0].postId).toBe("1100");
    expect(onCorrect).toHaveBeenCalledTimes(1);
    expect(onCorrect.mock.calls[0]![0]).toMatchObject({
      kind: "wrong_classification",
      desiredAction: "hide",
      ruleId: "hype",
      postId: "1100",
    });
    // No classify round-trip was needed.
    expect(fc.callsFor("1100").length).toBe(1);

    // Other… on a second shown post: ruleId undefined, text in explanation.
    const u = makeAppTweet({ id: "1101", text: "other reason" });
    document.body.appendChild(u);
    await controller.idle();
    fc.resolve("1101", "show");
    await controller.idle();
    u.querySelector<HTMLButtonElement>(".af-hide-pill")!.click();
    const other = u.querySelector<HTMLInputElement>(".af-menu input")!;
    other.value = "spoilers";
    other.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(collapsed(u)).toBe(true);
    expect(bar(u).textContent).toBe("Hidden · Other · Noted");
    expect(onHide).toHaveBeenCalledTimes(2);
    expect(onCorrect.mock.calls[1]![0]).toMatchObject({
      kind: "wrong_classification",
      desiredAction: "hide",
      ruleId: undefined,
      explanation: "spoilers",
    });
    controller.stop();
  });

  it("Change the filter: save sends the policy update and logs change_preference", async () => {
    const { fc, controller, onSavePolicy, onCorrect } = setup({ policyRevision: 3 });
    const t = makeAppTweet({ id: "1200", text: "tune me" });
    await startWith(controller, [t]);
    fc.resolve("1200", "hide");
    await controller.idle();

    bar(t).click();
    chip(t, "Change the filter").click();
    const panel = t.querySelector<HTMLElement>(".af-panel")!;
    expect(panel.hidden).toBe(false);
    expect(panel.querySelector(".af-panel-title")!.textContent).toBe("Rage bait");
    const ta = panel.querySelector<HTMLTextAreaElement>("textarea")!;
    const slider = panel.querySelector<HTMLInputElement>("input[type=range]")!;
    const rageBait = DEFAULT_POLICY.rules.find((r) => r.id === "rage_bait")!;
    expect(ta.value).toBe(rageBait.instruction);
    expect(slider.min).toBe("0.3");
    expect(slider.max).toBe("0.99");
    expect(slider.step).toBe("0.01");
    expect(Number(slider.value)).toBe(rageBait.hideThreshold);

    // Cancel closes without saving.
    [...panel.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!.click();
    expect(panel.hidden).toBe(true);
    expect(onSavePolicy).not.toHaveBeenCalled();

    chip(t, "Change the filter").click();
    const ta2 = t.querySelector<HTMLTextAreaElement>(".af-panel textarea")!;
    const slider2 = t.querySelector<HTMLInputElement>(".af-panel input[type=range]")!;
    ta2.value = "Is this post needlessly insulting?";
    slider2.value = "0.85";
    slider2.dispatchEvent(new Event("input"));
    [...t.querySelectorAll<HTMLButtonElement>(".af-panel button")]
      .find((b) => b.textContent === "Save")!
      .click();

    expect(onSavePolicy).toHaveBeenCalledTimes(1);
    const next: Policy = onSavePolicy.mock.calls[0]![0];
    expect(next.revision).toBe(4);
    expect(next.schemaVersion).toBe(1);
    const saved = next.rules.find((r) => r.id === "rage_bait")!;
    expect(saved.instruction).toBe("Is this post needlessly insulting?");
    expect(saved.hideThreshold).toBe(0.85);
    // Other rules untouched.
    expect(next.rules.filter((r) => r.id !== "rage_bait")).toEqual(
      DEFAULT_POLICY.rules.filter((r) => r.id !== "rage_bait"),
    );
    expect(onCorrect).toHaveBeenCalledTimes(1);
    expect(onCorrect.mock.calls[0]![0]).toMatchObject({
      kind: "change_preference",
      ruleId: "rage_bait",
      policyRevision: 3,
    });
    expect(t.querySelector<HTMLElement>(".af-panel")!.hidden).toBe(true);
    controller.stop();
  });

  it("uncertain disposition: bar reads Hidden · Uncertain, no Change chip", async () => {
    const { fc, controller } = setup();
    const t = makeAppTweet({ id: "1300", text: "unsure" });
    await startWith(controller, [t]);
    fc.resolve("1300", "uncertain");
    await controller.idle();
    expect(collapsed(t)).toBe(true);
    expect(bar(t).textContent).toBe("Hidden · Uncertain");
    bar(t).click();
    expect(chip(t, "Change the filter").hidden).toBe(true);
    expect(chip(t, "Good call").hidden).toBe(false);
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
