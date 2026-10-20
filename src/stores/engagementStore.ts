/**
 * Rewatch and binge counts per catalog title and profile (see
 * lib/discovery/engagement.ts). Fed by historyStore.recordProgress and by
 * account sync; read by the recommendations.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { safeStateStorage } from "@/lib/safeStorage";
import type { HistoryTitle, WatchHistoryEntry } from "@/stores/historyStore";
import {
  applyWatchEvents,
  emptyEngagement,
  watchEvents,
  type EngagementRow,
} from "@/lib/discovery/engagement";

export type { EngagementRow } from "@/lib/discovery/engagement";

interface EngagementState {
  rows: EngagementRow[];
  /** Notes what replacing `previous` with `next` meant (a finish, a rewatch). */
  record: (previous: WatchHistoryEntry | undefined, next: WatchHistoryEntry, upNext: boolean) => void;
  /** Account sync: adopts newer copies from another device, keeping this device's binge window. */
  applyCloud: (rows: EngagementRow[]) => void;
}

const LIMIT = 400;

export const engagementKey = (profileId: string, media: Pick<HistoryTitle, "type" | "id">) =>
  `${profileId}|${media.type}:${media.id}`;

const trim = (rows: EngagementRow[]) => [...rows].sort((a, b) => b.at - a.at).slice(0, LIMIT);

export const useEngagement = create<EngagementState>()(
  persist(
    (set) => ({
      rows: [],

      record: (previous, next, upNext) => {
        if (next.media.source !== "discover") return;
        const events = watchEvents(previous, next, upNext);
        if (!events.length) return;
        const now = next.updatedAt;
        const key = engagementKey(next.profileId, next.media);
        set((state) => {
          const index = state.rows.findIndex((row) => engagementKey(row.profileId, row.media) === key);
          const current = index >= 0 ? state.rows[index] : emptyEngagement(next.profileId, next.media, now);
          const updated = applyWatchEvents({ ...current, media: next.media }, events, now, next.media.type);
          if (updated === current) return state;
          const rows = [...state.rows];
          if (index >= 0) rows[index] = updated;
          else rows.push(updated);
          return { rows: trim(rows) };
        });
      },

      applyCloud: (incoming) => {
        if (!incoming.length) return;
        set((state) => {
          const byKey = new Map(state.rows.map((row) => [engagementKey(row.profileId, row.media), row]));
          for (const row of incoming) {
            const key = engagementKey(row.profileId, row.media);
            const local = byKey.get(key);
            byKey.set(key, { ...row, recent: local?.recent, lastBingeAt: local?.lastBingeAt, lastRewatchAt: local?.lastRewatchAt });
          }
          return { rows: trim([...byKey.values()]) };
        });
      },
    }),
    {
      name: "akflix.engagement",
      version: 1,
      storage: createJSONStorage(() => safeStateStorage),
      partialize: (state) => ({ rows: state.rows }),
    }
  )
);
