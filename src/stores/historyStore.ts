import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useAuth } from "@/stores/authStore";

export type HistoryMediaType = "movie" | "series";
export type HistoryMediaSource = "discover" | "jellyfin";

export interface HistoryTitle {
  source: HistoryMediaSource;
  id: string;
  type: HistoryMediaType;
  name: string;
  poster?: string | null;
  background?: string | null;
  description?: string;
  releaseInfo?: string;
  year?: string;
  imdbRating?: string;
  genres?: string[];
}

export interface WatchHistoryEntry {
  profileId: string;
  media: HistoryTitle;
  position: number;
  duration: number;
  progress: number;
  completed: boolean;
  subtitle?: string;
  season?: number;
  episode?: number;
  updatedAt: number;
}

export interface PersonalRating {
  profileId: string;
  media: HistoryTitle;
  value: number;
  updatedAt: number;
}

interface HistoryState {
  entries: WatchHistoryEntry[];
  ratings: PersonalRating[];
  recordProgress: (
    media: HistoryTitle,
    position: number,
    duration: number,
    details?: { subtitle?: string; season?: number; episode?: number; completed?: boolean }
  ) => void;
  setRating: (media: HistoryTitle, value: number | null) => void;
  removeEntry: (media: HistoryTitle) => void;
}

export function historyMediaKey(media: Pick<HistoryTitle, "source" | "type" | "id">): string {
  return `${media.source}:${media.type}:${media.id}`;
}

function activeProfileId(): string {
  return useAuth.getState().activeProfileId ?? "akflix-local";
}

export const useHistory = create<HistoryState>()(
  persist(
    (set) => ({
      entries: [],
      ratings: [],

      recordProgress: (media, rawPosition, rawDuration, details = {}) => {
        const profileId = activeProfileId();
        const position = Number.isFinite(rawPosition) ? Math.max(0, rawPosition) : 0;
        const duration = Number.isFinite(rawDuration) ? Math.max(0, rawDuration) : 0;
        if (!details.completed && position < 10) return;
        const progress = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
        const completed = details.completed === true || (duration > 0 && progress >= 92);
        const key = historyMediaKey(media);

        set((state) => {
          const existingIndex = state.entries.findIndex(
            (entry) => entry.profileId === profileId && historyMediaKey(entry.media) === key
          );
          const entry: WatchHistoryEntry = {
            profileId,
            media,
            position: completed ? duration || position : position,
            duration,
            progress: completed ? 100 : progress,
            completed,
            subtitle: details.subtitle,
            season: details.season,
            episode: details.episode,
            updatedAt: Date.now(),
          };
          const entries = [...state.entries];
          if (existingIndex >= 0) entries[existingIndex] = entry;
          else entries.push(entry);
          return { entries: entries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200) };
        });
      },

      setRating: (media, value) => {
        const profileId = activeProfileId();
        const key = historyMediaKey(media);
        set((state) => {
          const withoutCurrent = state.ratings.filter(
            (rating) =>
              rating.profileId !== profileId || historyMediaKey(rating.media) !== key
          );
          if (value === null) return { ratings: withoutCurrent };
          const safeValue = Math.max(1, Math.min(5, Math.round(value)));
          return {
            ratings: [
              { profileId, media, value: safeValue, updatedAt: Date.now() },
              ...withoutCurrent,
            ].slice(0, 500),
          };
        });
      },

      removeEntry: (media) => {
        const profileId = activeProfileId();
        const key = historyMediaKey(media);
        set((state) => ({
          entries: state.entries.filter(
            (entry) => entry.profileId !== profileId || historyMediaKey(entry.media) !== key
          ),
        }));
      },
    }),
    {
      name: "akflix.history",
      version: 1,
      partialize: (state) => ({ entries: state.entries, ratings: state.ratings }),
    }
  )
);
