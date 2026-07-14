/**
 * Torrent search via Prowlarr (https://prowlarr.com).
 *
 * Prowlarr aggregates dozens of indexers behind one API — Akflix queries it
 * and normalizes results into TorrentResult. Jackett works too: its Torznab
 * "all" endpoint can be adapted here, but Prowlarr's JSON API is cleaner.
 *
 * ⚖️ LEGAL NOTE: BitTorrent is a legitimate protocol, but downloading or
 * sharing copyrighted material without permission is illegal in most
 * jurisdictions. Configure indexers only for content you have the right to
 * access (public-domain media, Creative Commons, Linux ISOs, your own
 * purchases where permitted). You are responsible for how you use this.
 */

import { httpJson } from "@/lib/http";
import type { TorrentResult } from "@/types/torrent";

interface ProwlarrRelease {
  guid: string;
  title: string;
  indexer: string;
  size: number;
  seeders?: number;
  leechers?: number;
  magnetUrl?: string;
  downloadUrl?: string;
  publishDate?: string;
  categories?: { name: string }[];
  protocol: string; // "torrent" | "usenet"
}

export class ProwlarrClient {
  constructor(private baseUrl: string, private apiKey: string) {}

  private headers() {
    return { "X-Api-Key": this.apiKey };
  }

  get configured(): boolean {
    return !!this.baseUrl && !!this.apiKey;
  }

  /**
   * Search all configured indexers.
   * @param query free-text query, e.g. "Big Buck Bunny 2160p"
   * @param categories Torznab category ids — 2000=Movies, 5000=TV
   */
  async search(
    query: string,
    categories: number[] = [2000, 5000],
    signal?: AbortSignal
  ): Promise<TorrentResult[]> {
    const q = new URLSearchParams({ query, type: "search" });
    for (const c of categories) q.append("categories", String(c));

    const releases = await httpJson<ProwlarrRelease[]>(
      `${this.baseUrl}/api/v1/search?${q}`,
      { headers: this.headers(), signal }
    );

    return releases
      .filter((r) => r.protocol === "torrent")
      .map<TorrentResult>((r) => ({
        guid: r.guid,
        title: r.title,
        indexer: r.indexer,
        size: r.size ?? 0,
        seeders: r.seeders ?? 0,
        leechers: r.leechers ?? 0,
        magnetUrl: r.magnetUrl,
        downloadUrl: r.downloadUrl,
        publishDate: r.publishDate,
        category: r.categories?.[0]?.name,
      }))
      .sort((a, b) => b.seeders - a.seeders);
  }

  /** Quick connectivity check for the Settings page. */
  async test(): Promise<boolean> {
    try {
      await httpJson(`${this.baseUrl}/api/v1/health`, { headers: this.headers() });
      return true;
    } catch {
      return false;
    }
  }
}
