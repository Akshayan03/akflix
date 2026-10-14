/**
 * The release that last started playing for each movie or episode.
 *
 * Watch and Resume search and race sources from scratch, and the race takes
 * whichever release answers first. Without this a resume could land on a
 * different, sometimes dead release than the one that was just playing.
 */
import { safeSetItem } from "@/lib/safeStorage";

const STORAGE_KEY = "akflix.last-source.v1";
const MAX_ENTRIES = 200;

interface SourceIdentity {
  catalogId?: string;
  season?: number;
  episode?: number;
}

type SourceMap = Record<string, { hash: string; at: number }>;

function sourceKey(media: SourceIdentity | null | undefined): string | null {
  if (!media?.catalogId) return null;
  return `${media.catalogId}:${media.season ?? 0}:${media.episode ?? 0}`;
}

function readSources(): SourceMap {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function rememberedSource(media: SourceIdentity | null | undefined): string | null {
  const key = sourceKey(media);
  return key ? readSources()[key]?.hash ?? null : null;
}

export function rememberSource(media: SourceIdentity | null | undefined, hash: string): void {
  const key = sourceKey(media);
  if (!key) return;
  const sources = readSources();
  sources[key] = { hash: hash.toLowerCase(), at: Date.now() };
  const newest = Object.entries(sources)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_ENTRIES);
  safeSetItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(newest)));
}

/** Move the remembered release to the front, keeping the rest in rank order. */
export function preferRememberedSource<T>(
  results: T[],
  hashOf: (result: T) => string | null,
  remembered: string | null
): T[] {
  if (!remembered) return results;
  const index = results.findIndex((result) => hashOf(result)?.toLowerCase() === remembered);
  if (index <= 0) return results;
  return [results[index], ...results.slice(0, index), ...results.slice(index + 1)];
}
