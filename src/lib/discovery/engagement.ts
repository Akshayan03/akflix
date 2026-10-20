/**
 * Rewatches and binge sessions, derived from the Continue Watching pointer as
 * it moves. The history keeps one row per title, so these counts are the only
 * record that a film was finished before it was started again, or that a run
 * of episodes was watched back to back. They sync with the account as their
 * own facet (lib/cloud/model.ts), so every device ranks with the same history.
 */
import type { HistoryTitle, WatchHistoryEntry } from "@/stores/historyStore";

export interface EngagementStats {
  /** Times finished: a film's completions, or a series' finished episodes. */
  plays: number;
  /** A finished film started again, or an earlier episode watched again. */
  rewatches: number;
  /** Sessions of three or more episodes of the series finished within 8 hours. */
  binges: number;
  lastFinishedAt?: number;
  /** Last change, epoch ms (account sync is last-writer-wins on this). */
  at: number;
}

export interface EngagementRow extends EngagementStats {
  profileId: string;
  media: HistoryTitle;
  /** This device only: recent episode finishes, for spotting a binge. */
  recent?: number[];
  lastBingeAt?: number;
  lastRewatchAt?: number;
}

export type WatchEvent = "finished" | "restarted";

const BINGE_WINDOW = 8 * 60 * 60 * 1000;
const BINGE_EPISODES = 3;
const REWATCH_GAP = 12 * 60 * 60 * 1000;

const place = (entry: Pick<WatchHistoryEntry, "season" | "episode">) =>
  entry.season && entry.episode ? entry.season * 10_000 + entry.episode : 0;

/** What a progress write means, given the row it replaces. */
export function watchEvents(
  previous: WatchHistoryEntry | undefined,
  next: WatchHistoryEntry,
  upNext = false
): WatchEvent[] {
  const events: WatchEvent[] = [];
  if (next.media.type === "movie") {
    if (next.completed && !previous?.completed) events.push("finished");
    else if (previous?.completed && !next.completed) events.push("restarted");
    return events;
  }
  const before = previous ? place(previous) : 0;
  const after = place(next);
  if (previous && before && after > before && (upNext || previous.progress >= 85)) events.push("finished");
  else if (previous && before && after && after < before) events.push("restarted");
  if (next.completed && !previous?.completed) events.push("finished");
  else if (previous?.completed && !next.completed && !events.includes("restarted")) events.push("restarted");
  return events;
}

export function emptyEngagement(profileId: string, media: HistoryTitle, at: number): EngagementRow {
  return { profileId, media, plays: 0, rewatches: 0, binges: 0, at };
}

/** The row after `events`; returns the same object when nothing changed. */
export function applyWatchEvents(row: EngagementRow, events: WatchEvent[], now: number, type: HistoryTitle["type"]): EngagementRow {
  if (!events.length) return row;
  let next = row;
  for (const event of events) {
    if (event === "restarted") {
      if (next.lastRewatchAt && now - next.lastRewatchAt < REWATCH_GAP) continue;
      next = { ...next, rewatches: next.rewatches + 1, lastRewatchAt: now, at: now };
      continue;
    }
    const recent = type === "series" ? [...(next.recent ?? []).filter((at) => now - at < BINGE_WINDOW), now].slice(-6) : next.recent;
    const sameSession = next.lastBingeAt !== undefined && now - next.lastBingeAt < BINGE_WINDOW;
    const binge = type === "series" && (recent?.length ?? 0) >= BINGE_EPISODES && !sameSession;
    next = {
      ...next,
      plays: next.plays + 1,
      lastFinishedAt: now,
      recent,
      binges: next.binges + (binge ? 1 : 0),
      lastBingeAt: binge ? now : next.lastBingeAt,
      at: now,
    };
  }
  return next;
}
