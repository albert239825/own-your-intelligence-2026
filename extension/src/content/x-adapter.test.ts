// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { loadSample } from "./test-utils";
import { discover, fingerprint, isInsideQuote, postIdFrom, xAdapter } from "./x-adapter";

beforeEach(() => {
  document.body.innerHTML = "";
});

async function extractAll() {
  const nodes = discover(document);
  const snaps = [];
  for (const n of nodes) snaps.push(await xAdapter.extract(n));
  return { nodes, snaps };
}

describe("xAdapter on verified lite DOM (logged-out samples)", () => {
  it("discovers and extracts the status page's 3 posts", async () => {
    loadSample("lite-status-page.html");
    const { snaps } = await extractAll();
    expect(snaps.map((s) => s?.postId)).toEqual([
      "2103610284464316469",
      "2103610619266208112",
      "2103655115227844900",
    ]);
    expect(snaps[0]!.text.startsWith("With @BoeingSpace,")).toBe(true);
    expect(snaps[1]!.text.endsWith("👉")).toBe(true);
    for (const s of snaps) {
      expect(s).not.toBeNull();
      expect(s!.complete).toBe(true);
    }
  });

  it("extracts quote posts and skips the nested article", async () => {
    loadSample("lite-profile-quote.html");
    const { nodes, snaps } = await extractAll();
    const ids = snaps.map((s) => s?.postId);
    expect(ids).toContain("2099893430763622420");
    // The quoted article (2099890276315848743) is not discovered as a post.
    expect(ids).not.toContain("2099890276315848743");
    const quote = snaps[ids.indexOf("2099893430763622420")]!;
    expect(quote.text).toBe("good bot");
    expect(quote.quoteText?.startsWith("Three SpaceXAI employees")).toBe(true);
    expect(quote.quoteText).not.toContain("Show more");
    expect(nodes.length).toBe(snaps.length);
  });
});

describe("xAdapter on real logged-in Home DOM", () => {
  it("discovers all 8 posts with ids, text, and correct quote detection", async () => {
    loadSample("home-logged-in.html");
    const { nodes, snaps } = await extractAll();
    expect(nodes.length).toBe(8);
    expect(snaps.every((s) => s !== null)).toBe(true);
    for (const s of snaps) {
      expect(s!.postId).toMatch(/^\d{19}$/);
      expect(s!.complete).toBe(true);
      expect(s!.text.length).toBeGreaterThan(0);
    }
    // 3rd and 5th articles (order in file) are quote posts; the rest are not.
    const hasQuote = snaps.map((s) => s!.quoteText !== undefined);
    expect(hasQuote).toEqual([false, false, true, false, true, false, false, false]);
    // Regression: the timestamp anchor is <a role="link">; matching self via
    // closest() used to mark it "inside a quote" and postIdFrom returned null.
    const first = nodes[0]!;
    const timeAnchor = [...first.querySelectorAll("a")].find((a) => a.querySelector("time"))!;
    expect(timeAnchor.getAttribute("role")).toBe("link");
    expect(isInsideQuote(timeAnchor, first)).toBe(false);
    expect(postIdFrom(first)).not.toBeNull();
  });
});

describe("xAdapter on assumed app DOM (data-testid)", () => {
  it("extracts emoji alt, skips show-more link, reads quote", async () => {
    loadSample("app-tweet.assumed.html");
    const { nodes, snaps } = await extractAll();
    const byId = new Map(snaps.map((s) => [s?.postId, s]));

    const emoji = byId.get("1001")!;
    expect(emoji.text).toContain("🚀");
    expect(emoji.text).not.toContain("Show more");

    const quoted = byId.get("2002")!;
    expect(quoted.text).toBe("worth reading");
    expect(quoted.quoteText).toBe("the quoted tweet body");

    // Skeleton with no status link → extract returns null (asserted below).
    // Skeleton with a status link but no tweetText → incomplete.
    const noText = byId.get("4004")!;
    expect(noText.complete).toBe(false);
    expect(noText.text).toBe("");

    // Promoted wrapper → normal snapshot.
    const promoted = byId.get("5005")!;
    expect(promoted.text).toBe("Try our new thing");
    expect(promoted.complete).toBe(true);

    // Bare skeleton article is still discovered (isPostNode matches POST_SEL),
    // but extract returns null (no postId).
    expect(nodes.length).toBe(5);
    expect(snaps.filter((s) => s === null).length).toBe(1);
  });

  it("fingerprint changes with content, stable across re-renders", async () => {
    loadSample("app-tweet.assumed.html");
    const node = discover(document)[0]!;
    const fp1 = fingerprint(node);
    expect(fp1).not.toBeNull();
    // Mutate text: fingerprint must change.
    node.querySelector('[data-testid="tweetText"] span')!.textContent = "edited";
    const fp2 = fingerprint(node);
    expect(fp2).not.toBe(fp1);
    // Re-render identical content → equal fingerprints.
    node.querySelector('[data-testid="tweetText"] span')!.textContent =
      "Shipping the filter today ";
    // note: original span text was "Shipping the filter today "
    expect(fingerprint(node)).toBe(fp1);
  });
});
