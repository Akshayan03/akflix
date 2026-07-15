/** Torrentio client using the Stremio add-on protocol. */

import { httpJson, normalizeUrl } from "@/lib/http";
import type { TorrentResult } from "@/types/torrent";
import { FAST_TRACKERS } from "@/lib/torrentTrackers";

export interface TorrentioLookup {
  imdbId: string;
  type: "movie" | "series";
  season?: number;
  episode?: number;
}

interface TorrentioManifest {
  id?: string;
  resources?: Array<string | { name?: string }>;
}

interface TorrentioStream {
  name?: string;
  title?: string;
  infoHash?: string;
  url?: string;
  fileIdx?: number;
  behaviorHints?: { filename?: string };
}

const sizeUnits: Record<string, number> = {
  B: 1,
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
};

function parseSize(text: string): number {
  const match = text.match(/💾\s*([\d.]+)\s*(B|KB|MB|GB|TB)/i);
  return match ? Number(match[1]) * (sizeUnits[match[2].toUpperCase()] ?? 0) : 0;
}

const parseSeeders = (text: string) => Number(text.match(/👤\s*(\d+)/)?.[1] ?? 0);
const parseIndexer = (text: string) =>
  text.match(/⚙️\s*([^\n]+)/)?.[1]?.trim() || "Torrentio";

/**
 * Rank sources for "press Stream and watch soon", not archival quality.
 * A modest H.264 MP4 can direct-play while an 8K/4K HEVC release normally
 * needs a very expensive transcode. Seed count remains the tie-breaker.
 */
function streamRank(result: TorrentResult): number {
  let magnet = result.magnetUrl ?? "";
  try {
    magnet = decodeURIComponent(magnet);
  } catch {
    // Ranking still works from Torrentio's title if the display name is malformed.
  }
  const text = `${result.title} ${magnet}`.toLowerCase();
  let score = 0;

  // 1080p is the fast-start sweet spot; 4K is kept available but ranked down
  // because its opening bitrate and frequent HEVC transcode delay playback.
  if (/\b1080p\b/.test(text)) score += 48;
  else if (/\b720p\b/.test(text)) score += 38;
  else if (/\b480p\b/.test(text)) score += 20;
  else if (/\b2160p\b|\b4k\b/.test(text)) score += 12;
  else if (/\b4320p\b|\b8k\b/.test(text)) score -= 25;

  if (/\b(h\.?264|x264|avc)\b/.test(text)) score += 18;
  if (/\b(h\.?265|x265|hevc|av1)\b/.test(text)) score -= 9;
  if (/\.(mp4|m4v)\b/.test(text)) score += 14;
  if (/\.(mkv)\b/.test(text)) score += 2;
  if (/\b(cam|hdcam|telesync|tsrip)\b/.test(text)) score -= 35;

  const gb = result.size / 1024 ** 3;
  if (gb > 0 && gb <= 1.2) score += 7;
  else if (gb <= 3.5) score += 14;
  else if (gb <= 6) score += 5;
  else if (gb > 12) score -= 22;

  // Reported peers are only a hint, but a healthy swarm matters more than a
  // perfect container now that Akflix can hardware-convert MKV/HEVC sources.
  score += Math.min(75, Math.log2(Math.max(1, result.seeders)) * 8);
  if (result.seeders >= 500) score += 25;
  else if (result.seeders >= 100) score += 12;
  else if (result.seeders < 20) score -= 45;
  if (result.seeders === 0) score -= 70;
  if (result.streamUrl) score += 200; // Debrid/hosted links are true click-to-play.
  return score;
}

/** Accept either the copied https:// URL or Stremio's stremio:// URL. */
function normalizeManifestUrl(url: string): string {
  const httpUrl = url.trim().replace(/^stremio:\/\//i, "https://");
  const normalized = normalizeUrl(httpUrl);
  return normalized.endsWith("/manifest.json")
    ? normalized
    : `${normalized}/manifest.json`;
}

export class TorrentioClient {
  readonly manifestUrl: string;

  constructor(manifestUrl: string) {
    this.manifestUrl = normalizeManifestUrl(manifestUrl);
  }

  get configured(): boolean {
    return /^https?:\/\//i.test(this.manifestUrl);
  }

  private streamUrl(lookup: TorrentioLookup): string {
    const id =
      lookup.type === "series"
        ? `${lookup.imdbId}:${lookup.season ?? 1}:${lookup.episode ?? 1}`
        : lookup.imdbId;
    return this.manifestUrl.replace(
      /manifest\.json$/,
      `stream/${lookup.type}/${encodeURIComponent(id)}.json`
    );
  }

  async streams(lookup: TorrentioLookup, signal?: AbortSignal): Promise<TorrentResult[]> {
    const response = await httpJson<{ streams?: TorrentioStream[] }>(
      this.streamUrl(lookup),
      { signal }
    );

    return (response.streams ?? [])
      .filter((stream) => !!stream.infoHash || !!stream.url)
      .map<TorrentResult>((stream) => {
        const infoHash = stream.infoHash?.toLowerCase();
        const title = stream.title?.trim() || stream.behaviorHints?.filename || infoHash || "Direct stream";
        const filename = stream.behaviorHints?.filename || title.split("\n")[0];
        const magnet = infoHash
          ? new URLSearchParams({ xt: `urn:btih:${infoHash}`, dn: filename })
          : null;
        for (const tracker of FAST_TRACKERS) magnet?.append("tr", tracker);
        return {
          guid: infoHash ? `${infoHash}:${stream.fileIdx ?? 0}` : `direct:${stream.url}`,
          title,
          indexer: parseIndexer(title),
          size: parseSize(title),
          seeders: parseSeeders(title),
          leechers: 0,
          magnetUrl: magnet ? `magnet:?${magnet.toString()}` : undefined,
          streamUrl: stream.url,
          category: stream.name?.replace(/\n/g, " · "),
          fileIndex: stream.fileIdx,
        };
      })
      .sort((a, b) => {
        const rank = streamRank(b) - streamRank(a);
        if (rank) return rank;
        const seeds = b.seeders - a.seeders;
        if (seeds) return seeds;
        return a.size - b.size;
      });
  }

  async test(): Promise<boolean> {
    try {
      const manifest = await httpJson<TorrentioManifest>(this.manifestUrl);
      return (
        manifest.id === "com.stremio.torrentio.addon" ||
        manifest.resources?.some((resource) =>
          typeof resource === "string" ? resource === "stream" : resource.name === "stream"
        ) === true
      );
    } catch {
      return false;
    }
  }
}
