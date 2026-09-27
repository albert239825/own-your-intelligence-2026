import {
  BroadcastSchema,
  type DecisionResult,
  type Policy,
  type PostSnapshot,
} from "../contracts";
import {
  AF_OWNED,
  restoreNode,
  type RenderHandlers,
  type SiteAdapter,
} from "./adapter";
import { PRIORITY, Scheduler, scheduleKey } from "./scheduler";

export interface ControllerDeps {
  adapter: SiteAdapter;
  classify: (snapshot: PostSnapshot, policyRevision: number) => Promise<DecisionResult>;
  getPolicy: () => Promise<Policy | undefined>;
  getEnabled: () => Promise<boolean | undefined>;
  onKeep: RenderHandlers["onKeep"];
  onCorrect: RenderHandlers["onCorrect"];
  onHide?: RenderHandlers["onHide"];
  onSavePolicy?: RenderHandlers["onSavePolicy"];
  doc?: Document; // default document
  win?: Window; // default window
  log?: (...a: unknown[]) => void;
}

export interface Controller {
  /** GET_POLICY/GET_ENABLED, scanAll if enabled, ALWAYS observe doc.body. */
  start(): Promise<void>;
  /** BroadcastSchema.safeParse; ENABLED_CHANGED / POLICY_CHANGED. */
  handleBroadcast(raw: unknown): void;
  /** Schedule key for a node, null when recycled since extract. */
  currentKey(node: Element): string | null;
  /** Disconnect observers, restore all rendered posts. */
  stop(): void;
  /** Test hook: resolves when discovery + extract + classify + render settle. */
  idle(): Promise<void>;
  readonly state: { enabled: boolean; policyRevision: number };
}

export function createController(deps: ControllerDeps): Controller {
  const doc = deps.doc ?? document;
  const win = deps.win ?? window;
  const log = deps.log ?? ((...a: unknown[]) => console.warn("[af]", ...a));
  const adapter = deps.adapter;

  const state = { enabled: true, policyRevision: 0 };
  let policy: Policy | undefined;

  let known = new WeakSet<Element>();
  let nodeInfo = new WeakMap<Element, { key: string; fingerprint: string }>();
  // Rendered results + user-revealed posts, by schedule key: lets a fresh
  // node re-render instantly (or stay revealed) when X's virtualizer swaps
  // article elements on scroll-back.
  let results = new Map<string, DecisionResult>();
  let revealed = new Set<string>();
  const pendingIO = new Set<Element>();
  const pendingTasks = new Set<Promise<unknown>>();
  const discoverQueue = new Set<ParentNode>();
  let discoveryScheduled = false;
  let stopped = false;

  const track = <T>(p: Promise<T>): Promise<T> => {
    pendingTasks.add(p);
    const done = () => pendingTasks.delete(p);
    p.then(done, done);
    return p;
  };

  const handlers: RenderHandlers = {
    ruleTitle: (id) => policy?.rules.find((r) => r.id === id)?.title ?? id,
    onReveal: (s) => revealed.add(scheduleKey(s.postId, s.contentHash)),
    onCollapse: (s, result) => {
      const key = scheduleKey(s.postId, s.contentHash);
      revealed.delete(key);
      results.set(key, result);
    },
    onKeep: deps.onKeep,
    onCorrect: deps.onCorrect,
    onHide: deps.onHide,
    policy: () => policy,
    onSavePolicy: deps.onSavePolicy,
  };

  function currentKey(node: Element): string | null {
    const info = nodeInfo.get(node);
    if (!info || info.key === "") return null;
    return adapter.fingerprint(node) === info.fingerprint ? info.key : null;
  }

  const scheduler = new Scheduler({
    // Not tracked in pendingTasks: idle() must return while a classification
    // is still in flight (that's the normal state of a busy timeline).
    classify: (snapshot) => deps.classify(snapshot, state.policyRevision),
    currentKey,
    currentPolicyRevision: () => state.policyRevision,
    render: (node, result) => {
      const key = currentKey(node);
      if (key) results.set(key, result);
      adapter.render(node, result, handlers);
    },
    onError: (e) => log("classify error", e),
  });

  function isOwnedNode(n: Node): boolean {
    const el = n instanceof Element ? n : n.parentElement;
    return !!el?.closest?.(`[${AF_OWNED}]`);
  }

  function scheduleNode(node: Element, priority: number): void {
    if (!state.enabled || stopped || known.has(node)) return;
    known.add(node);
    // Record the fingerprint synchronously (empty for skeletons) so the
    // MutationObserver can detect content arriving or a recycle even while
    // the async extract is still in flight.
    nodeInfo.set(node, { key: "", fingerprint: adapter.fingerprint(node) ?? "" });
    track(adapter.extract(node))
      .then((snapshot) => {
        if (!snapshot) return;
        const key = scheduleKey(snapshot.postId, snapshot.contentHash);
        // Keep the fingerprint recorded at schedule time; only set the key.
        const info = nodeInfo.get(node);
        if (info) info.key = key;
        if (revealed.has(key)) return; // user made it visible: leave it
        const cached = results.get(key);
        if (cached) {
          // Re-inserted copy of a post we already decided: render directly.
          adapter.render(node, cached, handlers);
        } else {
          scheduler.enqueue({ key, snapshot, node, priority });
        }
      })
      .catch((e) => log("extract error", e));
  }

  function priorityFor(node: Element): number {
    const rect = node.getBoundingClientRect();
    const near = win.innerHeight * 1.5;
    if (rect.top < win.innerHeight && rect.bottom > 0) return PRIORITY.VISIBLE;
    if (rect.top < near) return PRIORITY.NEAR;
    return PRIORITY.FAR;
  }

  // Window typing lacks IntersectionObserver in older lib.dom; go through win
  // so tests can inject a DOM without it.
  const IOCtor = (win as { IntersectionObserver?: typeof IntersectionObserver })
    .IntersectionObserver;
  const io =
    typeof IOCtor === "undefined"
      ? null
      : new IOCtor(
          (entries) => {
            for (const e of entries) {
              if (e.isIntersecting && pendingIO.has(e.target)) {
                pendingIO.delete(e.target);
                io!.unobserve(e.target);
                scheduleNode(e.target, priorityFor(e.target));
              }
            }
          },
          { rootMargin: "150%" },
        );

  function enqueueNode(node: Element): void {
    if (known.has(node)) return;
    if (io) {
      pendingIO.add(node);
      io.observe(node);
    } else {
      scheduleNode(node, priorityFor(node));
    }
  }

  const raf: (fn: () => void) => void =
    typeof win.requestAnimationFrame === "function"
      ? (fn) => win.requestAnimationFrame(() => fn())
      : (fn) => win.setTimeout(fn, 0);

  function queueDiscovery(root: ParentNode): void {
    discoverQueue.add(root);
    if (discoveryScheduled) return;
    discoveryScheduled = true;
    raf(() => {
      discoveryScheduled = false;
      for (const r of discoverQueue) {
        for (const node of adapter.discover(r)) enqueueNode(node);
      }
      discoverQueue.clear();
    });
  }

  /** Outermost article containing `el` (a quoted post nests an article). */
  function outermostPost(el: Element | null | undefined): Element | null {
    let post = el?.closest("article") ?? null;
    while (post?.parentElement?.closest("article")) {
      post = post.parentElement!.closest("article")!;
    }
    return post;
  }

  /** X recycled this article for a different post: drop + rediscover. */
  function recycle(post: Element): void {
    scheduler.cancel(post);
    restoreNode(post);
    nodeInfo.delete(post);
    known.delete(post);
    scheduleNode(post, priorityFor(post));
  }

  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (isOwnedNode(m.target)) continue;
      if (m.type === "childList") {
        const changed = [...m.addedNodes, ...m.removedNodes];
        if (changed.length && changed.every(isOwnedNode)) continue;
      }
      for (const removed of m.removedNodes) {
        if (removed instanceof Element) scheduler.cancel(removed);
      }
      const post = outermostPost(
        m.target instanceof Element ? m.target : m.target.parentElement,
      );
      if (post) {
        const info = nodeInfo.get(post);
        // `?? ""` keeps skeleton nodes (no postId yet) from looking "changed".
        if (info && (adapter.fingerprint(post) ?? "") !== info.fingerprint) {
          recycle(post);
        }
      }
      for (const added of m.addedNodes) {
        if (added instanceof Element && !isOwnedNode(added)) {
          queueDiscovery(added);
        }
      }
    }
  });

  function scanAll(): void {
    for (const node of adapter.discover(doc)) enqueueNode(node);
  }

  function restoreAll(): void {
    for (const node of adapter.discover(doc)) restoreNode(node);
    pendingIO.forEach((n) => io?.unobserve(n));
    pendingIO.clear();
  }

  return {
    state,

    async start() {
      const [p, e] = await Promise.all([deps.getPolicy(), deps.getEnabled()]);
      if (p) {
        policy = p;
        state.policyRevision = p.revision;
      }
      state.enabled = e ?? true;
      if (state.enabled) scanAll();
      // Always observe: toggling enabled later must see the live DOM, and a
      // page that booted disabled still needs the observer running.
      mo.observe(doc.body, { childList: true, subtree: true, characterData: true });
    },

    handleBroadcast(raw: unknown) {
      const b = BroadcastSchema.safeParse(raw);
      if (!b.success) return;
      if (b.data.type === "ENABLED_CHANGED") {
        state.enabled = b.data.enabled;
        scheduler.reset();
        if (!state.enabled) {
          restoreAll();
        }
        known = new WeakSet();
        nodeInfo = new WeakMap();
        results = new Map();
        revealed = new Set();
        if (state.enabled) scanAll();
      }
      if (b.data.type === "POLICY_CHANGED") {
        state.policyRevision = b.data.revision;
        scheduler.reset();
        restoreAll();
        known = new WeakSet();
        nodeInfo = new WeakMap();
        results = new Map();
        revealed = new Set();
        void track(deps.getPolicy()).then((p) => {
          if (p) policy = p;
          scanAll();
        });
      }
    },

    currentKey,

    stop() {
      stopped = true;
      mo.disconnect();
      io?.disconnect();
      restoreAll();
    },

    async idle() {
      for (;;) {
        if (pendingTasks.size) await Promise.allSettled([...pendingTasks]);
        await new Promise((r) => setTimeout(r, 0));
        if (!pendingTasks.size && !discoveryScheduled && !discoverQueue.size) return;
      }
    },
  };
}
