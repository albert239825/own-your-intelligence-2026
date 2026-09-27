import {
  EXTRACTOR_VERSION,
  type DecisionResult,
  type Feedback,
  type Policy,
  type PostSnapshot,
} from "../contracts";

export type FeedbackDraft = Omit<Feedback, "feedbackId" | "createdAt">;

export interface RenderHandlers {
  /** Display title for a rule id (from current policy). */
  ruleTitle: (ruleId: string) => string;
  /** "Keep this post" -> SET_OVERRIDE keep. */
  onKeep: (snapshot: PostSnapshot) => void;
  /** Any feedback chip confirmed -> SAVE_FEEDBACK. */
  onCorrect: (feedback: FeedbackDraft) => void;
  /** Post was manually made visible (bar click, or Keep which is a permanent
   *  override): controller remembers so a re-inserted copy stays visible. */
  onReveal?: (snapshot: PostSnapshot) => void;
  /** Post was collapsed by the user (Good call / Hide): controller forgets
   *  any reveal and caches `result` so a re-inserted copy re-collapses. */
  onCollapse?: (snapshot: PostSnapshot, result: DecisionResult) => void;
  /** "Hide" on a shown post -> SET_OVERRIDE hide. */
  onHide?: (snapshot: PostSnapshot) => void;
  /** Current policy, for the Hide menu and the Change-the-filter panel. */
  policy?: () => Policy | undefined;
  /** "Change the filter" saved -> SAVE_POLICY (same path as the options page). */
  onSavePolicy?: (policy: Policy) => void;
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
export const AF_HOST = "af-host";

let styleInjected = false;
export function ensureStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement("style");
  style.setAttribute(AF_OWNED, "");
  style.textContent = `
    .${AF_COLLAPSED} > *:not([${AF_OWNED}]) { display: none !important; }
    .${AF_HOST} { position: relative; }
    [${AF_OWNED}].af-placeholder {
      margin: 8px 12px; font: 13px/1.4 system-ui, sans-serif; color: inherit;
    }
    [${AF_OWNED}] .af-bar {
      display: block; width: 100%; box-sizing: border-box; text-align: left;
      padding: 8px 14px; border-radius: 12px; cursor: pointer; font: inherit;
      color: inherit; opacity: 0.75;
      border: 1px solid rgba(128,128,128,0.45); background: rgba(128,128,128,0.08);
    }
    [${AF_OWNED}] .af-bar:hover { opacity: 1; }
    [${AF_OWNED}] .af-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
    [${AF_OWNED}] .af-chips button, [${AF_OWNED}] .af-panel button, [${AF_OWNED}] .af-menu button {
      padding: 3px 10px; border-radius: 9999px; cursor: pointer; font: inherit; font-size: 12px;
      border: 1px solid rgba(128,128,128,0.45); background: transparent; color: #1d9bf0;
    }
    [${AF_OWNED}] .af-panel {
      margin-top: 8px; padding: 10px 12px; border-radius: 12px;
      border: 1px solid rgba(128,128,128,0.45);
    }
    [${AF_OWNED}] .af-panel .af-panel-title { font-weight: 600; margin-bottom: 6px; }
    [${AF_OWNED}] .af-panel textarea {
      display: block; width: 100%; box-sizing: border-box; margin: 4px 0 8px; min-height: 56px;
      font: inherit; font-size: 12px; color: inherit; background: rgba(128,128,128,0.08);
      border: 1px solid rgba(128,128,128,0.45); border-radius: 8px; padding: 6px;
    }
    [${AF_OWNED}] .af-panel label { display: block; font-size: 12px; opacity: 0.8; }
    [${AF_OWNED}] .af-panel input[type=range] { width: 100%; margin: 4px 0 8px; }
    [${AF_OWNED}] .af-panel .af-actions { display: flex; gap: 6px; }
    [${AF_OWNED}].af-hide-pill {
      position: absolute; top: 6px; right: 8px; z-index: 5; padding: 1px 8px;
      border-radius: 9999px; font: 11px/1.5 system-ui, sans-serif; cursor: pointer;
      color: inherit; opacity: 0.45; background: rgba(128,128,128,0.15);
      border: 1px solid rgba(128,128,128,0.4);
    }
    [${AF_OWNED}].af-hide-pill:hover, [${AF_OWNED}].af-hide-pill[aria-expanded="true"] { opacity: 1; }
    [${AF_OWNED}].af-menu {
      position: absolute; top: 30px; right: 8px; z-index: 6; min-width: 180px;
      display: flex; flex-direction: column; gap: 4px; padding: 8px;
      border-radius: 12px; font: 13px/1.4 system-ui, sans-serif; color: inherit;
      background: #16181c; border: 1px solid rgba(128,128,128,0.45);
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    }
    @media (prefers-color-scheme: light) { [${AF_OWNED}].af-menu { background: #fff; } }
    [${AF_OWNED}].af-menu button { text-align: left; }
    [${AF_OWNED}].af-menu input {
      font: inherit; font-size: 12px; padding: 4px 8px; border-radius: 8px; color: inherit;
      background: rgba(128,128,128,0.08); border: 1px solid rgba(128,128,128,0.45);
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

/** Nodes the user confirmed ("Good call" / "Hide"): bar shows "· Noted" while mounted. */
const noted = new WeakSet<Element>();

function mkButton(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function feedbackFor(
  snapshot: PostSnapshot,
  result: DecisionResult,
  kind: Feedback["kind"],
  desiredAction: Feedback["desiredAction"],
  extra: { ruleId?: string; explanation?: string } = {},
): FeedbackDraft {
  return {
    postId: snapshot.postId,
    contentHash: snapshot.contentHash,
    text: snapshot.text,
    kind,
    desiredAction,
    ruleId: "ruleId" in extra ? extra.ruleId : result.causeRuleIds[0],
    explanation: extra.explanation,
    policyRevision: result.policyRevision,
  };
}

/**
 * Collapse a post: hide its children behind a one-line bar
 * (`Hidden · <rule> [· Noted]`). Clicking the bar expands the post in place
 * and shows the Keep / Good call / Change the filter chips.
 */
export function renderCollapsed(
  node: Element,
  result: DecisionResult,
  snapshot: PostSnapshot,
  handlers: RenderHandlers,
): void {
  clearOwned(node);
  ensureStyle();

  const placeholder = document.createElement("div");
  placeholder.setAttribute(AF_OWNED, "");
  placeholder.setAttribute("role", "group");
  placeholder.setAttribute("aria-label", "Attention Filter placeholder");
  placeholder.className = "af-placeholder";

  const titles = result.causeRuleIds.length
    ? result.causeRuleIds.map((id) => handlers.ruleTitle(id)).join(", ")
    : result.disposition === "uncertain"
      ? "Uncertain"
      : "Other";
  const barText = () =>
    ["Hidden", titles, ...(noted.has(node) ? ["Noted"] : [])].join(" · ");

  const bar = document.createElement("button");
  bar.type = "button";
  bar.className = "af-bar";
  bar.setAttribute("aria-expanded", "false");
  bar.textContent = barText();

  const chips = document.createElement("div");
  chips.className = "af-chips";
  chips.hidden = true;

  const setCollapsed = (collapsed: boolean) => {
    node.classList.toggle(AF_COLLAPSED, collapsed);
    node.setAttribute("data-af-state", collapsed ? "collapsed" : "expanded");
    bar.setAttribute("aria-expanded", String(!collapsed));
    chips.hidden = collapsed;
    if (collapsed) panel.hidden = true;
  };

  // Bar click: UI-only reveal in place (or re-collapse), nothing stored.
  bar.addEventListener("click", () => {
    const expanded = node.getAttribute("data-af-state") === "expanded";
    if (expanded) handlers.onCollapse?.(snapshot, result);
    else handlers.onReveal?.(snapshot);
    setCollapsed(expanded);
  });

  const keep = mkButton("Keep this post", () => {
    handlers.onReveal?.(snapshot);
    handlers.onKeep(snapshot);
    handlers.onCorrect(feedbackFor(snapshot, result, "wrong_classification", "keep"));
    clearOwned(node);
  });

  const goodCall = mkButton("Good call", () => {
    handlers.onCorrect(feedbackFor(snapshot, result, "confirm_hide", "hide"));
    noted.add(node);
    handlers.onCollapse?.(snapshot, result);
    bar.textContent = barText();
    setCollapsed(true);
  });

  const panel = document.createElement("div");
  panel.className = "af-panel";
  panel.hidden = true;

  const ruleId = result.causeRuleIds[0];
  const rule = ruleId ? handlers.policy?.()?.rules.find((r) => r.id === ruleId) : undefined;
  const change = mkButton("Change the filter", () => {
    if (!rule) return;
    if (!panel.hidden) {
      panel.hidden = true;
      return;
    }
    panel.replaceChildren();
    const title = document.createElement("div");
    title.className = "af-panel-title";
    title.textContent = rule.title;
    const textarea = document.createElement("textarea");
    textarea.value = rule.instruction;
    const label = document.createElement("label");
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0.3";
    slider.max = "0.99";
    slider.step = "0.01";
    slider.value = String(rule.hideThreshold ?? 0.7);
    const labelText = () => `Hide when confidence ≥ ${Number(slider.value).toFixed(2)}`;
    label.textContent = labelText();
    slider.addEventListener("input", () => (label.textContent = labelText()));
    const actions = document.createElement("div");
    actions.className = "af-actions";
    const save = mkButton("Save", () => {
      const policy = handlers.policy?.();
      if (!policy) return;
      const instruction = textarea.value.trim() || rule.instruction;
      const hideThreshold = Number(slider.value);
      const next: Policy = {
        ...policy,
        revision: policy.revision + 1,
        rules: policy.rules.map((r) =>
          r.id === rule.id ? { ...r, instruction, hideThreshold } : r,
        ),
      };
      handlers.onCorrect(
        feedbackFor(snapshot, result, "change_preference", "keep", {
          ruleId: rule.id,
          explanation: `instruction: ${instruction}\nthreshold: ${hideThreshold.toFixed(2)}`,
        }),
      );
      handlers.onSavePolicy?.(next);
      panel.hidden = true;
    });
    const cancel = mkButton("Cancel", () => (panel.hidden = true));
    actions.append(save, cancel);
    panel.append(title, textarea, label, slider, actions);
    panel.hidden = false;
  });
  if (!rule) change.hidden = true;

  chips.append(keep, goodCall, change);
  placeholder.append(bar, chips, panel);
  setCollapsed(true);
  node.prepend(placeholder);
}

/**
 * Shown post: add a small "Hide" pill in the top-right corner. Its menu lists
 * every enabled hide rule plus "Other…"; choosing one collapses the post with
 * `Hidden · <rule> · Noted` and stores an exact override + feedback.
 */
export function renderShown(
  node: Element,
  result: DecisionResult,
  snapshot: PostSnapshot,
  handlers: RenderHandlers,
): void {
  clearOwned(node);
  ensureStyle();
  node.classList.add(AF_HOST);

  const pill = document.createElement("button");
  pill.type = "button";
  pill.setAttribute(AF_OWNED, "");
  pill.className = "af-hide-pill";
  pill.textContent = "Hide";
  pill.setAttribute("aria-haspopup", "menu");
  pill.setAttribute("aria-expanded", "false");

  let menu: HTMLElement | null = null;
  const closeMenu = () => {
    menu?.remove();
    menu = null;
    pill.setAttribute("aria-expanded", "false");
  };

  const hideAs = (ruleId: string | undefined, explanation?: string) => {
    const hidden: DecisionResult = {
      ...result,
      disposition: "hide",
      causeRuleIds: ruleId ? [ruleId] : [],
      exceptionRuleIds: [],
      source: "override",
    };
    handlers.onHide?.(snapshot);
    handlers.onCorrect(
      feedbackFor(snapshot, result, "wrong_classification", "hide", { ruleId, explanation }),
    );
    noted.add(node);
    handlers.onCollapse?.(snapshot, hidden);
    renderCollapsed(node, hidden, snapshot, handlers);
  };

  pill.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu) {
      closeMenu();
      return;
    }
    menu = document.createElement("div");
    menu.setAttribute(AF_OWNED, "");
    menu.setAttribute("role", "menu");
    menu.className = "af-menu";
    menu.addEventListener("click", (ev) => ev.stopPropagation());
    const rules = (handlers.policy?.()?.rules ?? []).filter(
      (r) => r.enabled && r.hideThreshold !== undefined,
    );
    for (const r of rules) menu.append(mkButton(r.title, () => hideAs(r.id)));
    const other = document.createElement("input");
    other.type = "text";
    other.placeholder = "Other…";
    other.setAttribute("aria-label", "Other reason");
    other.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") hideAs(undefined, other.value.trim() || undefined);
      if (ev.key === "Escape") closeMenu();
    });
    menu.append(other);
    node.append(menu);
    pill.setAttribute("aria-expanded", "true");
  });

  node.prepend(pill);
}

function clearOwned(node: Element): void {
  node.classList.remove(AF_COLLAPSED, AF_HOST);
  node.removeAttribute("data-af-state");
  node.querySelectorAll(`.${AF_COLLAPSED}`).forEach((el) => el.classList.remove(AF_COLLAPSED));
  node.querySelectorAll(`[${AF_OWNED}]`).forEach((el) => el.remove());
}

export function restoreNode(node: Element): void {
  clearOwned(node);
  noted.delete(node);
}

/** Shared render dispatch for adapters: collapse hide/uncertain, pill on show. */
export function renderDecision(
  node: Element,
  result: DecisionResult,
  snapshot: PostSnapshot,
  handlers: RenderHandlers,
): void {
  if (result.disposition === "hide" || result.disposition === "uncertain") {
    renderCollapsed(node, result, snapshot, handlers);
  } else if (result.disposition === "show") {
    renderShown(node, result, snapshot, handlers);
  } else {
    restoreNode(node);
  }
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
    renderDecision(node, result, snapshot, handlers);
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
