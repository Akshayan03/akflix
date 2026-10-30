/**
 * Skip markers from the two public, community-run timestamp databases:
 * TheIntroDB (api.theintrodb.org/v2/media) and IntroDB (api.introdb.app/segments),
 * looked up by IMDb id, season and episode. They let the very first episode
 * played on a device have Skip Recap / Skip Intro / Next episode, which the
 * audio fingerprints (detector.ts) can only find by comparing it with another
 * episode already played.
 *
 * Times are measured on someone's copy, which can sit a few seconds off this
 * file, so they are used carefully: when both databases know a part, only the
 * stretch they agree on is used (a skip that lands a little early is better
 * than one that skips content), and they are trusted below the file's own
 * chapters and below what the fingerprints found in this exact file.
 * Lookups are remembered (SkipMemory.online) and the next episode's are
 * fetched ahead, so the buttons are there the moment a file opens.
 */

import { plausibleSegment, type SkipKind, type SkipMarkers, type SkipSegment } from "./markers";
import type { SkipMemory } from "./cache";

export interface OnlineLookup {
  imdbId: string;
  /** Absent for a movie. */
  season?: number;
  episode?: number;
}

/** One database's answer: seconds; `end` null when the part runs to the end. */
export type OnlineParts = Partial<Record<SkipKind, { start: number; end: number | null }>>;

export type FetchJson = (url: string, signal: AbortSignal) => Promise<unknown>;

/** Both databases agree on a part when its ends are this close (seconds). */
export const ONLINE_AGREEMENT = 8;
/** Credits starts further apart than this are not the same credits. */
export const ONLINE_CREDITS_AGREEMENT = 45;
/** How long a lookup is remembered: found parts, and "nothing known yet". */
export const ONLINE_TTL_MS = 7 * 24 * 3600_000;
export const ONLINE_MISS_TTL_MS = 12 * 3600_000;
const LOOKUP_TIMEOUT_MS = 6_000;

export function onlineLookupFor(show: string, season?: number, episode?: number): OnlineLookup | null {
  if (!/^tt\d{5,10}$/.test(show)) return null;
  if (season === undefined || episode === undefined) return { imdbId: show };
  if (!(season > 0) || !(episode > 0)) return null;
  return { imdbId: show, season, episode };
}

export function onlineKey(lookup: OnlineLookup): string {
  return lookup.season === undefined ? `${lookup.imdbId}:movie` : `${lookup.imdbId}:${lookup.season}:${lookup.episode}`;
}

const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** TheIntroDB v2: `{ intro: [{ start_ms, end_ms }], recap: [...], credits: [...] }`; a null start is 0, a null end the end. */
export function partsFromTheIntroDb(json: unknown): OnlineParts {
  const parts: OnlineParts = {};
  if (!json || typeof json !== "object") return parts;
  const body = json as Record<string, unknown>;
  for (const kind of ["intro", "recap", "credits"] as const) {
    const list = body[kind];
    const first = Array.isArray(list) ? (list[0] as Record<string, unknown> | undefined) : undefined;
    if (!first || typeof first !== "object") continue;
    const start = number(first.start_ms) ?? 0;
    const end = number(first.end_ms);
    parts[kind] = { start: start / 1000, end: end === null ? null : end / 1000 };
  }
  return parts;
}

/** IntroDB: `{ intro: { start_ms, end_ms }, recap: {...}, outro: {...} }` (outro = end credits). */
export function partsFromIntroDb(json: unknown): OnlineParts {
  const parts: OnlineParts = {};
  if (!json || typeof json !== "object") return parts;
  const body = json as Record<string, unknown>;
  const names: Record<SkipKind, string> = { intro: "intro", recap: "recap", credits: "outro" };
  for (const kind of ["intro", "recap", "credits"] as const) {
    const part = body[names[kind]] as Record<string, unknown> | null | undefined;
    if (!part || typeof part !== "object") continue;
    const start = number(part.start_ms) ?? (number(part.start_sec) ?? 0) * 1000;
    const end = number(part.end_ms) ?? (number(part.end_sec) === null ? null : number(part.end_sec)! * 1000);
    parts[kind] = { start: start / 1000, end: end === null ? null : end / 1000 };
  }
  return parts;
}

/**
 * The markers both answers support, for a file of `duration` seconds (0 while
 * unknown: credits then wait for it). One database alone is used as it is;
 * two that disagree about a part give none for it.
 */
export function combineOnlineParts(answers: OnlineParts[], duration: number): SkipMarkers {
  const markers: SkipMarkers = {};
  for (const kind of ["recap", "intro", "credits"] as const) {
    const seen = answers.map((answer) => answer[kind]).filter((part): part is { start: number; end: number | null } => !!part);
    if (!seen.length) continue;
    let segment: { start: number; end: number } | null = null;
    if (kind === "credits") {
      if (!(duration > 0)) continue;
      const starts = seen.map((part) => part.start);
      if (Math.max(...starts) - Math.min(...starts) > ONLINE_CREDITS_AGREEMENT) continue;
      // The later start: the card must never cover the last scene.
      const start = Math.max(...starts);
      if (start >= duration - 10) continue;
      segment = { start, end: duration };
    } else {
      const parts = seen.filter((part): part is { start: number; end: number } => part.end !== null);
      if (parts.length !== seen.length) continue;
      if (parts.length > 1) {
        const starts = parts.map((part) => part.start);
        const ends = parts.map((part) => part.end);
        if (Math.max(...starts) - Math.min(...starts) > ONLINE_AGREEMENT) continue;
        if (Math.max(...ends) - Math.min(...ends) > ONLINE_AGREEMENT) continue;
        // Only what both call the part: never skip into content either knows.
        segment = { start: Math.max(...starts), end: Math.min(...ends) };
      } else {
        segment = { start: parts[0].start, end: parts[0].end };
      }
    }
    if (segment && plausibleSegment(kind, segment, duration)) {
      markers[kind] = { ...segment, source: "online" } satisfies SkipSegment;
    }
  }
  return markers;
}

export function theIntroDbUrl(lookup: OnlineLookup): string {
  const query = new URLSearchParams({ imdb_id: lookup.imdbId });
  if (lookup.season !== undefined) {
    query.set("season", String(lookup.season));
    query.set("episode", String(lookup.episode));
  }
  return `https://api.theintrodb.org/v2/media?${query}`;
}

export function introDbUrl(lookup: OnlineLookup): string {
  const query = new URLSearchParams({ imdb_id: lookup.imdbId });
  if (lookup.season === undefined) query.set("is_movie", "true");
  else {
    query.set("season", String(lookup.season));
    query.set("episode", String(lookup.episode));
  }
  return `https://api.introdb.app/segments?${query}`;
}

function withTimeout(signal: AbortSignal, ms: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const stop = () => controller.abort();
  const timer = setTimeout(stop, ms);
  signal.addEventListener("abort", stop, { once: true });
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    },
  };
}

/** Both databases at once; one failing (offline, 404, rate limit) leaves the other. */
export async function fetchOnlineParts(lookup: OnlineLookup, fetchJson: FetchJson, signal: AbortSignal): Promise<OnlineParts[] | null> {
  const ask = async (url: string, parse: (json: unknown) => OnlineParts) => {
    const bounded = withTimeout(signal, LOOKUP_TIMEOUT_MS);
    try {
      return parse(await fetchJson(url, bounded.signal));
    } catch {
      return null;
    } finally {
      bounded.done();
    }
  };
  const answers = await Promise.all([
    ask(theIntroDbUrl(lookup), partsFromTheIntroDb),
    ask(introDbUrl(lookup), partsFromIntroDb),
  ]);
  if (signal.aborted) return null;
  const known = answers.filter((answer): answer is OnlineParts => answer !== null);
  // Both unreachable: not remembered, asked again next time.
  return answers.every((answer) => answer === null) ? null : known.filter((answer) => Object.keys(answer).length > 0);
}

const pending = new Map<string, Promise<OnlineParts[] | null>>();

/**
 * The databases' answers for `lookup`, from memory when fresh. Shared by the
 * playing file and the next episode's prefetch (one request per lookup).
 */
export function onlineParts(
  lookup: OnlineLookup,
  memory: SkipMemory,
  fetchJson: FetchJson,
  signal: AbortSignal,
  now: () => number = () => Date.now()
): Promise<OnlineParts[] | null> {
  const key = onlineKey(lookup);
  const stored = memory.online(key);
  if (stored) {
    const ttl = stored.parts.length ? ONLINE_TTL_MS : ONLINE_MISS_TTL_MS;
    if (now() - stored.at < ttl) return Promise.resolve(stored.parts);
  }
  const running = pending.get(key);
  if (running) return running;
  // Not tied to one caller's signal: a prefetch and the player share it.
  const job = fetchOnlineParts(lookup, fetchJson, new AbortController().signal)
    .then((parts) => {
      if (parts) memory.saveOnline(key, { at: now(), parts });
      return parts ?? stored?.parts ?? null;
    })
    .finally(() => pending.delete(key));
  pending.set(key, job);
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Skip analysis stopped", "AbortError"));
    signal.addEventListener("abort", () => reject(new DOMException("Skip analysis stopped", "AbortError")), { once: true });
    job.then(resolve, reject);
  });
}
