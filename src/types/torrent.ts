/** A normalized torrent search result (from Prowlarr or Torrentio). */
export interface TorrentResult {
  guid: string;
  title: string;
  indexer: string;
  size: number; // bytes
  seeders: number;
  leechers: number;
  magnetUrl?: string;
  downloadUrl?: string; // .torrent file url (Prowlarr proxies these)
  /** Hosted/debrid URL that can skip BitTorrent entirely. */
  streamUrl?: string;
  publishDate?: string;
  category?: string;
  /** Selected file inside a multi-file torrent (Torrentio fileIdx). */
  fileIndex?: number;
  /** Language inferred only from explicit release tags; untagged stays neutral. */
  sourceLanguage?: "english" | "multi" | "unknown" | "non-english";
}

export type TorrentAddMode = "stream" | "download";

/** A torrent as reported by qBittorrent /torrents/info. */
export interface QbtTorrent {
  hash: string;
  name: string;
  size: number;
  progress: number; // 0..1
  dlspeed: number; // bytes/s
  upspeed: number;
  num_seeds: number;
  num_leechs: number;
  eta: number; // seconds, 8640000 = ∞
  state: string; // downloading | stalledDL | pausedDL | uploading | ...
  content_path: string;
  save_path: string;
  added_on: number;
  amount_left: number;
  seq_dl: boolean;
  category: string;
  tags: string;
}

export interface QbtFile {
  index: number;
  name: string;
  size: number;
  progress: number;
  priority: number;
  /** Inclusive global torrent piece range occupied by this file. */
  piece_range?: [number, number];
}
