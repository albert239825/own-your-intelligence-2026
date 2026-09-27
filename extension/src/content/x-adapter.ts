// X (twitter) adapter.
//
// VERIFIED (against sanitized logged-out "lite" DOM samples captured
// 2026-09-27, see fixtures/x-samples/):
//   - posts are <article> elements containing [data-engagement-action] and
//     a[href*="/status/"] (lite DOM has NO data-testid attributes)
//   - post text lives in div[dir="auto"] (spans + mention anchors + plain-text
//     emoji; "Show more" is a <button> inside the text div)
//   - a quoted post is a nested <article> inside [data-timeline-entry][role="link"]
//
// ASSUMED (logged-in React app DOM, not reachable from a logged-out machine):
//   - article[data-testid="tweet"], text in [data-testid="tweetText"]
//   - emoji as img[alt] inside tweetText
//   - quoted tweet inside div[role="link"] with its own tweetText
//   - timestamp link a[href*="/status/"]:has(time)
//   - show-more a[data-testid="tweet-text-show-more-link"]
//   - promoted = [data-testid="placementTracking"] wrapper (treated as normal)
import { EXTRACTOR_VERSION, type PostSnapshot } from "../contracts";
import {
  AF_OWNED,
  contentHash,
  renderCollapsed,
  restoreNode,
  type RenderHandlers,
  type SiteAdapter,
} from "./adapter";

const snapshots = new WeakMap<Element, PostSnapshot>();

export const POST_SEL = 'article[data-testid="tweet"]';
const TEXT_SEL = '[data-testid="tweetText"]';
const LITE_TEXT_SEL = 'div[dir="auto"]';
const STATUS_LINK_SEL = 'a[href*="/status/"]';

/** True when `node` is inside our own injected UI (placeholder/style). */
export function isOwned(node: Node): boolean {
  const el = node instanceof Element ? node : node.parentElement;
  return !!el?.closest?.(`[${AF_OWNED}]`);
}

/**
 * True when `el` is a post article in either DOM flavour, and is not a quoted
 * post nested inside another post article.
 */
export function isPostNode(el: Element): boolean {
  const looksLikePost =
    el.matches(POST_SEL) ||
    (el.tagName === "ARTICLE" &&
      !!el.querySelector("[data-engagement-action]") &&
      !!el.querySelector(STATUS_LINK_SEL));
  if (!looksLikePost) return false;
  return el.parentElement?.closest("article") == null;
}

export function discover(root: ParentNode | Element): Element[] {
  const found: Element[] = [...root.querySelectorAll("article")]
    .filter(isPostNode)
    .filter((n) => !isOwned(n));
  if (root instanceof Element && isPostNode(root) && !isOwned(root)) {
    found.unshift(root);
  }
  return found;
}

/**
 * True when `el` sits inside a quoted post relative to `node`: inside a nested
 * <article> (lite quote) or a div[role="link"] (app quote).
 */
export function isInsideQuote(el: Element, node: Element): boolean {
  // Start at the parent so an <a role="link"> status anchor doesn't match itself.
  const c = el.parentElement?.closest('article, div[role="link"]') ?? null;
  return c !== null && c !== node;
}

export function postIdFrom(node: Element): { postId: string; url: string } | null {
  const candidates = [...node.querySelectorAll<HTMLAnchorElement>(STATUS_LINK_SEL)].filter(
    (a) => !isInsideQuote(a, node),
  );
  // Prefer the timestamp link (contains <time> in the app DOM); fall back to
  // the first candidate (lite DOM has no <time>; photo links still carry the
  // status id before any /photo/N suffix).
  const link = candidates.find((a) => a.querySelector("time")) ?? candidates[0];
  if (!link) return null;
  const m = link.getAttribute("href")?.match(/\/status\/(\d+)/);
  if (!m) return null;
  return { postId: m[1]!, url: link.href };
}

/**
 * Visible text of an element: text nodes concatenated, emoji imgs contribute
 * their alt, buttons and show-more anchors skipped, our own UI skipped.
 * Whitespace runs collapse to single spaces; newlines are preserved.
 */
export function textOf(el: Element): string {
  let out = "";
  const walk = (n: Node): void => {
    if (n instanceof Text) {
      out += n.data;
      return;
    }
    if (!(n instanceof Element)) return;
    if (n.hasAttribute(AF_OWNED)) return;
    if (n.tagName === "IMG") {
      out += (n as HTMLImageElement).alt ?? "";
      return;
    }
    if (n.tagName === "BUTTON") return;
    if (
      n.tagName === "A" &&
      ((n.getAttribute("data-testid") ?? "").includes("show-more") ||
        n.textContent?.trim() === "Show more")
    ) {
      return;
    }
    for (const c of n.childNodes) walk(c);
  };
  walk(el);
  return out.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

/**
 * Locate the main-text element and the quoted-text element. App DOM uses
 * [data-testid="tweetText"]; lite DOM uses div[dir="auto"] (only ones wrapping
 * a <span>, to skip stray dir=auto containers).
 */
export function textNodes(node: Element): { main: Element | null; quote: Element | null } {
  let candidates: Element[];
  const tweetTexts = [...node.querySelectorAll(TEXT_SEL)];
  if (tweetTexts.length) {
    candidates = tweetTexts;
  } else if (!node.matches(POST_SEL)) {
    candidates = [...node.querySelectorAll(LITE_TEXT_SEL)].filter((d) =>
      d.querySelector("span"),
    );
  } else {
    candidates = [];
  }
  return {
    main: candidates.find((el) => !isInsideQuote(el, node)) ?? null,
    quote: candidates.find((el) => isInsideQuote(el, node)) ?? null,
  };
}

/**
 * Sync fingerprint of what a node currently shows. Changes when X recycles
 * the article for a different post or edits its text; used for stale-result
 * rejection and recycle detection.
 */
export function fingerprint(node: Element): string | null {
  const id = postIdFrom(node);
  if (!id) return null;
  const { main, quote } = textNodes(node);
  const text = main ? textOf(main) : "";
  const quoteText = quote ? textOf(quote) : "";
  return `${id.postId}\u0000${text}\u0000${quoteText}`;
}

export const xAdapter: SiteAdapter = {
  discover,

  fingerprint,

  async extract(node) {
    try {
      if (isOwned(node)) return null;
      const id = postIdFrom(node);
      if (!id) return null;
      const { main, quote } = textNodes(node);
      const text = main ? textOf(main) : "";
      const quoted = quote ? textOf(quote) : "";
      const quoteText = quoted && quoted !== text ? quoted : undefined;
      const snapshot: PostSnapshot = {
        platform: "x",
        postId: id.postId,
        url: id.url,
        contentHash: await contentHash(text, quoteText),
        text,
        quoteText,
        complete: text.length > 0,
        extractorVersion: EXTRACTOR_VERSION,
      };
      snapshots.set(node, snapshot);
      return snapshot;
    } catch {
      return null;
    }
  },

  render(node, result, handlers: RenderHandlers) {
    const snapshot = snapshots.get(node);
    if (!snapshot) return;
    if (result.disposition === "hide" || result.disposition === "uncertain") {
      renderCollapsed(node, result, snapshot, handlers);
    } else {
      restoreNode(node);
    }
  },

  restore(node) {
    restoreNode(node);
  },

  dispose() {
    // WeakMap: nothing to clear explicitly.
  },
};
