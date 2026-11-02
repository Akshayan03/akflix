/**
 * Which episodes of a show were watched, and where a part-watched one stopped:
 * the episode list's Watched marks, progress lines and "Resume 13:32". Continue
 * Watching keeps one row per show (historyStore); this keeps every episode.
 */

/** An episode counts as watched from here (end credits included). */
export const WATCHED_PERCENT = 90;

export interface EpisodeMark {
  /** Seconds in, while part-watched. */
  position: number;
  /** 0–100. */
  progress: number;
  watched: boolean;
}

/** One show: "season:episode" → mark, and when it last changed. */
export interface ShowMarks {
  episodes: Record<string, EpisodeMark>;
  updatedAt: number;
}

export const episodeKey = (season: number, episode: number) => `${season}:${episode}`;

const EMPTY: EpisodeMark = { position: 0, progress: 0, watched: false };

export function episodeMark(show: ShowMarks | undefined, season: number, episode: number): EpisodeMark {
  return show?.episodes[episodeKey(season, episode)] ?? EMPTY;
}

/**
 * The show with one episode changed. `watched` true / false marks it by hand;
 * undefined derives it from how far it got. A mark with nothing left to say
 * (unwatched, not started) is dropped.
 */
export function withEpisode(
  show: ShowMarks | undefined,
  season: number,
  episode: number,
  change: { watched?: boolean; position?: number; duration?: number },
  now = Date.now(),
): ShowMarks {
  const episodes = { ...(show?.episodes ?? {}) };
  const key = episodeKey(season, episode);
  const position = Math.max(0, change.position ?? 0);
  const duration = Math.max(0, change.duration ?? 0);
  const progress = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
  const watched = change.watched ?? progress >= WATCHED_PERCENT;
  if (watched) episodes[key] = { position: 0, progress: 100, watched: true };
  else if (change.watched === false || position < 10) delete episodes[key];
  else episodes[key] = { position: Math.round(position), progress: Math.round(progress * 10) / 10, watched: false };
  return { episodes, updatedAt: now };
}

/** A whole season (its episode numbers) watched or not. */
export function withSeason(show: ShowMarks | undefined, season: number, numbers: number[], watched: boolean, now = Date.now()): ShowMarks {
  let next: ShowMarks = show ?? { episodes: {}, updatedAt: now };
  for (const number of numbers) next = withEpisode(next, season, number, { watched }, now);
  return { ...next, updatedAt: now };
}

export function seasonWatched(show: ShowMarks | undefined, season: number, numbers: number[]): boolean {
  return numbers.length > 0 && numbers.every((number) => episodeMark(show, season, number).watched);
}

/** Keeps the shows changed last (a small, bounded localStorage record). */
export function trimShows(shows: Record<string, ShowMarks>, limit = 120): Record<string, ShowMarks> {
  const keys = Object.keys(shows);
  if (keys.length <= limit) return shows;
  const kept = keys.sort((a, b) => shows[b].updatedAt - shows[a].updatedAt).slice(0, limit);
  return Object.fromEntries(kept.map((key) => [key, shows[key]]));
}

/** "13:32" / "1:02:05". */
export function resumeClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
