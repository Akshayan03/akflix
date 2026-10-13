/**
 * Adapter for Akflix's bundled rqbit engine.
 *
 * rqbit downloads pieces in playback order and exposes a seekable HTTP Range
 * stream for every file. Matching qBittorrent's small interface lets the rest
 * of the app support both the zero-setup engine and an advanced external
 * qBittorrent installation.
 */

import { httpRaw, isTauri } from "@/lib/http";
import { safeSetItem } from "@/lib/safeStorage";
import { addFastTrackers } from "@/lib/torrentTrackers";
import type { QbtFile, QbtTorrent, TorrentAddMode } from "@/types/torrent";
import { selectVideoFile, type EpisodeFileHint } from "@/lib/mediaSelection";

const DEFAULT_URL = "http://127.0.0.1:3031";
const MODE_KEY = "akflix.embedded-torrent-modes";
// rqbit holds an add open until magnet metadata resolves (600 s by default).
// The engine enforces these limits itself so a slow add fails with a real
// error instead of the client abandoning a half-created torrent.
// The cache answers in about a second when it has the file (0.3-1.1 s for
// every hit measured on 2026-10-12); misses either fail at once or hang until
// this limit, which delayed every such source before the magnet was tried.
const METADATA_CACHE_TIMEOUT_MS = 3_000;
const MAGNET_TIMEOUT_MS = 11_000;
const CLIENT_TIMEOUT_MARGIN_MS = 3_000;
// A new or restored torrent rejects changes while its initial check runs.
const INITIALIZE_WAIT_MS = 30_000;
// Every add gets its own folder. rqbit refuses to reuse existing files
// (allow_overwrite = false) and a failed or abandoned add leaves empty files
// behind, so a shared path would block that release forever.
const ATTEMPT_FOLDER_PREFIX = "akflix-rqbit-";
const ATTEMPT_FOLDER = /^akflix-rqbit-[0-9a-f]{32}$/;

/** The engine cannot write to its storage, so every other source would fail too. */
export class EngineStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineStorageError";
  }
}

function storageFailure(detail: string): string | null {
  if (/os error (?:28|69)\b|no space left on device|disc quota exceeded/i.test(detail)) {
    return "Akflix could not start the stream because the disk that holds its playback data is full. Free some space and try again.";
  }
  if (/os error (?:13|30)\b|read-only file system/i.test(detail)) {
    return "Akflix could not start the stream because it cannot write to its playback storage. Check the media location in Settings and try again.";
  }
  return null;
}

async function engineDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { human_readable?: string; error?: string };
    return (parsed.human_readable ?? parsed.error ?? text).trim();
  } catch {
    // rqbit can return plain text for transport failures.
    return text.trim();
  }
}

function attemptFolder(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return ATTEMPT_FOLDER_PREFIX + Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The per-add folder that owns this torrent's files, if it was added that way. */
function ownedAttemptFolder(outputFolder: string): string | null {
  const parts = outputFolder.split(/[\\/]/).filter(Boolean);
  const last = parts[parts.length - 1];
  return last && ATTEMPT_FOLDER.test(last) ? last : null;
}

interface RqbitFile {
  name: string;
  length: number;
  included: boolean;
}

interface RqbitDetails {
  id?: number;
  info_hash: string;
  name?: string;
  output_folder: string;
  files?: RqbitFile[];
  stats?: RqbitStats;
}

interface RqbitStats {
  state?: string;
  file_progress?: number[];
  progress_bytes?: number;
  total_bytes?: number;
  finished?: boolean;
  live?: {
    snapshot?: { peer_stats?: { live?: number; seen?: number } };
    download_speed?: { mbps?: number };
    upload_speed?: { mbps?: number };
    time_remaining?: number | { secs?: number } | null;
  };
}

interface RqbitAddResponse {
  details: RqbitDetails;
}

function magnetHash(value: string): string | null {
  return (
    value.match(/(?:\?|&)xt=urn(?::|%3A)btih(?::|%3A)([a-f\d]{40})/i)?.[1]?.toLowerCase() ??
    null
  );
}

function readModes(): Record<string, TorrentAddMode> {
  try {
    return JSON.parse(localStorage.getItem(MODE_KEY) ?? "{}") as Record<string, TorrentAddMode>;
  } catch {
    return {};
  }
}

function writeMode(hash: string, mode: TorrentAddMode | null): void {
  const modes = readModes();
  if (mode) modes[hash.toLowerCase()] = mode;
  else delete modes[hash.toLowerCase()];
  safeSetItem(MODE_KEY, JSON.stringify(modes));
}

/** Keeping a copy upgrades a temporary stream; streaming never downgrades a download. */
function keptMode(hash: string, requested: TorrentAddMode): TorrentAddMode {
  return requested === "download" ? "download" : readModes()[hash.toLowerCase()] ?? requested;
}

function mapEta(value: number | { secs?: number } | null | undefined): number {
  if (typeof value === "number") return Math.max(0, Math.round(value));
  if (value && typeof value === "object" && "secs" in value) return Number(value.secs ?? 8640000);
  return 8640000;
}

export class RqbitClient {
  readonly instantStreaming = true;
  readonly configured = true;
  private startupCleanupComplete = false;
  private startupCleanup: Promise<void> | null = null;
  private offlineResumed = false;
  private cleanupTargets = false;
  private staleSessions = new Set<string>();
  /** Hashes added or reused by this app session; startup cleanup never touches them. */
  private claimed = new Set<string>();

  constructor(private baseUrl = DEFAULT_URL) {
    this.baseUrl = this.baseUrl.replace(/\/+$/, "");
  }

  private async request(
    path: string,
    init: {
      method?: string;
      body?: string;
      json?: unknown;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {}
  ) {
    const body = init.json === undefined ? init.body : JSON.stringify(init.json);
    const controller = new AbortController();
    const timeoutMs = init.timeoutMs ?? (init.method === "POST" ? 12_000 : 6_000);
    const abortFromCaller = () => controller.abort(init.signal?.reason);
    init.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = globalThis.setTimeout(() => controller.abort("timeout"), timeoutMs);
    try {
      return await httpRaw(`${this.baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers:
          init.json === undefined
            ? body
              ? { "Content-Type": "text/plain" }
              : undefined
            : { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted && !init.signal?.aborted) {
        throw new Error("The playback engine took too long to answer");
      }
      throw error;
    } finally {
      globalThis.clearTimeout(timeout);
      init.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  async add(
    value: string,
    mode: TorrentAddMode = "download",
    _savePath?: string,
    signal?: AbortSignal
  ): Promise<void> {
    const hash = magnetHash(value);
    if (signal?.aborted) throw new DOMException("Source search cancelled.", "AbortError");
    if (hash) {
      // Re-adding a managed torrent returns 200 but leaves a paused one paused,
      // so its stream would wait forever. Reuse it directly instead.
      const existing = await this.request(`/torrents/${hash}`, { signal });
      if (existing.ok) {
        this.claim(hash);
        writeMode(hash, keptMode(hash, mode));
        await this.resumeIfPaused(hash, signal);
        return;
      }
      if (existing.status !== 404) {
        throw new Error(
          `Embedded engine could not inspect this source: ${(await engineDetail(existing)) || `HTTP ${existing.status}`}`
        );
      }
    }
    const candidates = hash
      ? [
          // Fetching the tiny metadata file is normally much faster and more
          // reliable than waiting for magnet metadata over DHT. rqbit verifies
          // the torrent itself; the tracker-rich magnet remains the fallback.
          { body: `https://itorrents.org/torrent/${hash.toUpperCase()}.torrent`, timeoutMs: METADATA_CACHE_TIMEOUT_MS },
          { body: addFastTrackers(value), timeoutMs: MAGNET_TIMEOUT_MS },
        ]
      : [{ body: value, timeoutMs: MAGNET_TIMEOUT_MS }];
    let lastError = "The source could not be added";

    for (const candidate of candidates) {
      if (signal?.aborted) throw new DOMException("Source search cancelled.", "AbortError");
      const folder = attemptFolder();
      const query = new URLSearchParams({
        overwrite: "false",
        sub_folder: folder,
        timeout_ms: String(candidate.timeoutMs),
      });
      let response: Response;
      try {
        response = await this.request(`/torrents?${query}`, {
          method: "POST",
          body: candidate.body,
          signal,
          timeoutMs: candidate.timeoutMs + CLIENT_TIMEOUT_MARGIN_MS,
        });
      } catch (error) {
        await this.discardAttempt(folder, hash);
        if (signal?.aborted) throw new DOMException("Source search cancelled.", "AbortError");
        lastError = error instanceof Error ? error.message : String(error);
        continue;
      }
      if (!response.ok) {
        const detail = (await engineDetail(response)) || `HTTP ${response.status}`;
        await this.discardAttempt(folder, hash, true);
        const storage = storageFailure(detail);
        if (storage) throw new EngineStorageError(`${storage} (${detail})`);
        lastError = detail;
        continue;
      }

      const added = (await response.json()) as RqbitAddResponse;
      const resolvedHash = added.details?.info_hash?.toLowerCase() ?? hash;
      if (resolvedHash) {
        this.claim(resolvedHash);
        writeMode(resolvedHash, keptMode(resolvedHash, mode));
      }
      return;
    }

    throw new Error(`Embedded engine could not load this source: ${lastError}`);
  }

  private claim(hash: string): void {
    this.claimed.add(hash);
    this.staleSessions.delete(hash);
  }

  /**
   * Remove the files a failed add created in its private folder. The folder
   * name is unique to this attempt, so nothing else can live in it. Keep it if
   * the engine finished the add after all.
   */
  private async discardAttempt(folder: string, hash: string | null, engineRejected = false): Promise<void> {
    if (!isTauri()) return;
    if (hash) {
      const added = await this.request(`/torrents/${hash}`).then((r) => r.ok).catch(() => true);
      if (added) return;
    } else if (!engineRejected) {
      return;
    }
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("remove_embedded_media_files", { relativePaths: [folder] }).catch(() => {});
  }

  /** State after any initial check; restored jobs report "initializing" first. */
  private async settledState(hash: string, signal?: AbortSignal): Promise<string | undefined> {
    const deadline = Date.now() + INITIALIZE_WAIT_MS;
    for (;;) {
      const response = await this.request(`/torrents/${hash}/stats/v1`, { signal });
      if (!response.ok) {
        throw new Error(`Could not inspect torrent state: ${(await engineDetail(response)) || `HTTP ${response.status}`}`);
      }
      const { state } = (await response.json()) as RqbitStats;
      if (state !== "initializing" || Date.now() >= deadline) return state;
      if (signal?.aborted) throw new DOMException("Source search cancelled.", "AbortError");
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  /** Wake a paused torrent; streaming from a paused one never receives bytes. */
  async resumeIfPaused(hash: string, signal?: AbortSignal): Promise<void> {
    if ((await this.settledState(hash, signal)) !== "paused") return;
    try {
      await this.resume(hash);
    } catch (error) {
      // Startup cleanup and playback can resume the same torrent concurrently.
      if ((await this.settledState(hash, signal)) === "paused") throw error;
    }
  }

  async list(): Promise<QbtTorrent[]> {
    const response = await this.request("/torrents?with_stats=true");
    if (!response.ok) throw new Error(`Embedded torrent engine unavailable (HTTP ${response.status})`);
    const payload = (await response.json()) as { torrents?: RqbitDetails[] };
    const modes = readModes();
    return (payload.torrents ?? [])
      .filter((details) => !this.staleSessions.has(details.info_hash.toLowerCase()))
      .map((details) => this.mapTorrent(details, modes));
  }

  private mapTorrent(details: RqbitDetails, modes: Record<string, TorrentAddMode>): QbtTorrent {
    const stats = details.stats ?? {};
    const total = stats.total_bytes ?? details.files?.reduce((sum, file) => sum + file.length, 0) ?? 0;
    const progressBytes = stats.progress_bytes ?? 0;
    const state = stats.finished ? "uploading" : stats.state === "paused" ? "pausedDL" : "downloading";
    // An entry without an Akflix mode marker is an abandoned rqbit session,
    // not an offline download. Treat it as temporary until startup cleanup
    // removes it so stale sessions can never silently consume the disk again.
    const mode = modes[details.info_hash.toLowerCase()] ?? "stream";
    return {
      hash: details.info_hash.toLowerCase(),
      name: details.name ?? details.info_hash,
      size: total,
      progress: total ? Math.min(1, progressBytes / total) : 0,
      dlspeed: Math.round((stats.live?.download_speed?.mbps ?? 0) * 1024 * 1024),
      upspeed: Math.round((stats.live?.upload_speed?.mbps ?? 0) * 1024 * 1024),
      num_seeds: stats.live?.snapshot?.peer_stats?.live ?? 0,
      num_leechs: stats.live?.snapshot?.peer_stats?.seen ?? 0,
      eta: mapEta(stats.live?.time_remaining),
      state,
      content_path: `${details.output_folder}/${details.name ?? ""}`,
      save_path: details.output_folder,
      added_on: details.id ?? 0,
      amount_left: Math.max(0, total - progressBytes),
      seq_dl: true,
      category: mode === "stream" ? "akflix-stream" : "akflix-download",
      tags: mode === "stream" ? "temporary" : "offline",
    };
  }

  async details(hash: string): Promise<{ details: RqbitDetails; stats: RqbitStats }> {
    const [detailsResponse, statsResponse] = await Promise.all([
      this.request(`/torrents/${hash}`),
      this.request(`/torrents/${hash}/stats/v1`),
    ]);
    if (!detailsResponse.ok) throw new Error(`Could not inspect torrent files (HTTP ${detailsResponse.status})`);
    const details = (await detailsResponse.json()) as RqbitDetails;
    const stats = statsResponse.ok ? ((await statsResponse.json()) as RqbitStats) : {};
    return { details, stats };
  }

  async files(hash: string): Promise<QbtFile[]> {
    const { details, stats } = await this.details(hash);
    return (details.files ?? []).map((file, index) => ({
      index,
      name: file.name,
      size: file.length,
      progress: file.length ? Math.min(1, (stats.file_progress?.[index] ?? 0) / file.length) : 0,
      priority: file.included ? 7 : 0,
    }));
  }

  async prioritizeVideoFile(
    hash: string,
    preferredIndex?: number,
    episodeHint?: Omit<EpisodeFileHint, "preferredIndex">
  ): Promise<QbtFile | null> {
    const files = await this.files(hash);
    if (!files.length) return null;
    const selected = selectVideoFile(files, { preferredIndex, ...episodeHint });
    if (!selected) return null;
    // Watching one episode of an offline season pack must not cancel the
    // other episodes the user asked to keep.
    const onlyFiles = readModes()[hash.toLowerCase()] === "download"
      ? [...new Set([...files.filter((file) => file.priority > 0).map((file) => file.index), selected.index])]
      : [selected.index];
    const select = () =>
      this.request(`/torrents/${hash}/update_only_files`, {
        method: "POST",
        json: { only_files: onlyFiles },
      });
    let response = await select();
    // rqbit rejects file selection while a reused torrent is still checking.
    if (!response.ok && (await this.settledState(hash).catch(() => undefined)) !== "initializing") {
      response = await select();
    }
    if (!response.ok) {
      throw new Error(`Could not select the video file: ${(await engineDetail(response)) || `HTTP ${response.status}`}`);
    }
    return selected;
  }

  streamUrl(hash: string, fileIndex: number): string {
    return `${this.baseUrl}/torrents/${hash}/stream/${fileIndex}`;
  }

  async contiguousFileHeadBytes(hash: string, fileIndex: number): Promise<number> {
    const files = await this.files(hash);
    const file = files.find((candidate) => candidate.index === fileIndex);
    return file ? file.size * file.progress : 0;
  }

  async pause(hash: string): Promise<void> {
    await this.action(hash, "pause");
  }

  async resume(hash: string): Promise<void> {
    await this.action(hash, "start");
  }

  async delete(hash: string, deleteFiles: boolean): Promise<void> {
    let mediaPaths: string[] = [];
    if (deleteFiles && isTauri()) {
      try {
        const { details } = await this.details(hash);
        const owned = ownedAttemptFolder(details.output_folder);
        if (owned) {
          // Torrents added by this build own a unique folder. Never guess by
          // name: an older offline download may share the release name.
          mediaPaths = [owned];
        } else {
          const candidates = new Set(
            (details.files ?? []).map((file) => file.name).filter(Boolean)
          );
          if (details.name) candidates.add(details.name);
          const outputParts = details.output_folder.split(/[\\/]/).filter(Boolean);
          const outputFolderName = outputParts[outputParts.length - 1];
          if (outputFolderName) candidates.add(outputFolderName);
          mediaPaths = [...candidates];
        }
      } catch {
        // rqbit may already have forgotten the metadata. Its own delete call
        // remains the primary cleanup path in that case.
      }
    }
    await this.action(hash, deleteFiles ? "delete" : "forget");
    if (mediaPaths.length) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("remove_embedded_media_files", { relativePaths: mediaPaths }).catch(() => {});
    }
    writeMode(hash, null);
  }

  private async action(hash: string, action: string): Promise<void> {
    const response = await this.request(`/torrents/${hash}/${action}`, { method: "POST" });
    if (!response.ok) throw new Error(`Torrent action failed (HTTP ${response.status})`);
  }

  async setSequential(_hash: string): Promise<void> {}
  async refreshStreamPriority(_hash: string): Promise<void> {}

  async optimizeForStreaming(): Promise<void> {
    if (this.startupCleanupComplete) return;
    // Two-second polls overlap while the engine is busy. Run one cleanup at a
    // time so the same stale session is never deleted twice.
    this.startupCleanup ??= this.cleanUpPreviousSession().finally(() => {
      this.startupCleanup = null;
    });
    await this.startupCleanup;
  }

  private async cleanUpPreviousSession(): Promise<void> {
    const offline: string[] = [];
    let targets: string[];
    if (this.cleanupTargets) {
      targets = [...this.staleSessions];
    } else {
      const response = await this.request("/torrents?with_stats=true");
      if (!response.ok) {
        throw new Error(`Embedded torrent engine unavailable (HTTP ${response.status})`);
      }
      const payload = (await response.json()) as { torrents?: RqbitDetails[] };
      const modes = readModes();
      targets = [];
      for (const details of payload.torrents ?? []) {
        const hash = details.info_hash.toLowerCase();
        // Streams are temporary by design. A stream still present at process
        // startup has no player attached to it, and an entry with no mode
        // marker belongs to an older build that could leak its files.
        if (modes[hash] === "download") offline.push(hash);
        else targets.push(hash);
      }
      this.cleanupTargets = true;
    }
    const stale = new Set<string>();

    for (const hash of targets) {
      // The user started this release again while cleanup was running.
      if (this.claimed.has(hash)) continue;
      try {
        await this.delete(hash, true);
      } catch {
        const remains = await this.request(`/torrents/${hash}`)
          .then((existing) => existing.status !== 404)
          .catch(() => true);
        if (remains) stale.add(hash);
      }
    }

    // One session that cannot be removed must not block every later listing
    // (and with it every stream handoff). Hide it and retry on the next poll.
    this.staleSessions = new Set([...stale].filter((hash) => !this.claimed.has(hash)));
    if (!this.offlineResumed) {
      this.offlineResumed = true;
      // The engine pauses every saved job at launch; restored jobs can report
      // "initializing" first, so wait for each to settle before resuming it.
      void Promise.all(offline.map((hash) => this.resumeIfPaused(hash).catch(() => {})));
    }
    if (!this.staleSessions.size) this.startupCleanupComplete = true;
  }

  async test(): Promise<boolean> {
    try {
      const response = await this.request("/");
      if (!response.ok) return false;
      return ((await response.json()) as { server?: string }).server === "rqbit";
    } catch {
      return false;
    }
  }
}
