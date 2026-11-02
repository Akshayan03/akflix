import { cinemeta } from "@/api/cinemeta";
import { useHistory, type WatchHistoryEntry } from "@/stores/historyStore";
import { useEpisodes } from "@/stores/episodeStore";
import type { StremioVideo } from "@/types/stremio";

/** The episode after `season`/`episode` in Cinemeta's order (specials left out), or null. */
export function episodeAfter(videos: StremioVideo[] | undefined, season: number, episode: number): StremioVideo | null {
  const ordered = (videos ?? [])
    .filter((video) => video.season > 0 && video.episode > 0)
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
  return ordered.find((video) => video.season > season || (video.season === season && video.episode > episode)) ?? null;
}

/**
 * "Mark as watched" on a Continue Watching card: a film is finished; a show's
 * current episode is marked watched and the row moves on to the next one at
 * 0 s (or the show is finished after its last episode), as finishing it would.
 */
export async function markContinueWatched(entry: WatchHistoryEntry, signal?: AbortSignal): Promise<void> {
  const history = useHistory.getState();
  if (entry.media.type === "movie" || !entry.season || !entry.episode) {
    const length = entry.duration > 0 ? entry.duration : 1;
    history.recordProgress(entry.media, length, length, { completed: true });
    return;
  }
  useEpisodes.getState().setWatched(entry.media.id, entry.season, entry.episode, true);
  const meta = await cinemeta.meta("series", entry.media.id, signal);
  const next = episodeAfter(meta.videos, entry.season, entry.episode);
  if (next) {
    history.recordProgress(entry.media, 0, 0, {
      subtitle: `S${next.season} E${next.episode} · ${next.name ?? next.title ?? `Episode ${next.episode}`}`,
      season: next.season,
      episode: next.episode,
      upNext: true,
    });
  } else {
    history.recordProgress(entry.media, 1, 1, { season: entry.season, episode: entry.episode, subtitle: entry.subtitle, completed: true });
  }
}
