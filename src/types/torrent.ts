/** A normalized torrent search result (from Prowlarr / Jackett). */
export interface TorrentResult {
  guid: string;
  title: string;
  indexer: string;
  size: number; // bytes
  seeders: number;
  leechers: number;
  magnetUrl?: string;
  downloadUrl?: string; // .torrent file url (Prowlarr proxies these)
  publishDate?: string;
  category?: string;
}

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
}

export interface QbtFile {
  index: number;
  name: string;
  size: number;
  progress: number;
  priority: number;
}
