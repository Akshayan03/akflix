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
import { automaticSafeSources } from "@/lib/sourceLanguage";
import { availableMediaStorage } from "@/lib/mediaStorage";
import { formatBytes } from "@/lib/utils";

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
  /** Monotonic identity for the latest user playback choice. */
  streamRequestId: number;
  /** Human-readable progress shown from the instant Watch click onward. */
  streamLaunchPhase: string | null;
  streamLaunchMedia: DirectPlaybackMetadata | null;
  /** True while Watch now is measuring candidate sources. */
  sourceRaceActive: boolean;
  sourceRaceMedia: DirectPlaybackMetadata | null;
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
    media?: DirectPlaybackMetadata,
    signal?: AbortSignal,
    requestId?: number
  ) => Promise<string | null>;
  /** Briefly race up to three sources and keep the one delivering real bytes fastest. */
  raceStreamSources: (
    results: TorrentResult[],
    media?: DirectPlaybackMetadata,
    requestId?: number
  ) => Promise<string | null>;
  addMagnet: (
    magnet: string,
    mode: TorrentAddMode,
    fileIndex?: number,
    media?: DirectPlaybackMetadata | null,
    signal?: AbortSignal,
    requestId?: number
  ) => Promise<string | null>;
  beginStreamRequest: (media?: DirectPlaybackMetadata | null) => Promise<number>;
  setStreamLaunchPhase: (requestId: number, phase: string | null) => void;
  prepareStreamFile: (requestId?: number) => Promise<boolean>;
  setPendingStreamHash: (hash: string | null) => void;
  markStreamReady: (hash: string, requestId: number) => boolean;
  cancelSourceRace: () => Promise<void>;
  cancelPendingStream: (requestId?: number) => Promise<void>;
  failoverPendingStream: (requestId?: number) => Promise<TorrentResult | null>;
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
let sourceRaceController: AbortController | null = null;
let sourceRaceHashes = new Set<string>();
let sourceRaceExistingHashes = new Set<string>();
let suppressStreamAdoptionUntil = 0;
let streamCleanupQueue: Promise<void> = Promise.resolve();

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

const STREAM_STORAGE_RESERVE = 512 * 1024 * 1024;
const MINIMUM_STREAM_STORAGE = 1024 * 1024 * 1024;

async function sourcesThatFitStorage(results: TorrentResult[]): Promise<TorrentResult[]> {
  if (useSettings.getState().torrentEngine !== "embedded") return results;
  const available = await availableMediaStorage();
  if (available === null) return results;
  const usable = Math.max(0, available - STREAM_STORAGE_RESERVE);
  const fitting = results.filter((result) => result.size <= 0 || result.size <= usable);
  if (fitting.length) return fitting;

  const smallest = results
    .map((result) => result.size)
    .filter((size) => size > 0)
    .sort((a, b) => a - b)[0];
  const needed = smallest ? Math.max(0, smallest + STREAM_STORAGE_RESERVE - available) : 0;
  throw new Error(
    needed
      ? `Not enough free space for this stream. Free at least ${formatBytes(needed)} or choose a smaller source.`
      : `Not enough free space for streaming. ${formatBytes(available)} is currently available.`
  );
}

async function requireMinimumStreamStorage(): Promise<void> {
  if (useSettings.getState().torrentEngine !== "embedded") return;
  const available = await availableMediaStorage();
  if (available !== null && available < MINIMUM_STREAM_STORAGE) {
    throw new Error(
      `Not enough free space for streaming. ${formatBytes(available)} is available; free at least 1 GB and try again.`
    );
  }
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
  streamRequestId: 0,
  streamLaunchPhase: null,
  streamLaunchMedia: null,
  sourceRaceActive: false,
  sourceRaceMedia: null,
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

  addTorrent: async (result, mode, fallbacks = [], media, signal, suppliedRequestId) => {
    const requestId =
      mode === "stream"
        ? suppliedRequestId ?? (await get().beginStreamRequest(media ?? null))
        : undefined;
    if (requestId !== undefined && get().streamRequestId !== requestId) {
      throw new DOMException("Stream request superseded.", "AbortError");
    }
    if (requestId !== undefined) {
      get().setStreamLaunchPhase(requestId, "Checking device storage");
    }
    if (mode === "stream") await sourcesThatFitStorage([result]);
    const link = result.magnetUrl ?? result.downloadUrl;
    if (!link) throw new Error("Result has no magnet or download link.");
    const hash = await get().addMagnet(
      link,
      mode,
      result.fileIndex,
      mode === "stream" ? media ?? null : undefined,
      signal,
      requestId
    );
    if (mode === "stream" && get().streamRequestId === requestId && get().pendingStreamHash === hash) {
      set({
        pendingStreamFallbacks: fallbacks.filter((candidate) => !!candidate.magnetUrl),
        pendingStreamStartedAt: Date.now(),
        pendingStreamMedia: media ?? null,
      });
    }
    return hash;
  },

  raceStreamSources: async (results, media, suppliedRequestId) => {
    const requestId = suppliedRequestId ?? (await get().beginStreamRequest(media ?? null));
    const current = () => get().streamRequestId === requestId;
    const ensureCurrent = () => {
      if (!current()) throw new DOMException("Stream request superseded.", "AbortError");
    };
    ensureCurrent();
    sourceRaceController?.abort();
    const controller = new AbortController();
    sourceRaceController = controller;
    sourceRaceHashes = new Set();
    sourceRaceExistingHashes = new Set();
    set({
      sourceRaceActive: true,
      sourceRaceMedia: media ?? null,
      streamLaunchPhase: "Testing the best available sources",
      streamLaunchMedia: media ?? null,
    });
    try {
    const eligibleResults = await sourcesThatFitStorage(
      automaticSafeSources(results, useSettings.getState().audioLanguage)
    );
    ensureCurrent();
    const unique = new Map<string, TorrentResult>();
    for (const result of eligibleResults) {
      const link = result.magnetUrl ?? result.downloadUrl;
      const hash = link ? magnetInfoHash(link) : null;
      if (hash && !unique.has(hash)) unique.set(hash, result);
      if (unique.size >= 3) break;
    }
    const candidates = [...unique.entries()].map(([hash, result]) => ({ hash, result }));
    if (!candidates.length) throw new Error("No torrent sources are available to race.");
    sourceRaceHashes = new Set(candidates.map((candidate) => candidate.hash));
    const settings = useSettings.getState();
    const basePath = (settings.downloadPath || "/downloads").replace(/\/$/, "");
    const savePath = `${basePath}/Streaming Cache`;
    const qbt = get().qbt();
    const before = await qbt.list();
    ensureCurrent();
    const beforeByHash = new Map(before.map((torrent) => [torrent.hash, torrent]));
    sourceRaceExistingHashes = new Set(beforeByHash.keys());
    if (qbt.instantStreaming) {
      // rqbit begins playback immediately once metadata resolves, so racing
      // duplicate adds only wastes sockets. Try ranked sources in sequence and
      // move on when an index/cache entry is dead instead of failing the title.
      const attempts = candidates.concat(
        eligibleResults
          .map((result) => {
            const link = result.magnetUrl ?? result.downloadUrl;
            const hash = link ? magnetInfoHash(link) : null;
            return hash ? { hash, result } : null;
          })
          .filter((candidate): candidate is { hash: string; result: TorrentResult } =>
            !!candidate && !unique.has(candidate.hash)
          )
      ).slice(0, 6);
      const errors: string[] = [];
      for (let index = 0; index < attempts.length; index += 1) {
        ensureCurrent();
        if (controller.signal.aborted) throw new DOMException("Source search cancelled.", "AbortError");
        const selected = attempts[index];
        sourceRaceHashes.add(selected.hash);
        get().setStreamLaunchPhase(
          requestId,
          index === 0 ? "Connecting to the best source" : `Trying backup source ${index + 1}`
        );
        const fallbacks = eligibleResults.filter((result) => {
          const link = result.magnetUrl ?? result.downloadUrl;
          return !link || magnetInfoHash(link) !== selected.hash;
        });
        try {
          return await get().addTorrent(
            selected.result,
            "stream",
            fallbacks,
            media,
            controller.signal,
            requestId
          );
        } catch (error) {
          if (controller.signal.aborted || !current()) {
            throw new DOMException("Source search cancelled.", "AbortError");
          }
          if (!beforeByHash.has(selected.hash)) {
            await qbt.delete(selected.hash, true).catch(() => {});
          }
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      const uniqueErrors = [...new Set(errors)].filter(Boolean);
      const detail = uniqueErrors[uniqueErrors.length - 1];
      throw new Error(
        `Akflix tried ${attempts.length} sources but none could load.${detail ? ` ${detail}` : ""}`
      );
    }

    if (candidates.length === 1) {
      return get().addTorrent(
        candidates[0].result,
        "stream",
        eligibleResults.slice(1),
        media,
        controller.signal,
        requestId
      );
    }

    const added = await Promise.allSettled(
      candidates.map(({ result }) => {
        const link = result.magnetUrl ?? result.downloadUrl!;
        return qbt.add(link, "stream", savePath, controller.signal);
      })
    );
    const startedCandidates = candidates.filter(
      (_candidate, index) => added[index]?.status === "fulfilled"
    );
    if (!startedCandidates.length) {
      // Cached torrent metadata and trackers can fail temporarily for a
      // perfectly healthy source. Do not stop at the first three race entries.
      // Walk several additional ranked sources one at a time so a title with
      // one bad provider row can still begin playing.
      const racedHashes = new Set(candidates.map((candidate) => candidate.hash));
      const additional = eligibleResults
        .filter((result) => {
          const link = result.magnetUrl ?? result.downloadUrl;
          const hash = link ? magnetInfoHash(link) : null;
          return !!hash && !racedHashes.has(hash);
        })
        .slice(0, 5);
      const errors = added.flatMap((outcome) =>
        outcome.status === "rejected"
          ? [outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)]
          : []
      );

      for (let index = 0; index < additional.length; index += 1) {
        if (controller.signal.aborted) throw new DOMException("Source search cancelled.", "AbortError");
        const result = additional[index];
        const link = result.magnetUrl ?? result.downloadUrl;
        const hash = link ? magnetInfoHash(link) : null;
        if (hash) sourceRaceHashes.add(hash);
        try {
          return await get().addTorrent(
            result,
            "stream",
            additional.slice(index + 1),
            media,
            controller.signal,
            requestId
          );
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }

      const uniqueErrors = [...new Set(errors)].filter(Boolean);
      const detail = uniqueErrors[uniqueErrors.length - 1];
      throw new Error(
        `Akflix tried ${candidates.length + additional.length} sources but none could load.${
          detail ? ` ${detail}` : ""
        }`
      );
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
      if (controller.signal.aborted) throw new DOMException("Source search cancelled.", "AbortError");
      ensureCurrent();
      await new Promise((resolve) => setTimeout(resolve, instantEngine ? 300 : 750));
      ensureCurrent();
      snapshots = await qbt.list();
      ensureCurrent();
      const startedHashes = new Set(startedCandidates.map((candidate) => candidate.hash));
      const active = snapshots.filter((torrent) => startedHashes.has(torrent.hash));
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
      .filter((torrent) =>
        startedCandidates.some((candidate) => candidate.hash === torrent.hash)
      )
      .sort((a, b) => {
        const speed = b.dlspeed - a.dlspeed;
        if (speed) return speed;
        const progress = b.progress - a.progress;
        if (progress) return progress;
        return b.num_seeds - a.num_seeds;
      })[0];
    const winnerCandidate = winner
      ? startedCandidates.find((candidate) => candidate.hash === winner.hash)
      : startedCandidates[0];
    if (!winnerCandidate) throw new Error("The source race did not produce a winner.");

    await Promise.all(
      startedCandidates
        .filter((candidate) => {
          if (candidate.hash === winnerCandidate.hash) return false;
          const existing = beforeByHash.get(candidate.hash);
          return !existing || existing.category === "akflix-stream";
        })
        .map((candidate) => qbt.delete(candidate.hash, true).catch(() => {}))
    );
    ensureCurrent();

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
    } finally {
      if (sourceRaceController === controller) {
        sourceRaceController = null;
        sourceRaceHashes = new Set();
        sourceRaceExistingHashes = new Set();
        set({
          sourceRaceActive: false,
          sourceRaceMedia: null,
          streamLaunchPhase: null,
          streamLaunchMedia: null,
        });
      }
    }
  },

  addMagnet: async (magnet, mode, fileIndex, media, signal, suppliedRequestId) => {
    const streamMode = mode === "stream";
    const requestId =
      streamMode
        ? suppliedRequestId ?? (await get().beginStreamRequest(media ?? null))
        : undefined;
    const current = () => requestId === undefined || get().streamRequestId === requestId;
    if (!current()) throw new DOMException("Stream request superseded.", "AbortError");
    const s = useSettings.getState();
    const hash = magnetInfoHash(magnet);
    const qbt = get().qbt();
    if (requestId !== undefined) {
      get().setStreamLaunchPhase(requestId, "Loading stream information");
    }
    const existing = hash ? (await qbt.list()).find((torrent) => torrent.hash === hash) : undefined;
    if (!current()) throw new DOMException("Stream request superseded.", "AbortError");
    if (streamMode) await requireMinimumStreamStorage();
    const basePath = (s.downloadPath || "/downloads").replace(/\/$/, "");
    const savePath = streamMode ? `${basePath}/Streaming Cache` : basePath;
    await qbt.add(magnet, mode, savePath, signal);
    if (!current()) {
      if (streamMode && hash && (!existing || existing.category === "akflix-stream")) {
        await qbt.delete(hash, true).catch(() => {});
      }
      throw new DOMException("Stream request superseded.", "AbortError");
    }
    if (streamMode && existing && !existing.seq_dl) await qbt.setSequential(existing.hash);
    if (!current()) throw new DOMException("Stream request superseded.", "AbortError");
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
        streamLaunchPhase: null,
        streamLaunchMedia: null,
      });
    }
    return hash;
  },

  beginStreamRequest: async (media = null) => {
    const state = get();
    const requestId = state.streamRequestId + 1;
    const raceController = sourceRaceController;
    const raceHashes = new Set(sourceRaceHashes);
    const raceExisting = new Set(sourceRaceExistingHashes);
    raceController?.abort();
    sourceRaceController = null;
    sourceRaceHashes = new Set();
    sourceRaceExistingHashes = new Set();

    const stale = new Map<string, boolean>();
    if (state.pendingStreamHash) stale.set(state.pendingStreamHash, state.pendingStreamTemporary);
    if (state.activeStreamHash) stale.set(state.activeStreamHash, state.activeStreamTemporary);
    suppressStreamAdoptionUntil = Date.now() + 30_000;
    set({
      streamRequestId: requestId,
      streamLaunchPhase: "Finding available sources",
      streamLaunchMedia: media,
      sourceRaceActive: false,
      sourceRaceMedia: null,
      pendingStreamHash: null,
      pendingStreamTemporary: false,
      pendingStreamFileIndex: null,
      pendingStreamFileName: null,
      pendingStreamFileSize: null,
      pendingStreamHeadBytes: 0,
      pendingStreamFallbacks: [],
      pendingStreamStartedAt: 0,
      pendingStreamMedia: media,
      activeStreamHash: null,
      activeStreamTemporary: false,
    });

    const cleanup = async () => {
      if (raceHashes.size) await new Promise((resolve) => setTimeout(resolve, 150));
      const qbt = get().qbt();
      const currentTorrents = raceHashes.size ? await qbt.list().catch(() => []) : [];
      await Promise.all([
        ...[...stale.entries()].map(async ([hash, temporary]) => {
          await stopCompatibilityStream(hash).catch(() => {});
          if (temporary) await qbt.delete(hash, true).catch(() => {});
        }),
        ...currentTorrents
          .filter(
            (torrent) =>
              raceHashes.has(torrent.hash) &&
              !raceExisting.has(torrent.hash) &&
              torrent.category === "akflix-stream"
          )
          .map((torrent) => qbt.delete(torrent.hash, true).catch(() => {})),
      ]);
    };
    streamCleanupQueue = streamCleanupQueue.then(cleanup, cleanup);
    await streamCleanupQueue;
    set((latest) => ({
      torrents: latest.torrents.filter(
        (torrent) =>
          !stale.get(torrent.hash) &&
          (!raceHashes.has(torrent.hash) || raceExisting.has(torrent.hash))
      ),
    }));
    return requestId;
  },

  setStreamLaunchPhase: (requestId, phase) => {
    if (get().streamRequestId !== requestId) return;
    set({
      streamLaunchPhase: phase,
      streamLaunchMedia: phase ? get().pendingStreamMedia : null,
    });
  },

  prepareStreamFile: async (suppliedRequestId) => {
    const {
      pendingStreamHash: hash,
      pendingStreamFileIndex: index,
      pendingStreamMedia: media,
    } = get();
    const requestId = suppliedRequestId ?? get().streamRequestId;
    if (!hash || get().streamRequestId !== requestId) return false;
    const selected = await get().qbt().prioritizeVideoFile(hash, index ?? undefined, {
      season: media?.season,
      episode: media?.episode,
    });
    if (!selected) return false;
    await get().qbt().refreshStreamPriority(hash).catch(() => {});
    if (get().streamRequestId !== requestId || get().pendingStreamHash !== hash) return false;
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
            streamLaunchPhase: null,
            streamLaunchMedia: null,
          }
        : {}),
    }),

  markStreamReady: (hash, requestId) => {
    const state = get();
    if (state.streamRequestId !== requestId || state.pendingStreamHash !== hash) return false;
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
      streamLaunchPhase: null,
      streamLaunchMedia: null,
      activeStreamHash: hash,
      activeStreamTemporary: state.pendingStreamTemporary,
    });
    return true;
  },

  cancelSourceRace: async () => {
    const state = get();
    const controller = sourceRaceController;
    const hashes = new Set(sourceRaceHashes);
    const existingHashes = new Set(sourceRaceExistingHashes);
    controller?.abort();
    suppressStreamAdoptionUntil = Date.now() + 30_000;
    set({
      streamRequestId: state.streamRequestId + 1,
      sourceRaceActive: false,
      sourceRaceMedia: null,
      streamLaunchPhase: null,
      streamLaunchMedia: null,
    });
    if (!hashes.size) return;

    // An add request can finish server-side just as it is aborted. Inspect the
    // engine once and remove only temporary race entries that were not already
    // present before the user pressed Watch now.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const qbt = get().qbt();
    const current = await qbt.list().catch(() => []);
    await Promise.all(
      current
        .filter(
          (torrent) =>
            hashes.has(torrent.hash) &&
            !existingHashes.has(torrent.hash) &&
            torrent.category === "akflix-stream"
        )
        .map((torrent) => qbt.delete(torrent.hash, true).catch(() => {}))
    );
    set((state) => ({
      torrents: state.torrents.filter(
        (torrent) => !hashes.has(torrent.hash) || existingHashes.has(torrent.hash)
      ),
    }));
  },

  cancelPendingStream: async (expectedRequestId) => {
    const state = get();
    if (expectedRequestId !== undefined && state.streamRequestId !== expectedRequestId) return;
    const { pendingStreamHash: hash, pendingStreamTemporary: temporary } = state;
    suppressStreamAdoptionUntil = Date.now() + 30_000;
    set({
      streamRequestId: state.streamRequestId + 1,
      pendingStreamHash: null,
      pendingStreamTemporary: false,
      pendingStreamFileIndex: null,
      pendingStreamFileName: null,
      pendingStreamFileSize: null,
      pendingStreamHeadBytes: 0,
      pendingStreamFallbacks: [],
      pendingStreamStartedAt: 0,
      pendingStreamMedia: null,
      streamLaunchPhase: null,
      streamLaunchMedia: null,
    });
    if (hash && temporary) {
      await get().qbt().delete(hash, true);
      set((state) => ({ torrents: state.torrents.filter((torrent) => torrent.hash !== hash) }));
      useAuth.getState().client()?.refreshLibrary().catch(() => {});
    }
  },

  failoverPendingStream: async (expectedRequestId) => {
    const state = get();
    const requestId = expectedRequestId ?? state.streamRequestId;
    if (state.streamRequestId !== requestId) return null;
    const oldHash = state.pendingStreamHash;
    const oldTemporary = state.pendingStreamTemporary;
    const candidates = [...state.pendingStreamFallbacks];
    const media = state.pendingStreamMedia;
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
    if (get().streamRequestId !== requestId) return null;

    while (candidates.length) {
      const candidate = candidates.shift()!;
      const link = candidate.magnetUrl ?? candidate.downloadUrl;
      if (!link) continue;
      try {
        await get().addMagnet(link, "stream", candidate.fileIndex, media, undefined, requestId);
        if (get().streamRequestId !== requestId) return null;
        set({
          pendingStreamFallbacks: candidates,
          pendingStreamStartedAt: Date.now(),
          pendingStreamMedia: media,
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
    set({
      activeStreamHash: null,
      activeStreamTemporary: false,
    });
    suppressStreamAdoptionUntil = Date.now() + 30_000;
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
    const tick = async () => {
      try {
        const client = get().qbt();
        // Complete one-time cleanup before listing sessions. Otherwise an old
        // temporary session can be adopted by the UI while it is still filling
        // the disk in the background.
        await client.optimizeForStreaming();
        const torrents = await client.list();
        const {
          pendingStreamHash: pending,
          pendingStreamFileIndex: fileIndex,
          activeStreamHash: active,
        } = get();
        // Adopt a temporary stream after an app rebuild/restart so it can be
        // resumed or cancelled instead of silently occupying disk space.
        const adopted = pending || Date.now() < suppressStreamAdoptionUntil
          ? null
          : active
            ? null
            : torrents.find((torrent) => torrent.category === "akflix-stream")?.hash ?? null;
        const streamHash = pending ?? adopted;
        const headBytes =
          pending && fileIndex !== null && !client.instantStreaming
            ? await client.contiguousFileHeadBytes(pending, fileIndex).catch(() => 0)
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
