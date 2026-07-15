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
import { TorrentioClient, type TorrentioLookup } from "@/api/torrentio";
import { QbtClient } from "@/api/qbittorrent";
import { RqbitClient } from "@/api/rqbit";
import { useSettings } from "@/stores/settingsStore";
import { useAuth } from "@/stores/authStore";
import type { QbtTorrent, TorrentAddMode, TorrentResult } from "@/types/torrent";
import type { DirectPlaybackMetadata } from "@/stores/playbackStore";
import { stopCompatibilityStream } from "@/lib/compatStream";
import { englishSafeSources } from "@/lib/sourceLanguage";

interface TorrentState {
  torrents: QbtTorrent[];
  qbtOnline: boolean;
  polling: boolean;
  /** Torrent the user explicitly asked to stream, awaiting Jellyfin handoff. */
  pendingStreamHash: string | null;
  pendingStreamTemporary: boolean;
  pendingStreamFileIndex: number | null;
  pendingStreamFileName: string | null;
  pendingStreamFileSize: number | null;
  /** Consecutive bytes present from the selected video's first piece. */
  pendingStreamHeadBytes: number;
  pendingStreamFallbacks: TorrentResult[];
  pendingStreamStartedAt: number;
  pendingStreamMedia: DirectPlaybackMetadata | null;
  /** Stream currently attached to the player. Temporary jobs are deleted on stop. */
  activeStreamHash: string | null;
  activeStreamTemporary: boolean;

  qbt: () => TorrentClient;
  streamUrl: (hash: string, fileIndex: number) => string | null;
  prowlarr: () => ProwlarrClient;
  torrentio: () => TorrentioClient;

  search: (
    query: string,
    signal?: AbortSignal,
    lookup?: TorrentioLookup
  ) => Promise<TorrentResult[]>;
  /** Stream uses a temporary sequential cache; download keeps an offline copy. */
  addTorrent: (
    result: TorrentResult,
    mode: TorrentAddMode,
    fallbacks?: TorrentResult[],
    media?: DirectPlaybackMetadata
  ) => Promise<string | null>;
  /** Briefly race up to three sources and keep the one delivering real bytes fastest. */
  raceStreamSources: (
    results: TorrentResult[],
    media?: DirectPlaybackMetadata
  ) => Promise<string | null>;
  addMagnet: (
    magnet: string,
    mode: TorrentAddMode,
    fileIndex?: number,
    media?: DirectPlaybackMetadata | null
  ) => Promise<string | null>;
  prepareStreamFile: () => Promise<boolean>;
  setPendingStreamHash: (hash: string | null) => void;
  markStreamReady: (hash: string) => void;
  cancelPendingStream: () => Promise<void>;
  failoverPendingStream: () => Promise<TorrentResult | null>;
  finishActiveStream: () => Promise<void>;
  pause: (hash: string) => Promise<void>;
  resume: (hash: string) => Promise<void>;
  remove: (hash: string, deleteFiles: boolean) => Promise<void>;
  /** Trigger a Jellyfin library scan so finished downloads appear in the app. */
  importToJellyfin: () => Promise<void>;

  startPolling: () => void;
  stopPolling: () => void;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
type TorrentClient = QbtClient | RqbitClient;

let cachedQbt: TorrentClient | null = null;
let cachedQbtKey = "";
let cachedProwlarr: ProwlarrClient | null = null;
let cachedProwlarrKey = "";
let cachedTorrentio: TorrentioClient | null = null;
let cachedTorrentioUrl = "";

function magnetInfoHash(magnet: string): string | null {
  return magnet.match(/(?:\?|&)xt=urn%3Abtih%3A([a-f\d]{40})/i)?.[1]?.toLowerCase() ??
    magnet.match(/(?:\?|&)xt=urn:btih:([a-f\d]{40})/i)?.[1]?.toLowerCase() ??
    null;
}

// Keep the authenticated qBittorrent client alive between two-second polls.
// Recreate clients only when their settings change so edits still apply
// immediately without hammering the local services with repeated logins.
export const useTorrents = create<TorrentState>()((set, get) => ({
  torrents: [],
  qbtOnline: false,
  polling: false,
  pendingStreamHash: null,
  pendingStreamTemporary: false,
  pendingStreamFileIndex: null,
  pendingStreamFileName: null,
  pendingStreamFileSize: null,
  pendingStreamHeadBytes: 0,
  pendingStreamFallbacks: [],
  pendingStreamStartedAt: 0,
  pendingStreamMedia: null,
  activeStreamHash: null,
  activeStreamTemporary: false,

  qbt: () => {
    const s = useSettings.getState();
    const key = `${s.torrentEngine}\0${s.qbtUrl}\0${s.qbtUsername}\0${s.qbtPassword}`;
    if (!cachedQbt || cachedQbtKey !== key) {
      cachedQbt =
        s.torrentEngine === "qbittorrent"
          ? new QbtClient(s.qbtUrl, s.qbtUsername, s.qbtPassword)
          : new RqbitClient();
      cachedQbtKey = key;
    }
    return cachedQbt;
  },

  streamUrl: (hash, fileIndex) => get().qbt().streamUrl(hash, fileIndex),

  prowlarr: () => {
    const s = useSettings.getState();
    const key = `${s.prowlarrUrl}\0${s.prowlarrApiKey}`;
    if (!cachedProwlarr || cachedProwlarrKey !== key) {
      cachedProwlarr = new ProwlarrClient(s.prowlarrUrl, s.prowlarrApiKey);
      cachedProwlarrKey = key;
    }
    return cachedProwlarr;
  },

  torrentio: () => {
    const url = useSettings.getState().torrentioManifestUrl;
    if (!cachedTorrentio || cachedTorrentioUrl !== url) {
      cachedTorrentio = new TorrentioClient(url);
      cachedTorrentioUrl = url;
    }
    return cachedTorrentio;
  },

  search: (query, signal, lookup) => {
    const settings = useSettings.getState();
    if (settings.torrentSource === "torrentio") {
      // Torrentio only supports IMDb-backed stream lookups, not free text.
      if (!lookup) return Promise.resolve([]);
      return get().torrentio().streams(lookup, signal);
    }
    return get().prowlarr().search(query, [2000, 5000], signal);
  },

  addTorrent: async (result, mode, fallbacks = [], media) => {
    const link = result.magnetUrl ?? result.downloadUrl;
    if (!link) throw new Error("Result has no magnet or download link.");
    const hash = await get().addMagnet(
      link,
      mode,
      result.fileIndex,
      mode === "stream" ? media ?? null : undefined
    );
    if (mode === "stream") {
      set({
        pendingStreamFallbacks: fallbacks.filter((candidate) => !!candidate.magnetUrl),
        pendingStreamStartedAt: Date.now(),
        pendingStreamMedia: media ?? null,
      });
    }
    return hash;
  },

  raceStreamSources: async (results, media) => {
    const eligibleResults = englishSafeSources(results);
    const unique = new Map<string, TorrentResult>();
    for (const result of eligibleResults) {
      const link = result.magnetUrl ?? result.downloadUrl;
      const hash = link ? magnetInfoHash(link) : null;
      if (hash && !unique.has(hash)) unique.set(hash, result);
      if (unique.size >= 3) break;
    }
    const candidates = [...unique.entries()].map(([hash, result]) => ({ hash, result }));
    if (!candidates.length) throw new Error("No torrent sources are available to race.");
    if (candidates.length === 1) {
      return get().addTorrent(candidates[0].result, "stream", eligibleResults.slice(1), media);
    }

    const settings = useSettings.getState();
    const basePath = (settings.downloadPath || "/downloads").replace(/\/$/, "");
    const savePath = `${basePath}/Streaming Cache`;
    const qbt = get().qbt();
    const before = await qbt.list();
    const beforeByHash = new Map(before.map((torrent) => [torrent.hash, torrent]));

    const added = await Promise.allSettled(
      candidates.map(({ result }) => {
        const link = result.magnetUrl ?? result.downloadUrl!;
        return qbt.add(link, "stream", savePath);
      })
    );
    if (added.every((outcome) => outcome.status === "rejected")) {
      throw new Error("None of the candidate sources could be started.");
    }

    // Metadata cache usually resolves immediately. Give peers a short window
    // to prove actual throughput, then choose measured speed rather than a
    // stale seed count advertised by the indexer.
    let snapshots: QbtTorrent[] = [];
    const instantEngine = qbt.instantStreaming;
    const raceStarted = Date.now();
    const raceLimit = instantEngine ? 1_800 : 4_500;
    const minimumRace = instantEngine ? 600 : 2_250;
    while (Date.now() - raceStarted < raceLimit) {
      await new Promise((resolve) => setTimeout(resolve, instantEngine ? 300 : 750));
      snapshots = await qbt.list();
      const active = snapshots.filter((torrent) => unique.has(torrent.hash));
      if (
        Date.now() - raceStarted >= minimumRace &&
        active.some((torrent) =>
          instantEngine ? torrent.num_seeds > 0 || torrent.progress > 0 : torrent.dlspeed >= 512 * 1024 && torrent.progress > 0
        )
      ) {
        break;
      }
    }

    const winner = snapshots
      .filter((torrent) => unique.has(torrent.hash))
      .sort((a, b) => {
        const speed = b.dlspeed - a.dlspeed;
        if (speed) return speed;
        const progress = b.progress - a.progress;
        if (progress) return progress;
        return b.num_seeds - a.num_seeds;
      })[0];
    const winnerCandidate = winner
      ? candidates.find((candidate) => candidate.hash === winner.hash)
      : candidates[0];
    if (!winnerCandidate) throw new Error("The source race did not produce a winner.");

    await Promise.all(
      candidates
        .filter((candidate) => {
          if (candidate.hash === winnerCandidate.hash) return false;
          const existing = beforeByHash.get(candidate.hash);
          return !existing || existing.category === "akflix-stream";
        })
        .map((candidate) => qbt.delete(candidate.hash, true).catch(() => {}))
    );

    const fallbacks = eligibleResults.filter((result) => {
      const link = result.magnetUrl ?? result.downloadUrl;
      return !!link && magnetInfoHash(link) !== winnerCandidate.hash;
    });
    set({
      torrents: snapshots.filter(
        (torrent) =>
          torrent.hash === winnerCandidate.hash || !candidates.some((candidate) => candidate.hash === torrent.hash)
      ),
      pendingStreamHash: winnerCandidate.hash,
      pendingStreamTemporary:
        !beforeByHash.has(winnerCandidate.hash) ||
        beforeByHash.get(winnerCandidate.hash)?.category === "akflix-stream",
      pendingStreamFileIndex: winnerCandidate.result.fileIndex ?? null,
      pendingStreamFileName: null,
      pendingStreamFileSize: null,
      pendingStreamHeadBytes: 0,
      pendingStreamFallbacks: fallbacks,
      pendingStreamStartedAt: Date.now(),
      pendingStreamMedia: media ?? null,
    });
    return winnerCandidate.hash;
  },

  addMagnet: async (magnet, mode, fileIndex, media) => {
    const s = useSettings.getState();
    const hash = magnetInfoHash(magnet);
    const qbt = get().qbt();
    const existing = hash ? (await qbt.list()).find((torrent) => torrent.hash === hash) : undefined;
    const streamMode = mode === "stream";
    const basePath = (s.downloadPath || "/downloads").replace(/\/$/, "");
    const savePath = streamMode ? `${basePath}/Streaming Cache` : basePath;
    await qbt.add(magnet, mode, savePath);
    if (streamMode && existing && !existing.seq_dl) await qbt.setSequential(existing.hash);
    if (streamMode && hash) {
      const temporary = !existing || existing.category === "akflix-stream";
      set({
        pendingStreamHash: hash,
        pendingStreamTemporary: temporary,
        pendingStreamFileIndex: fileIndex ?? null,
        pendingStreamFileName: null,
        pendingStreamFileSize: null,
        pendingStreamHeadBytes: 0,
        pendingStreamFallbacks: [],
        pendingStreamStartedAt: Date.now(),
        ...(media !== undefined ? { pendingStreamMedia: media } : {}),
      });
    }
    return hash;
  },

  prepareStreamFile: async () => {
    const {
      pendingStreamHash: hash,
      pendingStreamFileIndex: index,
      pendingStreamMedia: media,
    } = get();
    if (!hash) return false;
    const selected = await get().qbt().prioritizeVideoFile(hash, index ?? undefined, {
      season: media?.season,
      episode: media?.episode,
    });
    if (!selected) return false;
    await get().qbt().refreshStreamPriority(hash).catch(() => {});
    set({
      pendingStreamFileIndex: selected.index,
      pendingStreamFileName: selected.name,
      pendingStreamFileSize: selected.size,
      pendingStreamHeadBytes: 0,
    });
    return true;
  },

  setPendingStreamHash: (pendingStreamHash) =>
    set({
      pendingStreamHash,
      ...(!pendingStreamHash
        ? {
            pendingStreamTemporary: false,
            pendingStreamFileIndex: null,
            pendingStreamFileName: null,
            pendingStreamFileSize: null,
            pendingStreamHeadBytes: 0,
            pendingStreamFallbacks: [],
            pendingStreamStartedAt: 0,
            pendingStreamMedia: null,
          }
        : {}),
    }),

  markStreamReady: (hash) => {
    const state = get();
    set({
      pendingStreamHash: null,
      pendingStreamTemporary: false,
      pendingStreamFileIndex: null,
      pendingStreamFileName: null,
      pendingStreamFileSize: null,
      pendingStreamHeadBytes: 0,
      pendingStreamFallbacks: [],
      pendingStreamStartedAt: 0,
      pendingStreamMedia: null,
      activeStreamHash: hash,
      activeStreamTemporary: state.pendingStreamTemporary,
    });
  },

  cancelPendingStream: async () => {
    const { pendingStreamHash: hash, pendingStreamTemporary: temporary } = get();
    set({
      pendingStreamHash: null,
      pendingStreamTemporary: false,
      pendingStreamFileIndex: null,
      pendingStreamFileName: null,
      pendingStreamFileSize: null,
      pendingStreamHeadBytes: 0,
      pendingStreamFallbacks: [],
      pendingStreamStartedAt: 0,
      pendingStreamMedia: null,
    });
    if (hash && temporary) {
      await get().qbt().delete(hash, true);
      set((state) => ({ torrents: state.torrents.filter((torrent) => torrent.hash !== hash) }));
      useAuth.getState().client()?.refreshLibrary().catch(() => {});
    }
  },

  failoverPendingStream: async () => {
    const state = get();
    const oldHash = state.pendingStreamHash;
    const oldTemporary = state.pendingStreamTemporary;
    const candidates = [...state.pendingStreamFallbacks];
    if (!oldHash || !candidates.length) return null;

    set({
      pendingStreamHash: null,
      pendingStreamTemporary: false,
      pendingStreamFileIndex: null,
      pendingStreamFileName: null,
      pendingStreamFileSize: null,
      pendingStreamHeadBytes: 0,
      pendingStreamFallbacks: [],
      pendingStreamStartedAt: 0,
    });
    if (oldTemporary) {
      await get().qbt().delete(oldHash, true).catch(() => {});
    }

    while (candidates.length) {
      const candidate = candidates.shift()!;
      const link = candidate.magnetUrl ?? candidate.downloadUrl;
      if (!link) continue;
      try {
        await get().addMagnet(link, "stream", candidate.fileIndex);
        set({
          pendingStreamFallbacks: candidates,
          pendingStreamStartedAt: Date.now(),
        });
        return candidate;
      } catch {
        // Try the next ranked source without making the user reopen the picker.
      }
    }
    return null;
  },

  finishActiveStream: async () => {
    const { activeStreamHash: hash, activeStreamTemporary: temporary } = get();
    set({ activeStreamHash: null, activeStreamTemporary: false });
    if (hash) await stopCompatibilityStream(hash).catch(() => {});
    if (hash && temporary) {
      await get().qbt().delete(hash, true);
      set((state) => ({ torrents: state.torrents.filter((torrent) => torrent.hash !== hash) }));
      useAuth.getState().client()?.refreshLibrary().catch(() => {});
    }
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
    get().qbt().optimizeForStreaming().catch(() => {});
    const tick = async () => {
      try {
        const torrents = await get().qbt().list();
        const {
          pendingStreamHash: pending,
          pendingStreamFileIndex: fileIndex,
          activeStreamHash: active,
        } = get();
        // Adopt a temporary stream after an app rebuild/restart so it can be
        // resumed or cancelled instead of silently occupying disk space.
        const adopted = pending
          ? null
          : active
            ? null
            : torrents.find((torrent) => torrent.category === "akflix-stream")?.hash ?? null;
        const streamHash = pending ?? adopted;
        const headBytes =
          pending && fileIndex !== null && !get().qbt().instantStreaming
            ? await get().qbt().contiguousFileHeadBytes(pending, fileIndex).catch(() => 0)
            : 0;
        set({
          torrents,
          qbtOnline: true,
          ...(streamHash ? { pendingStreamHeadBytes: headBytes } : {}),
          ...(adopted
            ? {
                pendingStreamHash: adopted,
                pendingStreamTemporary: true,
                pendingStreamHeadBytes: 0,
                pendingStreamFallbacks: [],
                pendingStreamStartedAt: Date.now(),
                pendingStreamMedia: null,
              }
            : {}),
        });
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
