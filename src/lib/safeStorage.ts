/**
 * localStorage writes that never throw.
 *
 * WebKit caps each origin's localStorage at about 5 MB. Akflix's catalog cache
 * (src/api/cinemeta.ts) used to grow past that, after which *every* write threw
 * QuotaExceededError — including the persisted profile written on launch,
 * which made React unmount the whole app and leave a black window. The catalog
 * cache is re-downloadable, so it is kept to a budget and is the first thing
 * evicted when space runs out.
 */
import type { StateStorage } from "zustand/middleware";

export const CATALOG_CACHE_PREFIX = "akflix.catalog.v1.";
/** Characters the catalog cache may use; leaves the rest of the quota for user state. */
export const CATALOG_CACHE_BUDGET = 1_500_000;

export function isQuotaError(error: unknown): boolean {
  if (!(error instanceof Error) && !(typeof error === "object" && error)) return false;
  const { name, code } = error as { name?: string; code?: number };
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED" || code === 22 || code === 1014;
}

interface CatalogEntry {
  key: string;
  size: number;
  savedAt: number;
}

function catalogEntries(): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(CATALOG_CACHE_PREFIX)) continue;
    const raw = localStorage.getItem(key) ?? "";
    const savedAt = Number(/^\{"savedAt":(\d+)/.exec(raw)?.[1] ?? 0);
    entries.push({ key, size: key.length + raw.length, savedAt });
  }
  return entries;
}

/**
 * Remove the oldest catalog cache entries until the cache uses at most
 * `budget` characters. Returns the number of characters freed.
 */
export function trimCatalogCache(budget = CATALOG_CACHE_BUDGET): number {
  try {
    const entries = catalogEntries().sort((a, b) => a.savedAt - b.savedAt);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    let freed = 0;
    for (const entry of entries) {
      if (total <= budget) break;
      localStorage.removeItem(entry.key);
      total -= entry.size;
      freed += entry.size;
    }
    return freed;
  } catch {
    return 0;
  }
}

/**
 * Write a value, freeing the catalog cache once if storage is full.
 * Returns false (instead of throwing) when the value still cannot be stored.
 */
export function safeSetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    if (!isQuotaError(error)) return false;
  }
  // Only clear the cache entirely for user state; a catalog write just yields.
  if (key.startsWith(CATALOG_CACHE_PREFIX) || trimCatalogCache(0) === 0) return false;
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** zustand `persist` storage that keeps the app running when storage is full or unavailable. */
export const safeStateStorage: StateStorage = {
  getItem: (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    if (!safeSetItem(key, value)) console.warn(`Akflix could not save ${key}; storage is full or unavailable.`);
  },
  removeItem: (key) => {
    try {
      localStorage.removeItem(key);
    } catch {
      // Nothing to remove when storage is unavailable.
    }
  },
};
