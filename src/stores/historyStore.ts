import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { safeStateStorage } from "@/lib/safeStorage";
import { useAuth } from "@/stores/authStore";
import { noteRatingCleared, noteWatchRemoved } from "@/lib/cloud/journal";

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
    details?: {
      subtitle?: string;
      season?: number;
      episode?: number;
      completed?: boolean;
      upNext?: boolean;
    }
  ) => void;
  setRating: (media: HistoryTitle, value: number | null) => void;
  removeEntry: (media: HistoryTitle) => void;
  /**
   * Account sync: adopts newer copies from another device as-is (their own
   * timestamps), and drops rows another device removed later.
   */
  applyCloud: (change: {
    entries: WatchHistoryEntry[];
    removeEntries: { profileId: string; key: string }[];
    ratings: PersonalRating[];
    removeRatings: { profileId: string; key: string }[];
  }) => void;
}

export function historyMediaKey(media: Pick<HistoryTitle, "source" | "type" | "id">): string {
  return `${media.source}:${media.type}:${media.id}`;
}

const HISTORY_LIMIT = 200;
const RATING_LIMIT = 500;

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
        if (!details.completed && !details.upNext && position < 10) return;
        const progress = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
        // Finishing an episode does not mean the whole series is finished.
        // Series are completed explicitly only after their final episode.
        const completed =
          details.completed === true ||
          (media.type === "movie" && duration > 0 && progress >= 92);
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
          return { entries: entries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, HISTORY_LIMIT) };
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
          if (value === null) {
            if (media.source === "discover") noteRatingCleared(profileId, `${media.type}:${media.id}`);
            return { ratings: withoutCurrent };
          }
          const safeValue = Math.max(1, Math.min(5, Math.round(value)));
          return {
            ratings: [
              { profileId, media, value: safeValue, updatedAt: Date.now() },
              ...withoutCurrent,
            ].slice(0, RATING_LIMIT),
          };
        });
      },

      removeEntry: (media) => {
        const profileId = activeProfileId();
        const key = historyMediaKey(media);
        if (media.source === "discover") noteWatchRemoved(profileId, `${media.type}:${media.id}`);
        set((state) => ({
          entries: state.entries.filter(
            (entry) => entry.profileId !== profileId || historyMediaKey(entry.media) !== key
          ),
        }));
      },

      applyCloud: ({ entries: incoming, removeEntries, ratings: incomingRatings, removeRatings }) => {
        if (!incoming.length && !removeEntries.length && !incomingRatings.length && !removeRatings.length) return;
        const rowKey = (profileId: string, media: HistoryTitle) => `${profileId}|${historyMediaKey(media)}`;
        const dropped = new Set(removeEntries.map((row) => `${row.profileId}|discover:${row.key}`));
        const droppedRatings = new Set(removeRatings.map((row) => `${row.profileId}|discover:${row.key}`));
        set((state) => {
          const entries = new Map(state.entries.map((entry) => [rowKey(entry.profileId, entry.media), entry]));
          for (const key of dropped) entries.delete(key);
          for (const entry of incoming) entries.set(rowKey(entry.profileId, entry.media), entry);
          const ratings = new Map(state.ratings.map((rating) => [rowKey(rating.profileId, rating.media), rating]));
          for (const key of droppedRatings) ratings.delete(key);
          for (const rating of incomingRatings) ratings.set(rowKey(rating.profileId, rating.media), rating);
          return {
            entries: [...entries.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, HISTORY_LIMIT),
            ratings: [...ratings.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RATING_LIMIT),
          };
        });
      },
    }),
    {
      name: "akflix.history",
      storage: createJSONStorage(() => safeStateStorage),
      version: 1,
      partialize: (state) => ({ entries: state.entries, ratings: state.ratings }),
    }
  )
);
