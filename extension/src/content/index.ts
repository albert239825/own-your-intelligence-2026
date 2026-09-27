import {
  BroadcastSchema,
  type DecisionResult,
  type Feedback,
  type Policy,
  type PostSnapshot,
} from "../contracts";
import {
  ensureStyle,
  fixtureAdapter,
  restoreNode,
  type RenderHandlers,
} from "./adapter";
import { xAdapter } from "./x-adapter";
import { PRIORITY, Scheduler, scheduleKey } from "./scheduler";

const isX = /(^|\.)x\.com$|(^|\.)twitter\.com$/.test(location.hostname);
const adapter = isX ? xAdapter : fixtureAdapter;

let policy: Policy | null = null;
let policyRevision = 0;
let enabled = true;

function send<T>(msg: unknown): Promise<T | undefined> {
  return chrome.runtime.sendMessage(msg).then((r) => (r?.ok ? r : undefined));
}

const nodeKey = new WeakMap<Element, string>();

const handlers: RenderHandlers = {
  ruleTitle: (id) => policy?.rules.find((r) => r.id === id)?.title ?? id,
  onKeep: (snapshot) => {
    void send({
      type: "SET_OVERRIDE",
      override: {
        postId: snapshot.postId,
        contentHash: snapshot.contentHash,
        action: "keep",
        createdAt: Date.now(),
      },
    });
  },
  onCorrect: (fb) => {
    const feedback: Feedback = {
      ...fb,
      feedbackId: crypto.randomUUID(),
      createdAt: Date.now(),
    };
    void send({ type: "SAVE_FEEDBACK", feedback });
  },
};

const scheduler = new Scheduler({
  classify: async (snapshot: PostSnapshot) => {
    const res = await send<{ result: DecisionResult }>({
      type: "CLASSIFY_POST",
      request: {
        requestId: crypto.randomUUID(),
        post: snapshot,
        policyRevision,
      },
    });
    if (!res?.result) throw new Error("no result from worker");
    return res.result;
  },
  currentKey: (node) => nodeKey.get(node) ?? null,
  currentPolicyRevision: () => policyRevision,
  render: (node, result) => adapter.render(node, result, handlers),
  onError: (e) => console.warn("[af] classify error", e),
});

// ---- discovery -----------------------------------------------------------

let known = new WeakSet<Element>();
const pending = new Set<Element>();

function scheduleNode(node: Element, priority: number): void {
  if (!enabled || known.has(node)) return;
  known.add(node);
  void adapter.extract(node).then((snapshot) => {
    if (!snapshot) return;
    const key = scheduleKey(snapshot.postId, snapshot.contentHash);
    nodeKey.set(node, key);
    scheduler.enqueue({ key, snapshot, node, priority });
  });
}

function priorityFor(node: Element): number {
  const rect = node.getBoundingClientRect();
  const near = window.innerHeight * 1.5;
  if (rect.top < window.innerHeight && rect.bottom > 0) return PRIORITY.VISIBLE;
  if (rect.top < near) return PRIORITY.NEAR;
  return PRIORITY.FAR;
}

const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting && pending.has(e.target)) {
        pending.delete(e.target);
        scheduleNode(e.target, priorityFor(e.target));
        io.unobserve(e.target);
      }
    }
  },
  { rootMargin: "150%" },
);

const discoverQueue = new Set<ParentNode>();
let rafScheduled = false;

function queueDiscovery(root: ParentNode): void {
  discoverQueue.add(root);
  if (rafScheduled) return;
  rafScheduled = true;
  requestAnimationFrame(() => {
    rafScheduled = false;
    for (const r of discoverQueue) {
      for (const node of adapter.discover(r)) {
        if (!known.has(node)) {
          pending.add(node);
          io.observe(node);
        }
      }
    }
    discoverQueue.clear();
  });
}

const mo = new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const removed of m.removedNodes) {
      if (removed instanceof Element) scheduler.cancel(removed);
    }
    for (const added of m.addedNodes) {
      if (added instanceof Element && !added.closest?.("[data-af-owned]")) {
        queueDiscovery(added);
      }
    }
  }
});

function scanAll(): void {
  for (const node of adapter.discover(document)) {
    if (!known.has(node)) {
      pending.add(node);
      io.observe(node);
    }
  }
}

function restoreAll(): void {
  for (const node of adapter.discover(document)) {
    restoreNode(node);
  }
  pending.clear();
}

// ---- broadcasts -----------------------------------------------------------

chrome.runtime.onMessage.addListener((raw: unknown) => {
  const b = BroadcastSchema.safeParse(raw);
  if (!b.success) return;
  if (b.data.type === "ENABLED_CHANGED") {
    enabled = b.data.enabled;
    if (!enabled) {
      scheduler.reset();
      restoreAll();
    } else {
      scheduler.reset();
      scanAll();
    }
  }
  if (b.data.type === "POLICY_CHANGED") {
    policyRevision = b.data.revision;
    // Reevaluate all mounted posts under the new revision.
    scheduler.reset();
    restoreAll();
    known = new WeakSet();
    void send<{ policy: Policy }>({ type: "GET_POLICY" }).then((r) => {
      if (r?.policy) policy = r.policy;
      scanAll();
    });
  }
});

// ---- boot -----------------------------------------------------------------

void (async () => {
  ensureStyle();
  const [p, e] = await Promise.all([
    send<{ policy: Policy }>({ type: "GET_POLICY" }),
    send<{ enabled: boolean }>({ type: "GET_ENABLED" }),
  ]);
  if (p?.policy) {
    policy = p.policy;
    policyRevision = p.policy.revision;
  }
  enabled = e?.enabled ?? true;
  if (!enabled) return;
  scanAll();
  mo.observe(document.body, { childList: true, subtree: true });
})();
