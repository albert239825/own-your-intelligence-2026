/** Storage-write serialization for the background worker.
 *
 * chrome.storage.local updates are read-modify-write; concurrent CLASSIFY
 * calls otherwise lose entries (observed: 7 hides → 2 recorded). All
 * get-mutate-set sequences go through `withStore`. */

let chain: Promise<void> = Promise.resolve();

/** Serialize fn's read-modify-write storage updates through one promise chain. */
export function withStore<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn);
  chain = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

/** Prepend item, capped at limit (newest first). Pure. */
export function appendCapped<T>(list: T[], item: T, limit: number): T[] {
  const out = [item, ...list];
  if (out.length > limit) out.length = limit;
  return out;
}
