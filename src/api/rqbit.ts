/**
 * Adapter for Akflix's bundled rqbit engine.
 *
 * rqbit downloads pieces in playback order and exposes a seekable HTTP Range
 * stream for every file. Matching qBittorrent's small interface lets the rest
 * of the app support both the zero-setup engine and an advanced external
 * qBittorrent installation.
 */

import { httpRaw } from "@/lib/http";
import { addFastTrackers } from "@/lib/torrentTrackers";
import type { QbtFile, QbtTorrent, TorrentAddMode } from "@/types/torrent";
import { selectVideoFile, type EpisodeFileHint } from "@/lib/mediaSelection";

const DEFAULT_URL = "http://127.0.0.1:3031";
const MODE_KEY = "akflix.embedded-torrent-modes";

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
  localStorage.setItem(MODE_KEY, JSON.stringify(modes));
}

function mapEta(value: number | { secs?: number } | null | undefined): number {
  if (typeof value === "number") return Math.max(0, Math.round(value));
  if (value && typeof value === "object" && "secs" in value) return Number(value.secs ?? 8640000);
  return 8640000;
}

export class RqbitClient {
  readonly instantStreaming = true;
  readonly configured = true;

  constructor(private baseUrl = DEFAULT_URL) {
    this.baseUrl = this.baseUrl.replace(/\/+$/, "");
  }

  private async request(path: string, init: { method?: string; body?: string; json?: unknown } = {}) {
    const body = init.json === undefined ? init.body : JSON.stringify(init.json);
    return httpRaw(`${this.baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers:
        init.json === undefined
          ? body
            ? { "Content-Type": "text/plain" }
            : undefined
          : { "Content-Type": "application/json" },
      body,
    });
  }

  async add(value: string, mode: TorrentAddMode = "download", _savePath?: string): Promise<void> {
    const hash = magnetHash(value);
    const existingMode = hash ? readModes()[hash] : undefined;
    const candidates = hash
      ? [`https://itorrents.org/torrent/${hash.toUpperCase()}.torrent`, addFastTrackers(value)]
      : [value];
    let lastError = "The source could not be added";

    for (const candidate of candidates) {
      try {
        const response = await this.request("/torrents", {
          method: "POST",
          body: candidate,
        });
        if (!response.ok) {
          lastError = `Embedded engine rejected the source (HTTP ${response.status})`;
          continue;
        }
        const added = (await response.json()) as RqbitAddResponse;
        const resolvedHash = added.details?.info_hash?.toLowerCase() ?? hash;
        if (resolvedHash) writeMode(resolvedHash, existingMode ?? mode);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    throw new Error(lastError);
  }

  async list(): Promise<QbtTorrent[]> {
    const response = await this.request("/torrents?with_stats=true");
    if (!response.ok) throw new Error(`Embedded torrent engine unavailable (HTTP ${response.status})`);
    const payload = (await response.json()) as { torrents?: RqbitDetails[] };
    const modes = readModes();
    return (payload.torrents ?? []).map((details) => this.mapTorrent(details, modes));
  }

  private mapTorrent(details: RqbitDetails, modes: Record<string, TorrentAddMode>): QbtTorrent {
    const stats = details.stats ?? {};
    const total = stats.total_bytes ?? details.files?.reduce((sum, file) => sum + file.length, 0) ?? 0;
    const progressBytes = stats.progress_bytes ?? 0;
    const state = stats.finished ? "uploading" : stats.state === "paused" ? "pausedDL" : "downloading";
    const mode = modes[details.info_hash.toLowerCase()] ?? "download";
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
    const response = await this.request(`/torrents/${hash}/update_only_files`, {
      method: "POST",
      json: { only_files: [selected.index] },
    });
    if (!response.ok) throw new Error(`Could not select the video file (HTTP ${response.status})`);
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
    await this.action(hash, deleteFiles ? "delete" : "forget");
    writeMode(hash, null);
  }

  private async action(hash: string, action: string): Promise<void> {
    const response = await this.request(`/torrents/${hash}/${action}`, { method: "POST" });
    if (!response.ok) throw new Error(`Torrent action failed (HTTP ${response.status})`);
  }

  async setSequential(_hash: string): Promise<void> {}
  async refreshStreamPriority(_hash: string): Promise<void> {}
  async optimizeForStreaming(): Promise<void> {}

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
