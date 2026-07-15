/**
 * qBittorrent Web API v2 client — Akflix's torrent manager backend.
 * Docs: https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-(qBittorrent-4.1)
 *
 * Auth: qBittorrent uses a session cookie (SID). Browsers set cookies
 * automatically (works with the Vite proxy); under Tauri we capture the
 * Set-Cookie header ourselves and replay it. Tip: enabling "Bypass
 * authentication for clients on localhost" in qBittorrent makes local
 * setups zero-config.
 *
 * Streaming-while-downloading strategy:
 *   1. Add the magnet with sequentialDownload + firstLastPiecePrio so pieces
 *      arrive in playback order.
 *   2. The download folder is also a Jellyfin library (see docker-compose),
 *      so once enough of the file exists we trigger a Jellyfin library scan
 *      and play it through Jellyfin like any other item — giving us
 *      transcoding, subtitles and progress tracking for free.
 */

import { httpRaw, normalizeUrl } from "@/lib/http";
import type { QbtFile, QbtTorrent, TorrentAddMode } from "@/types/torrent";
import { selectVideoFile, type EpisodeFileHint } from "@/lib/mediaSelection";
import { addFastTrackers } from "@/lib/torrentTrackers";

function magnetHash(value: string): string | null {
  return value.match(/(?:\?|&)xt=urn(?::|%3A)btih(?::|%3A)([a-f\d]{40})/i)?.[1]?.toLowerCase() ?? null;
}

export class QbtClient {
  readonly instantStreaming = false;
  /** Full session cookie pair. qBittorrent 5 uses QBT_SID_<port>; older
   * releases used SID, so retaining the name is required for compatibility. */
  private sessionCookie: string | null = null;
  private streamingOptimized = false;

  constructor(
    private baseUrl: string,
    private username = "admin",
    private password = ""
  ) {
    this.baseUrl = normalizeUrl(baseUrl);
  }

  get configured(): boolean {
    return !!this.baseUrl;
  }

  private async request(
    path: string,
    body?: URLSearchParams,
    retry = true
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.sessionCookie) headers["Cookie"] = this.sessionCookie;
    if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";

    const res = await httpRaw(`${this.baseUrl}/api/v2${path}`, {
      method: body ? "POST" : "GET",
      headers,
      body: body?.toString(),
    });

    // Session expired → login once and retry.
    if ((res.status === 401 || res.status === 403) && retry) {
      await this.login();
      return this.request(path, body, false);
    }
    return res;
  }

  /** Log in and capture the SID cookie (needed for the Tauri build). */
  async login(): Promise<void> {
    const body = new URLSearchParams({
      username: this.username,
      password: this.password,
    });
    const res = await httpRaw(`${this.baseUrl}/api/v2/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const text = await res.text();
    if (!res.ok || text.trim() === "Fails.") {
      throw new Error("qBittorrent login failed. Check credentials in Settings.");
    }
    const setCookies =
      (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ??
      [res.headers.get("set-cookie") ?? ""];
    for (const setCookie of setCookies) {
      const match = setCookie.match(/\b((?:QBT_)?SID(?:_\d+)?)=([^;]+)/i);
      if (match) {
        this.sessionCookie = `${match[1]}=${match[2]}`;
        break;
      }
    }
    // No Set-Cookie visible (browser mode): the browser holds it — that's fine.
  }

  /**
   * Add a magnet link or .torrent URL.
   * @param streamMode sequential download so the file is playable early
   */
  async add(
    magnetOrUrl: string,
    mode: TorrentAddMode = "download",
    savePath?: string
  ): Promise<void> {
    const streamMode = mode === "stream";
    const hash = magnetHash(magnetOrUrl);
    const magnet = addFastTrackers(magnetOrUrl);
    // iTorrents frequently has the tiny .torrent descriptor cached. Sending
    // it beside the magnet skips minutes of DHT metadata discovery; the
    // magnet remains as an automatic fallback when the cache misses.
    const urls = streamMode && hash
      ? `https://itorrents.org/torrent/${hash.toUpperCase()}.torrent\n${magnet}`
      : magnet;
    const body = new URLSearchParams({
      urls,
      sequentialDownload: String(streamMode),
      firstLastPiecePrio: String(streamMode),
      category: streamMode ? "akflix-stream" : "akflix-download",
      tags: streamMode ? "temporary" : "offline",
      addToTopOfQueue: String(streamMode),
    });
    if (savePath) body.set("savepath", savePath);
    const res = await this.request("/torrents/add", body);
    if (!res.ok) throw new Error(`Failed to add torrent (HTTP ${res.status})`);
  }

  /** All Akflix-managed torrents (newest first). */
  async list(): Promise<QbtTorrent[]> {
    const res = await this.request("/torrents/info?sort=added_on&reverse=true");
    if (!res.ok) throw new Error(`qBittorrent unreachable (HTTP ${res.status})`);
    const torrents = (await res.json()) as QbtTorrent[];
    return torrents.filter((torrent) => torrent.category?.startsWith("akflix"));
  }

  async files(hash: string): Promise<QbtFile[]> {
    const res = await this.request(`/torrents/files?hash=${hash}`);
    if (!res.ok) throw new Error(`Could not inspect torrent files (HTTP ${res.status})`);
    return (await res.json()) as QbtFile[];
  }

  /**
   * Bytes available consecutively from the selected file's beginning.
   * Overall torrent progress is not useful for progressive playback because
   * completed pieces can be scattered anywhere in the file.
   */
  async contiguousFileHeadBytes(hash: string, fileIndex: number): Promise<number> {
    const [files, piecesRes, propertiesRes] = await Promise.all([
      this.files(hash),
      this.request(`/torrents/pieceStates?hash=${hash}`),
      this.request(`/torrents/properties?hash=${hash}`),
    ]);
    if (!piecesRes.ok || !propertiesRes.ok) return 0;

    const file = files.find((entry) => entry.index === fileIndex);
    if (!file?.piece_range) return 0;
    const pieces = (await piecesRes.json()) as number[];
    const properties = (await propertiesRes.json()) as { piece_size?: number };
    const pieceSize = properties.piece_size ?? 0;
    if (!pieceSize) return 0;

    const [firstPiece, lastPiece] = file.piece_range;
    let readyPieces = 0;
    for (let piece = firstPiece; piece <= lastPiece && pieces[piece] === 2; piece += 1) {
      readyPieces += 1;
    }
    return Math.min(file.size, readyPieces * pieceSize);
  }

  /**
   * Give the requested video maximum priority and skip every other file.
   * Torrentio supplies fileIdx for season packs; without applying it,
   * qBittorrent may spend the opening buffer on unrelated episodes/extras.
   */
  async prioritizeVideoFile(
    hash: string,
    preferredIndex?: number,
    episodeHint?: Omit<EpisodeFileHint, "preferredIndex">
  ): Promise<QbtFile | null> {
    const files = await this.files(hash);
    if (!files.length) return null; // Magnet metadata is still arriving.
    const selected = selectVideoFile(files, { preferredIndex, ...episodeHint });
    if (!selected) return null;

    const skippedIds = files
      .filter((file) => file.index !== selected.index && file.priority !== 0)
      .map((file) => file.index)
      .join("|");
    if (skippedIds) {
      const skipped = await this.request(
        "/torrents/filePrio",
        new URLSearchParams({ hash, id: skippedIds, priority: "0" })
      );
      if (!skipped.ok) throw new Error(`Could not skip extra files (HTTP ${skipped.status})`);
    }

    const prioritized = await this.request(
      "/torrents/filePrio",
      new URLSearchParams({ hash, id: String(selected.index), priority: "7" })
    );
    if (!prioritized.ok)
      throw new Error(`Could not prioritize video file (HTTP ${prioritized.status})`);
    return selected;
  }

  async pause(hash: string): Promise<void> {
    // "stop" on qBittorrent ≥5, "pause" on older — try both.
    const r = await this.request("/torrents/stop", new URLSearchParams({ hashes: hash }));
    if (!r.ok) await this.request("/torrents/pause", new URLSearchParams({ hashes: hash }));
  }

  async resume(hash: string): Promise<void> {
    const r = await this.request("/torrents/start", new URLSearchParams({ hashes: hash }));
    if (!r.ok) await this.request("/torrents/resume", new URLSearchParams({ hashes: hash }));
  }

  async delete(hash: string, deleteFiles: boolean): Promise<void> {
    const res = await this.request(
      "/torrents/delete",
      new URLSearchParams({ hashes: hash, deleteFiles: String(deleteFiles) })
    );
    if (!res.ok) throw new Error(`Failed to remove torrent (HTTP ${res.status})`);
  }

  /** Toggle sequential (streaming-order) download for an active torrent. */
  async setSequential(hash: string): Promise<void> {
    await this.request(
      "/torrents/toggleSequentialDownload",
      new URLSearchParams({ hashes: hash })
    );
  }

  /** Reassert streaming priorities after magnet metadata/file layout arrives. */
  async refreshStreamPriority(hash: string): Promise<void> {
    for (const endpoint of [
      "toggleSequentialDownload",
      "toggleFirstLastPiecePrio",
      "toggleSequentialDownload",
      "toggleFirstLastPiecePrio",
    ]) {
      const response = await this.request(
        `/torrents/${endpoint}`,
        new URLSearchParams({ hashes: hash })
      );
      if (!response.ok) throw new Error(`Could not refresh stream priority (HTTP ${response.status})`);
    }
  }

  /** Apply safe unlimited-throughput defaults once per local client session. */
  async optimizeForStreaming(): Promise<void> {
    if (this.streamingOptimized) return;
    const json = JSON.stringify({
      dl_limit: 0,
      scheduler_enabled: false,
      connection_speed: 100,
      max_connec: 1000,
      max_connec_per_torrent: 250,
      max_active_downloads: 6,
      max_active_torrents: 10,
      announce_to_all_trackers: true,
      announce_to_all_tiers: true,
      async_io_threads: 16,
      upnp: true,
    });
    const response = await this.request(
      "/app/setPreferences",
      new URLSearchParams({ json })
    );
    if (!response.ok) throw new Error(`Could not tune qBittorrent (HTTP ${response.status})`);
    this.streamingOptimized = true;
  }

  streamUrl(_hash: string, _fileIndex: number): null {
    return null;
  }

  async test(): Promise<boolean> {
    try {
      const res = await this.request("/app/version");
      return res.ok;
    } catch {
      return false;
    }
  }
}
