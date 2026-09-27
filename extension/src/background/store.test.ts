import { describe, expect, it } from "vitest";
import { appendCapped, withStore } from "./store";

describe("appendCapped", () => {
  it("caps at limit, newest first", () => {
    let list: number[] = [];
    for (let i = 0; i < 10; i++) list = appendCapped(list, i, 3);
    expect(list).toEqual([9, 8, 7]);
  });
});

describe("withStore", () => {
  it("serializes concurrent read-modify-write updates, losing none", async () => {
    // In-memory fake of chrome.storage.local
    const mem: Record<string, number[]> = { items: [] };
    const get = async () => mem.items;
    const set = async (v: number[]) => {
      mem.items = v;
    };

    const n = 20;
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        withStore(async () => {
          const list = (await get()) ?? [];
          // force a yield between read and write so unsynchronized
          // interleavings would actually lose writes
          await Promise.resolve();
          await set([...list, i]);
        }),
      ),
    );
    expect(mem.items!.sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
  });

  it("keeps the chain alive after a failing update", async () => {
    await expect(
      withStore(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(withStore(async () => 42)).resolves.toBe(42);
  });
});
