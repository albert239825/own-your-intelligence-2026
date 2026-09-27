import {
  EXTRACTOR_VERSION,
  type DecisionResult,
  type Feedback,
  type PostSnapshot,
} from "../contracts";

export interface RenderHandlers {
  /** Display title for a rule id (from current policy). */
  ruleTitle: (ruleId: string) => string;
  /** "Keep this post" -> SET_OVERRIDE. */
  onKeep: (snapshot: PostSnapshot) => void;
  /** "Correct filter" confirmed -> SAVE_FEEDBACK. */
  onCorrect: (feedback: Omit<Feedback, "feedbackId" | "createdAt">) => void;
  /** Post was manually made visible (Reveal, or Keep which is a permanent
   *  override): controller remembers so a re-inserted copy stays visible. */
  onReveal?: (snapshot: PostSnapshot) => void;
}

export interface SiteAdapter {
  discover(root: ParentNode): Element[];
  /** Sync fingerprint (postId + raw text + quoteText) of what a node shows,
   *  or null when it has no postId. Used for recycle/stale detection. */
  fingerprint(node: Element): string | null;
  extract(node: Element): Promise<PostSnapshot | null>;
  render(node: Element, result: DecisionResult, handlers: RenderHandlers): void;
  restore(node: Element): void;
  dispose(): void;
}

export const AF_OWNED = "data-af-owned";
export const AF_COLLAPSED = "af-collapsed";

let styleInjected = false;
export function ensureStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement("style");
  style.setAttribute(AF_OWNED, "");
  style.textContent = `
    .${AF_COLLAPSED} > *:not([${AF_OWNED}]) { display: none !important; }
    [${AF_OWNED}].af-placeholder {
      border: 1px solid #536471; border-radius: 12px; padding: 12px 16px;
      margin: 8px 12px; font: 14px/1.4 system-ui, sans-serif; color: #e7e9ea;
      background: #16181c;
    }
    [${AF_OWNED}] .af-rules { font-weight: 600; margin-bottom: 4px; }
    [${AF_OWNED}] .af-note { color: #71767b; font-size: 12px; margin-bottom: 8px; }
    [${AF_OWNED}] button {
      margin-right: 8px; padding: 4px 12px; border-radius: 9999px;
      border: 1px solid #536471; background: transparent; color: #1d9bf0;
      cursor: pointer; font: inherit;
    }
    [${AF_OWNED}] .af-correct-panel { margin-top: 8px; }
    [${AF_OWNED}] .af-correct-panel textarea {
      display: block; width: 95%; margin: 6px 0; min-height: 48px;
      background: #000; color: #e7e9ea; border: 1px solid #536471; border-radius: 8px;
    }
  `;
  document.documentElement.appendChild(style);
}

/** sha-256 hex of normalized text + quoteText. */
export async function contentHash(text: string, quoteText?: string): Promise<string> {
  const normalized = `${text}\u0000${quoteText ?? ""}`.replace(/\s+/g, " ").trim();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Collapse a post: hide its children, insert our placeholder showing the
 * rule titles that fired, with Reveal / Keep this post / Correct filter.
 */
export function renderCollapsed(
  node: Element,
  result: DecisionResult,
  snapshot: PostSnapshot,
  handlers: RenderHandlers,
): void {
  restoreNode(node);
  ensureStyle();

  const placeholder = document.createElement("div");
  placeholder.setAttribute(AF_OWNED, "");
  placeholder.setAttribute("role", "group");
  placeholder.setAttribute("aria-label", "Attention Filter placeholder");
  placeholder.className = "af-placeholder";

  const titles = result.causeRuleIds.length
    ? result.causeRuleIds.map((id) => handlers.ruleTitle(id)).join(", ")
    : result.disposition === "uncertain"
      ? "Uncertain — needs review"
      : "Attention Filter";

  const rules = document.createElement("div");
  rules.className = "af-rules";
  rules.textContent = `Hidden: ${titles}`;
  const note = document.createElement("div");
  note.className = "af-note";
  note.textContent = result.disposition === "hide"
    ? "Collapsed by your filter rules."
    : `Disposition: ${result.disposition}`;

  const reveal = document.createElement("button");
  reveal.textContent = "Reveal";
  // UI-only: unhides this render, nothing is learned or stored.
  reveal.addEventListener("click", () => {
    handlers.onReveal?.(snapshot);
    node.classList.remove(AF_COLLAPSED);
    node.removeAttribute("data-af-state");
    placeholder.remove();
  });

  const keep = document.createElement("button");
  keep.textContent = "Keep this post";
  keep.addEventListener("click", () => {
    handlers.onReveal?.(snapshot);
    handlers.onKeep(snapshot);
    node.classList.remove(AF_COLLAPSED);
    node.removeAttribute("data-af-state");
    placeholder.remove();
  });

  const correct = document.createElement("button");
  correct.textContent = "Correct filter";

  const panel = document.createElement("div");
  panel.className = "af-correct-panel";
  panel.hidden = true;

  const mkChoice = (kind: Feedback["kind"], label: string) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", () => {
      panel.dataset.kind = kind;
      textarea.hidden = false;
      submit.hidden = false;
    });
    return b;
  };
  const textarea = document.createElement("textarea");
  textarea.placeholder = "Optional: what should happen instead?";
  textarea.hidden = true;
  const submit = document.createElement("button");
  submit.textContent = "Save correction";
  submit.hidden = true;
  submit.addEventListener("click", () => {
    const kind = (panel.dataset.kind ?? "wrong_classification") as Feedback["kind"];
    handlers.onCorrect({
      postId: snapshot.postId,
      contentHash: snapshot.contentHash,
      text: snapshot.text,
      kind,
      desiredAction: result.disposition === "hide" ? "keep" : "hide",
      ruleId: result.causeRuleIds[0],
      explanation: textarea.value || undefined,
      policyRevision: result.policyRevision,
    });
    panel.hidden = true;
  });

  panel.append(
    mkChoice("wrong_classification", "Wrong classification"),
    mkChoice("change_preference", "Change what I want"),
    textarea,
    submit,
  );
  correct.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
  });

  placeholder.append(rules, note, reveal, keep, correct, panel);
  node.classList.add(AF_COLLAPSED);
  node.setAttribute("data-af-state", "collapsed");
  node.prepend(placeholder);
}

export function restoreNode(node: Element): void {
  node.classList.remove(AF_COLLAPSED);
  node.removeAttribute("data-af-state");
  node.querySelectorAll(`.${AF_COLLAPSED}`).forEach((el) => el.classList.remove(AF_COLLAPSED));
  node.querySelectorAll(`[${AF_OWNED}]`).forEach((el) => el.remove());
}

// ---- fixture adapter ------------------------------------------------------

/**
 * Adapter for fixtures/feed.html: `article[data-post-id]` elements with a
 * `.post-text`, optional `.quote-text`, optional `a.post-link[href]`.
 */
export const fixtureAdapter: SiteAdapter = {
  discover(root) {
    return [...root.querySelectorAll("article[data-post-id]")];
  },

  fingerprint(node) {
    const article = node as HTMLElement;
    const postId = article.dataset.postId;
    if (!postId) return null;
    const text = article.querySelector(".post-text")?.textContent?.trim() ?? "";
    const quoteText = article.querySelector(".quote-text")?.textContent?.trim() ?? "";
    return `${postId}\u0000${text}\u0000${quoteText}`;
  },

  async extract(node) {
    const article = node as HTMLElement;
    const postId = article.dataset.postId;
    const text = article.querySelector(".post-text")?.textContent?.trim();
    if (!postId || !text) return null;
    const quoteText = article.querySelector(".quote-text")?.textContent?.trim() || undefined;
    const url = article.querySelector<HTMLAnchorElement>("a.post-link")?.href;
    const snapshot: PostSnapshot = {
      platform: "x",
      postId,
      url,
      contentHash: await contentHash(text, quoteText),
      text,
      quoteText,
      complete: true,
      extractorVersion: EXTRACTOR_VERSION,
    };
    snapshots.set(node, snapshot);
    return snapshot;
  },

  render(node, result, handlers) {
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

/** extract() results stashed per node so render() can reuse the snapshot. */
const snapshots = new WeakMap<Element, PostSnapshot>();
