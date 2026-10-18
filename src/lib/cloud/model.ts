/**
 * The account sync model, kept pure so every merge rule is unit tested.
 *
 * One cloud record per title per profile (so Continue Watching can never
 * hold duplicates). Each record has independent facets, each with its own
 * timestamp, merged last-writer-wins:
 *   watch  – Continue Watching pointer: exact season/episode, position,
 *            duration, completed; `removed` when dismissed from the row
 *   list   – saved to My List or not
 *   rating – personal 1-5 rating, 0 when cleared
 * Titles are keyed `${type}:${imdbId}`, the same ids Mac, iPhone and Roku use.
 */
import type { CloudJournal } from "@/lib/cloud/journal";
import { journalKey } from "@/lib/cloud/journal";
import { safeDocId } from "@/lib/cloud/firestore";
import type { HistoryTitle, PersonalRating, WatchHistoryEntry } from "@/stores/historyStore";
import type { SavedTitle } from "@/stores/listStore";

export type CloudMediaType = "movie" | "series";

export interface CloudMeta {
  name: string;
  poster?: string;
  background?: string;
  description?: string;
  releaseInfo?: string;
  year?: string;
  imdbRating?: string;
  genres?: string[];
}

export interface WatchFacet {
  at: number;
  removed?: boolean;
  position: number;
  duration: number;
  progress: number;
  completed: boolean;
  season?: number;
  episode?: number;
  subtitle?: string;
}

export interface ListFacet {
  at: number;
  saved: boolean;
}

export interface RatingFacet {
  at: number;
  value: number;
}

export interface CloudTitle {
  key: string;
  type: CloudMediaType;
  id: string;
  meta: CloudMeta;
  watch?: WatchFacet;
  list?: ListFacet;
  rating?: RatingFacet;
}

export interface LocalSnapshot {
  entries: WatchHistoryEntry[];
  ratings: PersonalRating[];
  list: SavedTitle[];
  journal: CloudJournal;
}

export const titleKey = (type: string, id: string) => `${type}:${id}`;

/** Must match the Roku channel's akCloudDocId(). */
export const titleDocId = (type: string, id: string) => `${type}-${safeDocId(id)}`;

const tenth = (value: number) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : 0);
const hundredth = (value: number) => (Number.isFinite(value) ? Math.round(value * 100) / 100 : 0);
const whole = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined);
const text = (value: unknown, max = 300) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

/** JSON with sorted keys, so equal values always compare equal. */
export function stable(value: unknown): string {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(",")}}`;
}

function compact<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) if (member !== undefined) out[key] = member;
  return out as T;
}

export function metaFromMedia(media: Pick<HistoryTitle, "name" | "poster" | "background" | "description" | "releaseInfo" | "year" | "imdbRating" | "genres">): CloudMeta {
  const genres = Array.isArray(media.genres) ? media.genres.filter((genre) => typeof genre === "string" && genre).slice(0, 8) : [];
  return compact({
    name: text(media.name, 200) ?? "",
    poster: text(media.poster, 600),
    background: text(media.background, 600),
    description: text(media.description, 600),
    releaseInfo: text(media.releaseInfo, 40),
    year: text(media.year, 20),
    imdbRating: text(media.imdbRating, 10),
    genres: genres.length ? genres : undefined,
  });
}

export function mediaFromTitle(title: CloudTitle): HistoryTitle {
  return compact({
    source: "discover" as const,
    id: title.id,
    type: title.type,
    name: title.meta.name || title.id,
    poster: title.meta.poster,
    background: title.meta.background,
    description: title.meta.description,
    releaseInfo: title.meta.releaseInfo,
    year: title.meta.year,
    imdbRating: title.meta.imdbRating,
    genres: title.meta.genres,
  });
}

export function watchFromEntry(entry: WatchHistoryEntry): WatchFacet {
  return compact({
    at: Math.round(entry.updatedAt),
    position: tenth(entry.position),
    duration: tenth(entry.duration),
    progress: hundredth(entry.progress),
    completed: entry.completed === true,
    season: whole(entry.season),
    episode: whole(entry.episode),
    subtitle: text(entry.subtitle, 200),
  });
}

export function entryFromWatch(profileId: string, title: CloudTitle, watch: WatchFacet): WatchHistoryEntry {
  return compact({
    profileId,
    media: mediaFromTitle(title),
    position: watch.position,
    duration: watch.duration,
    progress: watch.progress,
    completed: watch.completed,
    subtitle: watch.subtitle,
    season: watch.season,
    episode: watch.episode,
    updatedAt: watch.at,
  });
}

const removedWatch = (at: number): WatchFacet => ({ at, removed: true, position: 0, duration: 0, progress: 0, completed: false });

function newestAt(title: CloudTitle | undefined) {
  return Math.max(title?.watch?.at ?? 0, title?.list?.at ?? 0, title?.rating?.at ?? 0);
}

/** Last writer wins; an exact tie is broken by content so both sides agree. */
export function pickFacet<T extends { at: number }>(a: T | undefined, b: T | undefined): T | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.at !== b.at) return a.at > b.at ? a : b;
  return stable(a) >= stable(b) ? a : b;
}

/** Symmetric: mergeTitles(a, b) and mergeTitles(b, a) give the same record. */
export function mergeTitles(a: CloudTitle | undefined, b: CloudTitle | undefined): CloudTitle | undefined {
  if (!a) return b;
  if (!b) return a;
  const aAt = newestAt(a);
  const bAt = newestAt(b);
  const primary = aAt !== bAt ? (aAt > bAt ? a : b) : stable(a.meta) >= stable(b.meta) ? a : b;
  const secondary = primary === a ? b : a;
  return compact({
    key: primary.key,
    type: primary.type,
    id: primary.id,
    meta: { ...secondary.meta, ...primary.meta, name: primary.meta.name || secondary.meta.name },
    watch: pickFacet(a.watch, b.watch),
    list: pickFacet(a.list, b.list),
    rating: pickFacet(a.rating, b.rating),
  });
}

/** What sync compares; titles' display metadata alone never causes a write. */
export function fingerprint(title: CloudTitle | undefined): string {
  if (!title) return "";
  return stable({ watch: title.watch, list: title.list, rating: title.rating });
}

/** Builds this device's view of every catalog title for one local profile. */
export function localTitles(profileId: string, snapshot: LocalSnapshot): Map<string, CloudTitle> {
  const titles = new Map<string, CloudTitle>();
  const ensure = (media: HistoryTitle): CloudTitle => {
    const key = titleKey(media.type, media.id);
    let title = titles.get(key);
    if (!title) {
      title = { key, type: media.type, id: media.id, meta: metaFromMedia(media) };
      titles.set(key, title);
    }
    return title;
  };

  for (const entry of snapshot.entries) {
    if (entry.profileId !== profileId || entry.media?.source !== "discover" || !entry.media.id) continue;
    const title = ensure(entry.media);
    const watch = watchFromEntry(entry);
    title.watch = pickFacet(title.watch, watch);
  }
  for (const item of snapshot.list) {
    if (item.profileId !== profileId || item.media?.source !== "discover" || !item.media.id) continue;
    const title = ensure(item.media);
    title.list = pickFacet(title.list, { at: Math.round(item.at), saved: item.saved === true });
  }
  for (const rating of snapshot.ratings) {
    if (rating.profileId !== profileId || rating.media?.source !== "discover" || !rating.media.id) continue;
    const title = ensure(rating.media);
    title.rating = pickFacet(title.rating, { at: Math.round(rating.updatedAt), value: Math.max(1, Math.min(5, Math.round(rating.value))) });
  }

  // Removals and cleared ratings only matter when nothing newer replaced them.
  const prefix = `${profileId}|`;
  for (const [journalId, at] of Object.entries(snapshot.journal.watchRemoved)) {
    if (!journalId.startsWith(prefix)) continue;
    const title = titles.get(journalId.slice(prefix.length));
    if (title && (!title.watch || title.watch.at < at)) title.watch = removedWatch(at);
  }
  for (const [journalId, at] of Object.entries(snapshot.journal.ratingCleared)) {
    if (!journalId.startsWith(prefix)) continue;
    const title = titles.get(journalId.slice(prefix.length));
    if (title && (!title.rating || title.rating.at < at)) title.rating = { at, value: 0 };
  }
  return titles;
}

/**
 * Tombstones for titles this device no longer has any row for. They need
 * metadata from the cloud copy, so the engine passes the mirror in.
 */
export function addRemovalTombstones(
  profileId: string,
  titles: Map<string, CloudTitle>,
  journal: CloudJournal,
  remote: (key: string) => CloudTitle | undefined
) {
  const prefix = `${profileId}|`;
  const add = (map: Record<string, number>, facet: "watch" | "rating") => {
    for (const [journalId, at] of Object.entries(map)) {
      if (!journalId.startsWith(prefix)) continue;
      const key = journalId.slice(prefix.length);
      if (titles.has(key)) continue;
      const cloud = remote(key);
      if (!cloud) continue;
      const title: CloudTitle = { key, type: cloud.type, id: cloud.id, meta: cloud.meta };
      if (facet === "watch") title.watch = removedWatch(at);
      else title.rating = { at, value: 0 };
      titles.set(key, title);
    }
  };
  add(journal.watchRemoved, "watch");
  add(journal.ratingCleared, "rating");
  // A title with both tombstones needs both facets.
  for (const [journalId, at] of Object.entries(journal.ratingCleared)) {
    if (!journalId.startsWith(prefix)) continue;
    const title = titles.get(journalId.slice(prefix.length));
    if (title && (!title.rating || title.rating.at < at)) title.rating = { at, value: 0 };
  }
}

export interface LocalPatch {
  entries: WatchHistoryEntry[];
  removeEntries: string[];
  ratings: PersonalRating[];
  removeRatings: string[];
  list: SavedTitle[];
  watchTombstones: [string, number][];
  ratingTombstones: [string, number][];
}

export const emptyPatch = (): LocalPatch => ({
  entries: [],
  removeEntries: [],
  ratings: [],
  removeRatings: [],
  list: [],
  watchTombstones: [],
  ratingTombstones: [],
});

export function patchIsEmpty(patch: LocalPatch) {
  return !patch.entries.length && !patch.removeEntries.length && !patch.ratings.length && !patch.removeRatings.length && !patch.list.length;
}

/** Adds to `patch` whatever this device must change to match `merged`. */
export function collectLocalChanges(profileId: string, merged: CloudTitle, local: CloudTitle | undefined, patch: LocalPatch) {
  if (merged.watch && stable(merged.watch) !== stable(local?.watch)) {
    if (merged.watch.removed) {
      if (local?.watch && !local.watch.removed) patch.removeEntries.push(merged.key);
      patch.watchTombstones.push([merged.key, merged.watch.at]);
    } else {
      patch.entries.push(entryFromWatch(profileId, merged, merged.watch));
    }
  }
  if (merged.rating && stable(merged.rating) !== stable(local?.rating)) {
    if (merged.rating.value > 0) {
      patch.ratings.push({ profileId, media: mediaFromTitle(merged), value: merged.rating.value, updatedAt: merged.rating.at });
    } else {
      if (local?.rating && local.rating.value > 0) patch.removeRatings.push(merged.key);
      patch.ratingTombstones.push([merged.key, merged.rating.at]);
    }
  }
  if (merged.list && stable(merged.list) !== stable(local?.list)) {
    patch.list.push({ profileId, media: mediaFromTitle(merged), saved: merged.list.saved, at: merged.list.at });
  }
}

export function journalWithPatch(journal: CloudJournal, profileId: string, patch: LocalPatch): CloudJournal {
  const next: CloudJournal = {
    watchRemoved: { ...journal.watchRemoved },
    ratingCleared: { ...journal.ratingCleared },
    settingsAt: journal.settingsAt,
  };
  for (const [key, at] of patch.watchTombstones) next.watchRemoved[journalKey(profileId, key)] = Math.max(at, next.watchRemoved[journalKey(profileId, key)] ?? 0);
  for (const [key, at] of patch.ratingTombstones) next.ratingCleared[journalKey(profileId, key)] = Math.max(at, next.ratingCleared[journalKey(profileId, key)] ?? 0);
  return next;
}

// ---------------------------------------------------------------- documents

export function titleToDoc(title: CloudTitle): Record<string, unknown> {
  return compact({
    v: 1,
    key: title.key,
    type: title.type,
    id: title.id,
    meta: title.meta,
    watch: title.watch,
    list: title.list,
    rating: title.rating,
    updatedAt: newestAt(title),
  });
}

function asWatch(value: unknown): WatchFacet | undefined {
  const raw = value as Partial<WatchFacet> | null;
  if (!raw || typeof raw !== "object" || typeof raw.at !== "number") return undefined;
  if (raw.removed) return removedWatch(raw.at);
  return compact({
    at: raw.at,
    position: tenth(Number(raw.position ?? 0)),
    duration: tenth(Number(raw.duration ?? 0)),
    progress: hundredth(Number(raw.progress ?? 0)),
    completed: raw.completed === true,
    season: whole(raw.season),
    episode: whole(raw.episode),
    subtitle: text(raw.subtitle, 200),
  });
}

export function titleFromDoc(data: Record<string, unknown>): CloudTitle | null {
  const id = data.id;
  if ((data.type !== "movie" && data.type !== "series") || typeof id !== "string" || !id) return null;
  const type: CloudMediaType = data.type;
  const meta = (data.meta ?? {}) as Partial<CloudMeta>;
  const list = data.list as Partial<ListFacet> | undefined;
  const rating = data.rating as Partial<RatingFacet> | undefined;
  return compact({
    key: titleKey(type, id),
    type,
    id,
    meta: metaFromMedia({ ...meta, name: meta.name ?? "" } as HistoryTitle),
    watch: asWatch(data.watch),
    list: list && typeof list.at === "number" ? { at: list.at, saved: list.saved === true } : undefined,
    rating:
      rating && typeof rating.at === "number"
        ? { at: rating.at, value: Math.max(0, Math.min(5, Math.round(Number(rating.value ?? 0)))) }
        : undefined,
  });
}

// ----------------------------------------------------------------- settings

export interface CloudSettings {
  values: Record<string, unknown>;
  at: Record<string, number>;
}

export function mergeSettings(a: CloudSettings | null, b: CloudSettings | null): CloudSettings | null {
  if (!a) return b;
  if (!b) return a;
  const values: Record<string, unknown> = {};
  const at: Record<string, number> = {};
  for (const key of new Set([...Object.keys(a.values), ...Object.keys(b.values)])) {
    const left = key in a.values ? { at: a.at[key] ?? 0, value: a.values[key] } : undefined;
    const right = key in b.values ? { at: b.at[key] ?? 0, value: b.values[key] } : undefined;
    const winner = pickFacet(left, right);
    if (!winner) continue;
    values[key] = winner.value;
    at[key] = winner.at;
  }
  return { values, at };
}

export const settingsFingerprint = (value: CloudSettings | null) => (value ? stable(value) : "");
