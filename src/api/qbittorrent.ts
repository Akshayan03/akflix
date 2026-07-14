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
import type { QbtFile, QbtTorrent } from "@/types/torrent";

export class QbtClient {
  private sid: string | null = null;

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
    if (this.sid) headers["Cookie"] = `SID=${this.sid}`;
    if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";

    const res = await httpRaw(`${this.baseUrl}/api/v2${path}`, {
      method: body ? "POST" : "GET",
      headers,
      body: body?.toString(),
    });

    // Session expired → login once and retry.
    if (res.status === 403 && retry) {
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
      throw new Error("qBittorrent login failed — check credentials in Settings.");
    }
    const setCookie = res.headers.get("set-cookie");
    const m = setCookie?.match(/SID=([^;]+)/);
    if (m) this.sid = m[1];
    // No Set-Cookie visible (browser mode): the browser holds it — that's fine.
  }

  /**
   * Add a magnet link or .torrent URL.
   * @param streamMode sequential download so the file is playable early
   */
  async add(magnetOrUrl: string, streamMode = false, savePath?: string): Promise<void> {
    const body = new URLSearchParams({
      urls: magnetOrUrl,
      sequentialDownload: String(streamMode),
      firstLastPiecePrio: String(streamMode),
      category: "akflix",
    });
    if (savePath) body.set("savepath", savePath);
    const res = await this.request("/torrents/add", body);
    if (!res.ok) throw new Error(`Failed to add torrent (HTTP ${res.status})`);
  }

  /** All torrents in the "akflix" category (newest first). */
  async list(): Promise<QbtTorrent[]> {
    const res = await this.request("/torrents/info?category=akflix&sort=added_on&reverse=true");
    if (!res.ok) throw new Error(`qBittorrent unreachable (HTTP ${res.status})`);
    return (await res.json()) as QbtTorrent[];
  }

  async files(hash: string): Promise<QbtFile[]> {
    const res = await this.request(`/torrents/files?hash=${hash}`);
    return (await res.json()) as QbtFile[];
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
    await this.request(
      "/torrents/delete",
      new URLSearchParams({ hashes: hash, deleteFiles: String(deleteFiles) })
    );
  }

  /** Toggle sequential (streaming-order) download for an active torrent. */
  async setSequential(hash: string): Promise<void> {
    await this.request(
      "/torrents/toggleSequentialDownload",
      new URLSearchParams({ hashes: hash })
    );
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
