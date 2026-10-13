/** Cinemeta — Stremio-compatible movie/series catalog and metadata. */

import { httpJson } from "@/lib/http";
import { CATALOG_CACHE_BUDGET, CATALOG_CACHE_PREFIX, safeSetItem, trimCatalogCache } from "@/lib/safeStorage";
import { withTimeout } from "@/lib/withTimeout";
import type {
  StremioCatalogResponse,
  StremioMediaType,
  StremioMeta,
  StremioMetaResponse,
} from "@/types/stremio";

const BASE_URL = "https://v3-cinemeta.strem.io";
const CACHE_PREFIX = CATALOG_CACHE_PREFIX;
const CACHE_MAX_AGE = 12 * 60 * 60 * 1000;

interface CachedResponse<T> {
  savedAt: number;
  value: T;
}

function cacheKey(url: string): string {
  return `${CACHE_PREFIX}${url.replace(BASE_URL, "")}`;
}

function readCache<T>(url: string, allowStale = false): T | null {
  try {
    const raw = localStorage.getItem(cacheKey(url));
    if (!raw) return null;
    const cached = JSON.parse(raw) as CachedResponse<T>;
    if (!allowStale && Date.now() - cached.savedAt > CACHE_MAX_AGE) return null;
    return cached.value ?? null;
  } catch {
    return null;
  }
}

function writeCache<T>(url: string, value: T) {
  // Browsing still works if private storage is unavailable or full. The cache
  // stays within its budget so profile, history and settings can always save.
  const raw = JSON.stringify({ savedAt: Date.now(), value });
  if (raw.length > CATALOG_CACHE_BUDGET / 2) return;
  if (safeSetItem(cacheKey(url), raw)) trimCatalogCache();
}

async function cachedJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const cached = readCache<T>(url);
  if (cached) return cached;
  try {
    const value = await httpJson<T>(url, { signal });
    writeCache(url, value);
    return value;
  } catch (reason) {
    const stale = readCache<T>(url, true);
    if (stale) return stale;
    throw reason;
  }
}

export class CinemetaClient {
  async catalogOrEmpty(
    type: StremioMediaType,
    catalog = "top",
    extra?: Record<string, string>,
    signal?: AbortSignal
  ): Promise<StremioMeta[]> {
    try {
      return await this.catalog(type, catalog, extra, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      return [];
    }
  }

  async catalog(
    type: StremioMediaType,
    catalog = "top",
    extra?: Record<string, string>,
    signal?: AbortSignal
  ): Promise<StremioMeta[]> {
    const suffix = extra
      ? `/${Object.entries(extra)
          .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
          .join("&")}`
      : "";
    const response = await cachedJson<StremioCatalogResponse>(
      `${BASE_URL}/catalog/${type}/${catalog}${suffix}.json`,
      signal
    );
    return response.metas ?? [];
  }

  async search(query: string, signal?: AbortSignal): Promise<StremioMeta[]> {
    const results = await Promise.allSettled(
      (["movie", "series"] as const).map((type) =>
        withTimeout((requestSignal) => this.catalog(type, "top", { search: query.trim() }, requestSignal), 10000, signal)
      )
    );
    if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
    if (results.every((result) => result.status === "rejected")) {
      throw new Error("Movie and series search is temporarily unavailable.");
    }
    return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  }

  async meta(
    type: StremioMediaType,
    id: string,
    signal?: AbortSignal
  ): Promise<StremioMeta> {
    const response = await cachedJson<StremioMetaResponse>(
      `${BASE_URL}/meta/${type}/${encodeURIComponent(id)}.json`,
      signal
    );
    return response.meta;
  }
}

export const cinemeta = new CinemetaClient();
