/**
 * Release and air-date handling for discovery rows. Only dates that the
 * catalogue actually supplies are used: a title or episode without a date is
 * never treated as new, and nothing is estimated from a bare year.
 */
import type { StremioMeta, StremioVideo } from "@/types/stremio";

export const DAY = 86_400_000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/** Epoch ms for an ISO date string, or null when it is missing or malformed. */
export function parseDate(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/** A title's own release date (first air date for series). */
export const releasedAt = (item: Pick<StremioMeta, "released">): number | null => parseDate(item.released);

/**
 * A date without a time of day. Cinemeta stores film releases at midnight
 * UTC; shown in the viewer's zone they would slip to the day before in the
 * Americas, so they keep their calendar date. Episode air times are real
 * moments and are shown in the viewer's zone.
 */
export const isDateOnly = (value: unknown) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}(T00:00(:00(\.0+)?)?Z)?$/.test(value);

export interface Episode {
  season: number;
  episode: number;
  /** Air date, epoch ms. */
  at: number;
  /** The catalogue gave a day, not a time (see isDateOnly). */
  dateOnly?: boolean;
  name?: string;
}

/** Numbered, dated episodes in air order. Specials (season 0) are left out. */
export function datedEpisodes(videos: StremioVideo[] | undefined): Episode[] {
  const out: Episode[] = [];
  const seen = new Set<string>();
  for (const video of videos ?? []) {
    const season = Number(video.season);
    const episode = Number(video.episode ?? video.number);
    const raw = parseDate(video.released) !== null ? video.released : video.firstAired;
    const at = parseDate(raw);
    if (!Number.isInteger(season) || season < 1 || !Number.isInteger(episode) || episode < 1 || at === null) continue;
    const key = `${season}:${episode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ season, episode, at, dateOnly: isDateOnly(raw) || undefined, name: video.name ?? video.title });
  }
  return out.sort(compareEpisodes);
}

export function compareEpisodes(a: Pick<Episode, "season" | "episode">, b: Pick<Episode, "season" | "episode">) {
  return a.season - b.season || a.episode - b.episode;
}

/** Episodes that have aired by `now`. */
export const airedBy = (episodes: Episode[], now: number) => episodes.filter((episode) => episode.at <= now);

/** Aired episodes after the viewer's place in the show. */
export function airedAfter(episodes: Episode[], place: { season: number; episode: number }, now: number): Episode[] {
  return airedBy(episodes, now).filter((episode) => compareEpisodes(episode, place) > 0);
}

/** Scheduled episodes between now and `days` ahead, soonest first. */
export function upcoming(episodes: Episode[], now: number, days: number): Episode[] {
  return episodes.filter((episode) => episode.at > now && episode.at <= now + days * DAY).sort((a, b) => a.at - b.at);
}

/** The newest season that has started airing, with the air date of its first dated episode. */
export function latestStartedSeason(episodes: Episode[], now: number): { season: number; at: number } | null {
  const aired = airedBy(episodes, now);
  if (!aired.length) return null;
  const season = aired[aired.length - 1].season;
  const first = aired.find((episode) => episode.season === season)!;
  return { season, at: first.at };
}

/**
 * Whole calendar days from `at` to `now` in the viewer's time zone (0 = the
 * same day). `timeZone` is only for tests.
 */
export function calendarDaysAgo(at: number, now: number, timeZone?: string, dateOnly = false): number {
  const day = (value: number, zone?: string) => {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
    return Date.parse(`${parts}T00:00:00Z`);
  };
  return Math.round((day(now, timeZone) - day(at, dateOnly ? "UTC" : timeZone)) / DAY);
}

/** "Today", "Yesterday", "Oct 14" for past dates; "Tomorrow", "Wed Oct 21" for scheduled ones. */
export function dayLabel(at: number, now: number, timeZone?: string, dateOnly = false): string {
  const ago = calendarDaysAgo(at, now, timeZone, dateOnly);
  if (ago === 0) return "Today";
  if (ago === 1) return "Yesterday";
  if (ago === -1) return "Tomorrow";
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: dateOnly ? "UTC" : timeZone,
    month: "short",
    day: "numeric",
    ...(ago < 0 && ago > -7 ? { weekday: "short" as const } : {}),
    ...(Math.abs(ago) > 300 ? { year: "numeric" as const } : {}),
  });
  return format.format(at).replace(",", "");
}
