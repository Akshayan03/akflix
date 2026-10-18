/**
 * My List for catalog titles, per profile. Removing a title keeps a
 * `saved: false` marker with its time so account sync can tell a removal
 * from "never saved" on another device.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { safeStateStorage } from "@/lib/safeStorage";
import { useAuth } from "@/stores/authStore";
import type { HistoryTitle } from "@/stores/historyStore";

export interface SavedTitle {
  profileId: string;
  media: HistoryTitle;
  saved: boolean;
  /** Epoch ms of the last add or remove. */
  at: number;
}

interface ListState {
  items: SavedTitle[];
  /** Adds or removes `media` for the active profile; returns the new saved state. */
  toggle: (media: HistoryTitle) => boolean;
  setSaved: (media: HistoryTitle, saved: boolean) => void;
  /** Account sync: replaces rows with newer cloud copies without new timestamps. */
  applyCloud: (rows: SavedTitle[]) => void;
}

const LIMIT = 500;

export const listItemKey = (profileId: string, media: Pick<HistoryTitle, "source" | "type" | "id">) =>
  `${profileId}|${media.source}:${media.type}:${media.id}`;

function activeProfileId(): string {
  return useAuth.getState().activeProfileId ?? "akflix-local";
}

function upsert(items: SavedTitle[], rows: SavedTitle[]): SavedTitle[] {
  const byKey = new Map(items.map((item) => [listItemKey(item.profileId, item.media), item]));
  for (const row of rows) byKey.set(listItemKey(row.profileId, row.media), row);
  const next = [...byKey.values()].sort((a, b) => b.at - a.at);
  // Keep every saved title; only old removal markers fall off the end.
  const saved = next.filter((item) => item.saved);
  const removed = next.filter((item) => !item.saved).slice(0, Math.max(0, LIMIT - saved.length));
  return [...saved, ...removed].sort((a, b) => b.at - a.at);
}

export const useMyList = create<ListState>()(
  persist(
    (set, get) => ({
      items: [],

      toggle: (media) => {
        const profileId = activeProfileId();
        const current = get().items.find((item) => listItemKey(item.profileId, item.media) === listItemKey(profileId, media));
        const saved = !current?.saved;
        get().setSaved(media, saved);
        return saved;
      },

      setSaved: (media, saved) => {
        const profileId = activeProfileId();
        set((state) => ({ items: upsert(state.items, [{ profileId, media, saved, at: Date.now() }]) }));
      },

      applyCloud: (rows) => {
        if (!rows.length) return;
        set((state) => ({ items: upsert(state.items, rows) }));
      },
    }),
    {
      name: "akflix.mylist",
      version: 1,
      storage: createJSONStorage(() => safeStateStorage),
      partialize: (state) => ({ items: state.items }),
    }
  )
);

export function savedTitlesFor(items: SavedTitle[], profileId: string): SavedTitle[] {
  return items.filter((item) => item.profileId === profileId && item.saved);
}

export function isSaved(items: SavedTitle[], profileId: string, media: Pick<HistoryTitle, "source" | "type" | "id">) {
  const key = listItemKey(profileId, media);
  return items.some((item) => item.saved && listItemKey(item.profileId, item.media) === key);
}
