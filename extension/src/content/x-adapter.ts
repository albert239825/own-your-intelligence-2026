// X (twitter) adapter.
// WARNING: all selectors below are UNVERIFIED — picked from public knowledge
// of X's DOM (data-testid attributes). X reshuffles markup frequently; verify
// against a live logged-in feed before demo (ARCHITECTURE §6, Gate C).
import { EXTRACTOR_VERSION, type PostSnapshot } from "../contracts";
import {
  contentHash,
  renderCollapsed,
  restoreNode,
  type RenderHandlers,
  type SiteAdapter,
} from "./adapter";

const snapshots = new WeakMap<Element, PostSnapshot>();

// UNVERIFIED selectors
const POST_SEL = 'article[data-testid="tweet"]';
const TEXT_SEL = '[data-testid="tweetText"]';
const STATUS_LINK_SEL = 'a[href*="/status/"]';

function postIdFrom(node: Element): string | null {
  const link = node.querySelector<HTMLAnchorElement>(STATUS_LINK_SEL)?.href;
  const m = link?.match(/\/status\/(\d+)/);
  return m?.[1] ?? null;
}

/** Ignore mutations inside our own owned nodes (placeholder UI). */
function isOwned(node: Node): boolean {
  return node instanceof Element && !!node.closest?.("[data-af-owned]");
}

export const xAdapter: SiteAdapter = {
  discover(root) {
    return [...root.querySelectorAll(POST_SEL)].filter((n) => !isOwned(n));
  },

  async extract(node) {
    if (isOwned(node)) return null;
    const postId = postIdFrom(node);
    const text = node.querySelector(TEXT_SEL)?.textContent?.trim();
    if (!postId || !text) return null;
    const quoted = node.querySelector(
      `${POST_SEL} ${TEXT_SEL}`,
    )?.textContent?.trim();
    const quoteText = quoted && quoted !== text ? quoted : undefined;
    const snapshot: PostSnapshot = {
      platform: "x",
      postId,
      url: node.querySelector<HTMLAnchorElement>(STATUS_LINK_SEL)?.href,
      contentHash: await contentHash(text, quoteText),
      text,
      quoteText,
      complete: true,
      extractorVersion: EXTRACTOR_VERSION,
    };
    snapshots.set(node, snapshot);
    return snapshot;
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
