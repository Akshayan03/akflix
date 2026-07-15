/**
 * Persistent app settings: torrent-client + indexer endpoints, download path,
 * UI language. Jellyfin servers/sessions live in authStore.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isTauri } from "@/lib/http";

export interface Settings {
  /** Zero-setup bundled engine by default; external qBittorrent is optional. */
  torrentEngine: "embedded" | "qbittorrent";
  /** qBittorrent Web UI url. In browser dev mode we use the Vite proxy path. */
  qbtUrl: string;
  qbtUsername: string;
  qbtPassword: string;
  /** Prowlarr url + API key (Settings → General in Prowlarr). */
  prowlarrUrl: string;
  prowlarrApiKey: string;
  torrentSource: "torrentio" | "prowlarr";
  /** Configured manifest URL copied from torrentio.strem.fun. */
  torrentioManifestUrl: string;
  /** Where qBittorrent saves files — must match the Jellyfin "Downloads" library. */
  downloadPath: string;
  /** UI language code. */
  language: "en" | "es" | "fr";
  /** Prefer subtitles in this language when available. */
  subtitleLanguage: string;
}

interface SettingsState extends Settings {
  update: (patch: Partial<Settings>) => void;
}

// Under Tauri the Rust process fetches directly (no CORS), so real URLs work.
// In a plain browser we route through the Vite dev proxy (see vite.config.ts).
const defaults: Settings = {
  torrentEngine: "embedded",
  qbtUrl: isTauri() ? "http://localhost:8080" : "/proxy/qbt",
  qbtUsername: "admin",
  qbtPassword: "adminadmin",
  prowlarrUrl: isTauri() ? "http://localhost:9696" : "/proxy/prowlarr",
  prowlarrApiKey: "",
  torrentSource: "torrentio",
  torrentioManifestUrl: "https://torrentio.strem.fun/manifest.json",
  downloadPath: "/downloads",
  language: "en",
  subtitleLanguage: "eng",
};

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ...defaults,
      update: (patch) => set(patch),
    }),
    { name: "akflix.settings" }
  )
);
