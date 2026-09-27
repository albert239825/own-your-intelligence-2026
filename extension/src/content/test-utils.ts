// Shared helpers for jsdom content-script tests. Not a test file.
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DecisionResult, Disposition, PostSnapshot } from "../contracts";

// jsdom doesn't always expose crypto.subtle.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });
}

export function loadSample(name: string): void {
  document.body.innerHTML = readFileSync(
    join(process.cwd(), "fixtures/x-samples", name),
    "utf8",
  );
}

export interface AppTweetSpec {
  id: string;
  user?: string;
  text: string;
  emojiAlts?: string[];
  showMore?: boolean;
  quote?: { id: string; user?: string; text: string };
  bare?: boolean; // article shell with no content
  noText?: boolean; // status link but no tweetText
}

function el(html: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

/** Assumed logged-in app DOM tweet (data-testid markup). */
export function makeAppTweet(spec: AppTweetSpec): HTMLElement {
  const user = spec.user ?? "user";
  if (spec.bare) {
    return el(`<article data-testid="tweet" role="article"><div><div><span></span></div></div></article>`);
  }
  const timeLink = `<a href="/${user}/status/${spec.id}"><time datetime="2026-09-27T10:00:00.000Z">Sep 27</time></a>`;
  if (spec.noText) {
    return el(`<article data-testid="tweet" role="article"><div>${timeLink}</div></article>`);
  }
  const emoji = (spec.emojiAlts ?? []).map((a) => `<img alt="${a}" src="EMOJI">`).join("");
  const showMore = spec.showMore
    ? `<a data-testid="tweet-text-show-more-link" href="/${user}/status/${spec.id}">Show more</a>`
    : "";
  const quote = spec.quote
    ? `<div role="link" tabindex="0">
        <div><a href="/${spec.quote.user ?? "q"}/status/${spec.quote.id}"><time datetime="2026-09-26T09:00:00.000Z">Sep 26</time></a></div>
        <div data-testid="tweetText" dir="auto"><span>${spec.quote.text}</span></div>
      </div>`
    : "";
  return el(`<article data-testid="tweet" role="article">
    <div><a href="/${user}"><img alt="@${user}" src="AVATAR"></a>${timeLink}</div>
    <div data-testid="tweetText" dir="auto"><span>${spec.text}</span>${emoji}${showMore}</div>
    ${quote}
    <div role="group"><div data-testid="reply"></div></div>
  </article>`);
}

/** Verified logged-out lite DOM tweet (no data-testid attributes). */
export function makeLiteTweet(spec: AppTweetSpec): HTMLElement {
  const user = spec.user ?? "user";
  const timeLink = `<a href="/${user}/status/${spec.id}">Sep 15</a>`;
  const quote = spec.quote
    ? `<div data-href="/${spec.quote.user ?? "q"}/status/${spec.quote.id}" data-timeline-entry="" role="link"><article>
        <div><a href="/${spec.quote.user ?? "q"}/status/${spec.quote.id}">Sep 15</a></div>
        <div dir="auto"><span>${spec.quote.text}</span></div>
      </article></div>`
    : "";
  return el(`<article>
    <div><div>${timeLink}</div>
    <div dir="auto"><span>${spec.text}</span>${(spec.emojiAlts ?? []).map((a) => `<span>${a}</span>`).join("")}</div></div>
    ${quote}
    <div><div data-engagement-action="reply"><a aria-label="Reply" href="/${user}/status/${spec.id}"><span>1</span></a></div></div>
  </article>`);
}

export function makeResult(
  snapshot: PostSnapshot,
  disposition: Disposition,
  policyRevision = 1,
): DecisionResult {
  return {
    requestId: `req-${snapshot.postId}`,
    postId: snapshot.postId,
    contentHash: snapshot.contentHash,
    policyRevision,
    modelVersion: "test",
    disposition,
    causeRuleIds: disposition === "hide" ? ["rage_bait"] : [],
    exceptionRuleIds: [],
    probabilities: {},
    source: "model",
    elapsedMs: 1,
  };
}

interface Pending {
  snapshot: PostSnapshot;
  policyRevision: number;
  resolve: (r: DecisionResult) => void;
  reject: (e: unknown) => void;
}

/** Classify stub: records calls, each postId's result is resolved on demand. */
export function fakeClassify() {
  const calls: { snapshot: PostSnapshot; policyRevision: number }[] = [];
  const pending = new Map<string, Pending[]>();
  const classify = (snapshot: PostSnapshot, policyRevision: number) => {
    calls.push({ snapshot, policyRevision });
    return new Promise<DecisionResult>((resolve, reject) => {
      const list = pending.get(snapshot.postId) ?? [];
      list.push({ snapshot, policyRevision, resolve, reject });
      pending.set(snapshot.postId, list);
    });
  };
  return {
    classify,
    calls,
    callsFor(postId: string) {
      return calls.filter((c) => c.snapshot.postId === postId);
    },
    /** Resolve the oldest pending call for postId. */
    resolve(postId: string, disposition: Disposition, policyRevision?: number) {
      const p = pending.get(postId)?.shift();
      if (!p) throw new Error(`no pending classify for ${postId}`);
      p.resolve(makeResult(p.snapshot, disposition, policyRevision ?? p.policyRevision));
    },
    reject(postId: string, e: unknown) {
      const p = pending.get(postId)?.shift();
      if (!p) throw new Error(`no pending classify for ${postId}`);
      p.reject(e);
    },
    pendingCount(postId: string) {
      return pending.get(postId)?.length ?? 0;
    },
  };
}
