/**
 * Catalogue feeds for the home rows and the What's New page, from Cinemeta
 * (free, no key): "Popular" (trending order), new releases by year,
 * "Featured", genre feeds, people search, full metadata, and the
 * calendar-videos feed that lists each show's latest and scheduled episodes
 * with their air dates.
 *
 * Every response is trimmed to the fields discovery uses and cached in
 * localStorage under the catalog-cache prefix (the Mac's quota guard trims
 * it like any other catalogue cache) within its own budget. A feed that
 * fails or times out falls back to its last copy, then to nothing: the home
 * shows fewer rows, never an error.
 */
import { httpJson } from "@/lib/http";
import { withTimeout } from "@/lib/withTimeout";
import type { StremioMediaType, StremioMeta, StremioVideo } from "@/types/stremio";
import { DAY, datedEpisodes, compareEpisodes, airedBy } from "@/lib/discovery/dates";
import { CATALOG_GENRES } from "@/lib/discovery/genres";
import { emptyDiscoveryData, type DiscoveryData } from "@/lib/discovery/rows";
import { FeatureIndex, buildProfile, collectSeeds, keyOf, type Signals } from "@/lib/discovery/taste";

const BASE = "https://v3-cinemeta.strem.io";
export const DISCOVERY_CACHE_PREFIX = "akflix.catalog.v1.discovery.";
const BUDGET = 900_000;
const HOUR = 3_600_000;
const TIMEOUT = 9_000;

// -------------------------------------------------------------------- cache

interface Cached<T> {
  savedAt: number;
  value: T;
}

const memory = new Map<string, Cached<unknown>>();

function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readCache<T>(key: string): Cached<T> | null {
  const hit = memory.get(key) as Cached<T> | undefined;
  if (hit) return hit;
  try {
    const raw = store()?.getItem(DISCOVERY_CACHE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Cached<T>;
    if (typeof parsed?.savedAt !== "number") return null;
    memory.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

/** Oldest-first eviction of discovery entries down to `budget` characters. */
export function trimDiscoveryCache(budget = BUDGET) {
  const storage = store();
  if (!storage) return;
  try {
    const entries: { key: string; size: number; savedAt: number }[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (!key?.startsWith(DISCOVERY_CACHE_PREFIX)) continue;
      const raw = storage.getItem(key) ?? "";
      entries.push({ key, size: key.length + raw.length, savedAt: Number(/^\{"savedAt":(\d+)/.exec(raw)?.[1] ?? 0) });
    }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries.sort((a, b) => a.savedAt - b.savedAt)) {
      if (total <= budget) break;
      storage.removeItem(entry.key);
      memory.delete(entry.key.slice(DISCOVERY_CACHE_PREFIX.length));
      total -= entry.size;
    }
  } catch {
    // The cache is optional.
  }
}

function writeCache<T>(key: string, value: T) {
  const entry: Cached<T> = { savedAt: Date.now(), value };
  memory.set(key, entry);
  const raw = JSON.stringify(entry);
  if (raw.length > BUDGET / 4) return;
  const storage = store();
  if (!storage) return;
  try {
    storage.setItem(DISCOVERY_CACHE_PREFIX + key, raw);
  } catch {
    // Full: make room among our own entries once; user data is never touched.
    trimDiscoveryCache(BUDGET / 2);
    try {
      storage.setItem(DISCOVERY_CACHE_PREFIX + key, raw);
    } catch {
      return;
    }
  }
  trimDiscoveryCache();
}

export interface LoadOptions {
  /** false: answer from the cache only (instant), stale copies included. */
  network?: boolean;
  signal?: AbortSignal;
  /**
   * How long the second pass (people, full episode lists) may add to a load.
   * Anything later still lands in the cache for next time.
   */
  secondPassMs?: number;
}

interface LoadState {
  options: LoadOptions;
  /** Set when any answer came from a stale copy or nothing. */
  missed: boolean;
}

async function cached<T>(state: LoadState, key: string, maxAge: number, empty: T, load: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const hit = readCache<T>(key);
  if (hit && Date.now() - hit.savedAt <= maxAge) return hit.value;
  if (state.options.network === false) {
    state.missed = true;
    return hit?.value ?? empty;
  }
  try {
    const value = await withTimeout(load, TIMEOUT, state.options.signal);
    writeCache(key, value);
    return value;
  } catch (reason) {
    if (state.options.signal?.aborted) throw reason;
    state.missed = true;
    return hit?.value ?? empty;
  }
}

// --------------------------------------------------------------- trimming

const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
const names = (value: unknown, max: number) =>
  Array.isArray(value) ? value.filter((name): name is string => typeof name === "string" && !!name.trim()).slice(0, max) : undefined;
const round = (value: unknown, digits = 2) =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : undefined;

type VideoMode = "none" | "seasons" | "all";

function trimVideos(videos: StremioVideo[] | undefined, mode: VideoMode): StremioVideo[] | undefined {
  if (mode === "none" || !Array.isArray(videos)) return undefined;
  const dated = videos
    .map((video) => ({
      id: String(video.id ?? ""),
      season: Number(video.season),
      episode: Number(video.episode ?? video.number),
      released: text(video.released, 30) ?? text(video.firstAired, 30),
      name: mode === "all" ? undefined : text(video.name ?? video.title, 80),
    }))
    .filter((video) => Number.isInteger(video.season) && Number.isInteger(video.episode) && video.released);
  if (mode === "all") return dated;
  // Catalogue rows: the first and last dated episode of the last 3 seasons is
  // enough to tell when a new season started.
  const bySeason = new Map<number, typeof dated>();
  for (const video of dated) {
    if (video.season < 1) continue;
    const list = bySeason.get(video.season) ?? [];
    list.push(video);
    bySeason.set(video.season, list);
  }
  const seasons = [...bySeason.keys()].sort((a, b) => a - b).slice(-3);
  return seasons.flatMap((season) => {
    const list = bySeason.get(season)!.sort((a, b) => a.episode - b.episode);
    return list.length > 1 ? [list[0], list[list.length - 1]] : list;
  });
}

export function trimMeta(raw: StremioMeta, mode: VideoMode = "seasons"): StremioMeta {
  const meta = raw as StremioMeta & { genre?: string[] };
  const popularities = meta.popularities
    ? Object.fromEntries(
        ["trakt", "moviedb"]
          .map((name) => [name, round(meta.popularities?.[name])] as const)
          .filter((entry): entry is readonly [string, number] => entry[1] !== undefined)
      )
    : undefined;
  const out: StremioMeta = {
    id: String(meta.id),
    type: meta.type,
    name: text(meta.name, 200) ?? String(meta.id),
    poster: text(meta.poster, 400),
    background: text(meta.background, 400),
    description: text(meta.description, 320),
    releaseInfo: text(meta.releaseInfo, 20),
    year: text(meta.year, 20),
    released: text(meta.released, 30),
    imdbRating: text(meta.imdbRating, 6),
    runtime: text(meta.runtime, 20),
    genres: names(meta.genres ?? meta.genre, 6),
    cast: names(meta.cast, 6),
    director: names(meta.director, 3),
    writer: names(meta.writer, 3),
    country: text(meta.country, 80),
    status: text(meta.status, 20),
    popularity: round(meta.popularity, 3),
    popularities: popularities && Object.keys(popularities).length ? popularities : undefined,
    videos: meta.type === "series" ? trimVideos(meta.videos, mode) : undefined,
  };
  for (const key of Object.keys(out) as (keyof StremioMeta)[]) if (out[key] === undefined) delete out[key];
  return out;
}

// -------------------------------------------------------------------- feeds

const catalogUrl = (type: StremioMediaType, catalog: string, extra?: Record<string, string>) =>
  `${BASE}/catalog/${type}/${catalog}${
    extra ? `/${Object.entries(extra).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&")}` : ""
  }.json`;

function feed(state: LoadState, type: StremioMediaType, catalog: string, extra: Record<string, string> | undefined, maxAge: number) {
  const url = catalogUrl(type, catalog, extra);
  return cached<StremioMeta[]>(state, `feed:${url.slice(BASE.length)}`, maxAge, [], async (signal) => {
    const response = await httpJson<{ metas?: StremioMeta[] }>(url, { signal });
    return (response?.metas ?? []).filter((meta) => meta?.id && meta.name).map((meta) => trimMeta(meta));
  });
}

function details(state: LoadState, type: StremioMediaType, id: string) {
  return cached<StremioMeta | null>(state, `meta:${type}:${id}`, type === "series" ? 6 * HOUR : 7 * 24 * HOUR, null, async (signal) => {
    const response = await httpJson<{ meta?: StremioMeta }>(`${BASE}/meta/${type}/${encodeURIComponent(id)}.json`, { signal });
    return response?.meta?.id ? trimMeta(response.meta, "all") : null;
  });
}

/** Shows with their latest and scheduled episodes (Cinemeta calendar-videos). */
function calendar(state: LoadState, ids: string[]) {
  const sorted = [...new Set(ids)].filter((id) => /^tt\d+$/.test(id)).sort();
  const chunks: string[][] = [];
  for (let i = 0; i < sorted.length; i += 40) chunks.push(sorted.slice(i, i + 40));
  return Promise.all(
    chunks.map((chunk) =>
      cached<StremioMeta[]>(state, `calendar:${chunk.join(",")}`, 3 * HOUR, [], async (signal) => {
        const url = `${BASE}/catalog/series/calendar-videos/calendarVideosIds=${chunk.join(",")}.json`;
        const response = await httpJson<{ metasDetailed?: StremioMeta[] }>(url, { signal });
        return (response?.metasDetailed ?? []).filter((meta) => meta?.id).map((meta) => trimMeta({ ...meta, type: "series" }, "all"));
      })
    )
  ).then((lists) => Object.fromEntries(lists.flat().map((meta) => [meta.id, meta])));
}

/** Titles that really credit `person` (Cinemeta's search also matches names in titles). */
function credits(state: LoadState, person: string) {
  return cached<StremioMeta[]>(state, `credits:${person.toLowerCase()}`, 7 * 24 * HOUR, [], async (signal) => {
    const lists = await Promise.all(
      (["movie", "series"] as const).map((type) =>
        httpJson<{ metas?: StremioMeta[] }>(catalogUrl(type, "top", { search: person }), { signal })
          .then((response) => response?.metas ?? [])
          .catch(() => [] as StremioMeta[])
      )
    );
    const wanted = person.toLowerCase();
    return lists
      .flat()
      .filter((meta) => [...(meta.director ?? []), ...(meta.writer ?? []), ...(meta.cast ?? []).slice(0, 6)].some((name) => name?.toLowerCase() === wanted))
      .map((meta) => trimMeta(meta));
  });
}

// --------------------------------------------------------------------- load

export interface DiscoveryLoad {
  data: DiscoveryData;
  /** False when something came from a stale copy or was missing. */
  complete: boolean;
}

/** Favourite genres as Cinemeta genre options, strongest first. */
function tasteGenres(signals: Signals): string[] {
  const weights = new Map<string, number>();
  for (const seed of collectSeeds(signals)) {
    if (seed.weight <= 0) continue;
    for (const genre of seed.item.genres ?? []) {
      const option = CATALOG_GENRES[genre.toLowerCase()] ?? (genre === "Science Fiction" ? "Sci-Fi" : undefined);
      if (option) weights.set(option, (weights.get(option) ?? 0) + seed.weight);
    }
  }
  return [...weights.entries()].sort((a, b) => b[1] - a[1]).map(([genre]) => genre);
}

/** The generic rows a new profile sees, as before personal rows existed. */
export const FALLBACK_GENRES: { type: StremioMediaType; genre: string; title: string }[] = [
  { type: "movie", genre: "Action", title: "Action Movies" },
  { type: "series", genre: "Drama", title: "Drama Series" },
  { type: "movie", genre: "Comedy", title: "Comedy Movies" },
];

export async function loadDiscovery(signals: Signals, options: LoadOptions = {}): Promise<DiscoveryLoad> {
  const state: LoadState = { options, missed: false };
  const now = new Date(signals.now);
  const year = now.getFullYear();
  const years = now.getMonth() <= 2 ? [year, year - 1] : [year];
  const seeds = collectSeeds(signals).filter((seed) => seed.catalog);
  const genres = tasteGenres(signals).slice(0, 4);

  const newFeeds = (type: StremioMediaType) =>
    Promise.all(years.flatMap((y) => [0, 50].map((skip) => feed(state, type, "year", skip ? { genre: String(y), skip: String(skip) } : { genre: String(y) }, 6 * HOUR)))).then((lists) => lists.flat());

  const genreKeys = [
    ...FALLBACK_GENRES.map(({ type, genre }) => ({ type, genre })),
    ...genres.flatMap((genre) => (["movie", "series"] as const).map((type) => ({ type, genre }))),
  ].filter((entry, index, all) => all.findIndex((other) => other.type === entry.type && other.genre === entry.genre) === index);

  const seriesIds = seeds
    .filter((seed) => seed.type === "series" && !seed.disliked && !seed.abandoned && seed.entry)
    .sort((a, b) => b.at - a.at)
    .slice(0, 80)
    .map((seed) => seed.id);
  const anchorSeeds = [
    ...seeds.filter((seed) => seed.weight > 0).slice(0, 10),
    ...seeds.filter((seed) => seed.weight < 0).slice(-4),
  ];

  const [trendingMovies, trendingSeries, newMovies, newSeries, featured, catalog, byGenre, shows, seedDetails] = await Promise.all([
    feed(state, "movie", "top", undefined, 6 * HOUR),
    feed(state, "series", "top", undefined, 6 * HOUR),
    newFeeds("movie"),
    newFeeds("series"),
    Promise.all((["movie", "series"] as const).map((type) => feed(state, type, "imdbRating", undefined, 24 * HOUR))).then((lists) => lists.flat()),
    Promise.all(["1990", "2000", "2010"].flatMap((y) => (["movie", "series"] as const).map((type) => feed(state, type, "year", { genre: y }, 24 * HOUR)))).then((lists) => lists.flat()),
    Promise.all(genreKeys.map(async ({ type, genre }) => [`${type}:${genre}`, await feed(state, type, "top", { genre }, 24 * HOUR)] as const)).then(Object.fromEntries),
    seriesIds.length ? calendar(state, seriesIds) : Promise.resolve({} as Record<string, StremioMeta>),
    Promise.all(anchorSeeds.map((seed) => details(state, seed.type, seed.id))),
  ]);

  const data: DiscoveryData = {
    ...emptyDiscoveryData(),
    trendingMovies,
    trendingSeries,
    newMovies,
    newSeries,
    featured,
    catalog,
    byGenre,
    calendar: shows,
  };
  for (const meta of seedDetails) if (meta) data.details[keyOf(meta)] = meta;

  // Second pass: people from the profile, and full episode lists for shows
  // whose calendar starts after the viewer's episode but has something recent.
  const known = (key: string) => data.details[key];
  const index = new FeatureIndex(seedDetails.filter((meta): meta is StremioMeta => !!meta));
  const profile = buildProfile(collectSeeds(signals, known), index);
  const people = [...profile.people.entries()].filter(([, value]) => value >= 0.35).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name]) => name);
  const needsEpisodes = seeds
    .filter((seed) => seed.type === "series" && seed.entry && !data.details[seed.key] && shows[seed.id])
    .filter((seed) => {
      const episodes = datedEpisodes(shows[seed.id].videos);
      const aired = airedBy(episodes, signals.now);
      const latest = aired[aired.length - 1];
      const place = { season: seed.entry!.season ?? 1, episode: seed.entry!.episode ?? 1 };
      return !!latest && signals.now - latest.at <= 180 * DAY && compareEpisodes(episodes[0], place) > 0;
    })
    .slice(0, 8);
  const late = Symbol("late");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof late>((resolve) => {
    timer = setTimeout(() => resolve(late), options.secondPassMs ?? 2_500);
  });
  const inTime = <T,>(work: Promise<T>, fallback: T) =>
    Promise.race([work, deadline]).then((value) => {
      if (value !== late) return value as T;
      state.missed = true;
      return fallback;
    });
  const [personCredits, showDetails] = await Promise.all([
    Promise.all(people.map((person) => inTime(credits(state, person).then((list) => [person, list] as const), [person, []] as const))),
    Promise.all(needsEpisodes.map((seed) => inTime(details(state, "series", seed.id), null))),
  ]).finally(() => clearTimeout(timer));
  for (const [person, list] of personCredits) if (list.length) data.credits[person] = list;
  for (const meta of showDetails) if (meta) data.details[keyOf(meta)] = meta;

  return { data, complete: !state.missed };
}
