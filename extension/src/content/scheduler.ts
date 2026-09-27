import type { DecisionResult, PostSnapshot } from "../contracts";

/** Lower number = sooner. visible < near-viewport < far. */
export const PRIORITY = { VISIBLE: 0, NEAR: 1, FAR: 2 } as const;

export interface ScheduledPost {
  /** Dedupe key: `${postId}|${contentHash}`. */
  key: string;
  snapshot: PostSnapshot;
  node: Element;
  priority: number;
}

export interface SchedulerHooks {
  classify: (snapshot: PostSnapshot) => Promise<DecisionResult>;
  /** Current `${postId}|${contentHash}` for a node, for stale rejection. */
  currentKey: (node: Element) => string | null;
  currentPolicyRevision: () => number;
  render: (node: Element, result: DecisionResult) => void;
  onError?: (err: unknown) => void;
}

const MAX_IN_FLIGHT = 4;

/**
 * Priority queue over classify requests: visible-first, capped in-flight,
 * deduped by postId+contentHash, cancelled on node disconnect, and
 * stale-result rejection before render (node may have been recycled with
 * different content, or the policy may have changed mid-flight).
 */
export class Scheduler {
  private queue: ScheduledPost[] = [];
  private queued = new Set<string>();
  private done = new Set<string>();
  private inFlight = 0;
  private generation = 0;

  constructor(private hooks: SchedulerHooks) {}

  enqueue(post: ScheduledPost): void {
    if (this.queued.has(post.key) || this.done.has(post.key)) return;
    this.queued.add(post.key);
    this.queue.push(post);
    this.queue.sort((a, b) => a.priority - b.priority);
    this.pump();
  }

  /** Drop queued work for a node (called on disconnect). */
  cancel(node: Element): void {
    this.queue = this.queue.filter((j) => j.node !== node);
  }

  /** Forget everything: used on POLICY_CHANGED so posts reevaluate. */
  reset(): void {
    this.queue = [];
    this.queued.clear();
    this.done.clear();
    this.generation++;
  }

  private pump(): void {
    while (this.inFlight < MAX_IN_FLIGHT && this.queue.length > 0) {
      const job = this.queue.shift()!;
      const generation = this.generation;
      this.inFlight++;
      this.hooks
        .classify(job.snapshot)
        .then((result) => {
          // Stale-result rejection: node gone, recycled to a different post,
          // or policy revision moved on while the request was in flight.
          if (!job.node.isConnected) return;
          if (generation !== this.generation) return;
          if (this.hooks.currentKey(job.node) !== job.key) return;
          if (result.policyRevision !== this.hooks.currentPolicyRevision()) return;
          this.done.add(job.key);
          this.hooks.render(job.node, result);
        })
        .catch((e) => this.hooks.onError?.(e))
        .finally(() => {
          this.inFlight--;
          this.pump();
        });
    }
  }
}

export function scheduleKey(postId: string, contentHash: string): string {
  return `${postId}|${contentHash}`;
}
