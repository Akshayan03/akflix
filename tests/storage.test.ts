import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOG_CACHE_BUDGET, CATALOG_CACHE_PREFIX, safeSetItem, trimCatalogCache } from "../src/lib/safeStorage";

/** A WebKit-like localStorage that throws QuotaExceededError past `quota` characters. */
function quotaStorage(quota: number, seed: Record<string, string> = {}) {
  const items = new Map(Object.entries(seed));
  const used = () => [...items].reduce((sum, [key, value]) => sum + key.length + value.length, 0);
  return {
    items,
    get length() { return items.size; },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem(key: string, value: string) {
      const previous = items.get(key);
      const next = used() - (previous === undefined ? 0 : key.length + previous.length) + key.length + value.length;
      if (next > quota) {
        const error = new Error("The quota has been exceeded.");
        error.name = "QuotaExceededError";
        throw error;
      }
      items.set(key, String(value));
    },
    removeItem: (key: string) => void items.delete(key),
  };
}

function withStorage<T>(storage: ReturnType<typeof quotaStorage>, run: () => T): T {
  const globals = globalThis as Record<string, unknown>;
  const previous = globals.localStorage;
  globals.localStorage = storage;
  try {
    return run();
  } finally {
    globals.localStorage = previous;
  }
}

const catalog = (savedAt: number, size: number) => `{"savedAt":${savedAt},"value":"${"x".repeat(size)}"}`;

test("a full catalog cache no longer blocks saving the profile (black-screen regression)", () => {
  // Shape of the real over-quota store from 1.0.20: catalog JSON filled the quota.
  const storage = quotaStorage(200_000, {
    [`${CATALOG_CACHE_PREFIX}/catalog/series/top.json`]: catalog(1, 120_000),
    [`${CATALOG_CACHE_PREFIX}/catalog/movie/top.json`]: catalog(2, 79_000),
    "akflix.history": '{"state":{"entries":[]},"version":1}',
  });
  withStorage(storage, () => {
    assert.throws(() => localStorage.setItem("akflix.auth", "x".repeat(2_000)), { name: "QuotaExceededError" });
    assert.equal(safeSetItem("akflix.auth", "x".repeat(2_000)), true);
  });
  assert.equal(storage.items.get("akflix.auth")?.length, 2_000);
  assert.equal(storage.items.get("akflix.history"), '{"state":{"entries":[]},"version":1}');
  assert.ok(![...storage.items.keys()].some((key) => key.startsWith(CATALOG_CACHE_PREFIX)));
});

test("writes report failure instead of throwing when nothing can be freed", () => {
  const storage = quotaStorage(1_000, { "akflix.history": "x".repeat(990) });
  withStorage(storage, () => assert.equal(safeSetItem("akflix.auth", "x".repeat(100)), false));
  assert.equal(storage.items.has("akflix.auth"), false);
});

test("catalog cache trims oldest entries to its budget and keeps user state", () => {
  const storage = quotaStorage(10_000_000, {
    [`${CATALOG_CACHE_PREFIX}old`]: catalog(1, CATALOG_CACHE_BUDGET / 2),
    [`${CATALOG_CACHE_PREFIX}mid`]: catalog(2, CATALOG_CACHE_BUDGET / 2),
    [`${CATALOG_CACHE_PREFIX}new`]: catalog(3, CATALOG_CACHE_BUDGET / 4),
    "akflix.settings": "{}",
  });
  withStorage(storage, () => assert.ok(trimCatalogCache() > 0));
  assert.deepEqual([...storage.items.keys()].sort(), [`${CATALOG_CACHE_PREFIX}mid`, `${CATALOG_CACHE_PREFIX}new`, "akflix.settings"]);
});
