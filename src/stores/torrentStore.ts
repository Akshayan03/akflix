/**
 * Torrent manager module.
 *
 * Owns the QbtClient + ProwlarrClient instances (rebuilt when settings
 * change), polls download progress, and exposes the actions the UI needs:
 * search, add (download or stream mode), pause/resume/delete, and
 * "import into Jellyfin" (library rescan).
 */

import { create } from "zustand";
import { ProwlarrClient } from "@/api/prowlarr";
import { QbtClient } from "@/api/qbittorrent";
import { useSettings } from "@/stores/settingsStore";
import { useAuth } from "@/stores/authStore";
import type { QbtTorrent, TorrentResult } from "@/types/torrent";

interface TorrentState {
  torrents: QbtTorrent[];
  qbtOnline: boolean;
  polling: boolean;

  qbt: () => QbtClient;
  prowlarr: () => ProwlarrClient;

  search: (query: string, signal?: AbortSignal) => Promise<TorrentResult[]>;
  /** Add a result. streamMode=true → sequential pieces for early playback. */
  addTorrent: (result: TorrentResult, streamMode: boolean) => Promise<void>;
  addMagnet: (magnet: string, streamMode: boolean) => Promise<void>;
  pause: (hash: string) => Promise<void>;
  resume: (hash: string) => Promise<void>;
  remove: (hash: string, deleteFiles: boolean) => Promise<void>;
  /** Trigger a Jellyfin library scan so finished downloads appear in the app. */
  importToJellyfin: () => Promise<void>;

  startPolling: () => void;
  stopPolling: () => void;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

// Clients are cheap; rebuild from current settings on each access so
// Settings-page edits take effect immediately without a restart.
export const useTorrents = create<TorrentState>()((set, get) => ({
  torrents: [],
  qbtOnline: false,
  polling: false,

  qbt: () => {
    const s = useSettings.getState();
    return new QbtClient(s.qbtUrl, s.qbtUsername, s.qbtPassword);
  },

  prowlarr: () => {
    const s = useSettings.getState();
    return new ProwlarrClient(s.prowlarrUrl, s.prowlarrApiKey);
  },

  search: (query, signal) => get().prowlarr().search(query, [2000, 5000], signal),

  addTorrent: async (result, streamMode) => {
    const link = result.magnetUrl ?? result.downloadUrl;
    if (!link) throw new Error("Result has no magnet or download link.");
    await get().addMagnet(link, streamMode);
  },

  addMagnet: async (magnet, streamMode) => {
    const s = useSettings.getState();
    await get().qbt().add(magnet, streamMode, s.downloadPath || undefined);
  },

  pause: (h) => get().qbt().pause(h),
  resume: (h) => get().qbt().resume(h),

  remove: async (hash, deleteFiles) => {
    await get().qbt().delete(hash, deleteFiles);
    set((st) => ({ torrents: st.torrents.filter((t) => t.hash !== hash) }));
  },

  importToJellyfin: async () => {
    const client = useAuth.getState().client();
    if (!client) throw new Error("Not signed in to Jellyfin.");
    await client.refreshLibrary();
  },

  startPolling: () => {
    if (pollTimer) return;
    const tick = async () => {
      try {
        const torrents = await get().qbt().list();
        set({ torrents, qbtOnline: true });
      } catch {
        set({ qbtOnline: false });
      }
    };
    tick();
    pollTimer = setInterval(tick, 2000);
    set({ polling: true });
  },

  stopPolling: () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    set({ polling: false });
  },
}));
