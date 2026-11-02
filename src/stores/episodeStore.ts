import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { safeStateStorage } from "@/lib/safeStorage";
import { selftestActive } from "@/lib/selftestFlag";
import { useAuth } from "@/stores/authStore";
import { trimShows, withEpisode, withSeason, type ShowMarks } from "@/lib/episodeMarks";

/** Every episode's Watched mark and resume point, per profile and show (lib/episodeMarks). */
interface EpisodeState {
  /** `${profileId}|${showId}` → marks. */
  shows: Record<string, ShowMarks>;
  record: (showId: string, season: number, episode: number, position: number, duration: number, finished?: boolean) => void;
  setWatched: (showId: string, season: number, episode: number, watched: boolean) => void;
  setSeasonWatched: (showId: string, season: number, numbers: number[], watched: boolean) => void;
}

function showKey(showId: string): string {
  return `${useAuth.getState().activeProfileId ?? "akflix-local"}|${showId}`;
}

export const useEpisodes = create<EpisodeState>()(
  persist(
    (set) => ({
      shows: {},
      record: (showId, season, episode, position, duration, finished = false) => {
        if (selftestActive() || !showId || !(season > 0) || !(episode > 0)) return;
        const key = showKey(showId);
        set((state) => ({
          shows: trimShows({
            ...state.shows,
            [key]: withEpisode(state.shows[key], season, episode, finished ? { watched: true } : { position, duration }),
          }),
        }));
      },
      setWatched: (showId, season, episode, watched) => {
        const key = showKey(showId);
        set((state) => ({ shows: trimShows({ ...state.shows, [key]: withEpisode(state.shows[key], season, episode, { watched }) }) }));
      },
      setSeasonWatched: (showId, season, numbers, watched) => {
        const key = showKey(showId);
        set((state) => ({ shows: trimShows({ ...state.shows, [key]: withSeason(state.shows[key], season, numbers, watched) }) }));
      },
    }),
    {
      name: "akflix.episodes",
      storage: createJSONStorage(() => safeStateStorage),
      version: 1,
      partialize: (state) => ({ shows: state.shows }),
    }
  )
);

/** This show's marks for the active profile (a hook). */
export function useShowMarks(showId: string | undefined): ShowMarks | undefined {
  return useEpisodes((state) => (showId ? state.shows[showKey(showId)] : undefined));
}
