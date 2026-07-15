/** Reliable public trackers appended to raw Torrentio hashes for faster discovery. */
export const FAST_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://exodus.desync.com:6969/announce",
  "https://tracker.tamersunion.org:443/announce",
  "https://tracker.gbitt.info:443/announce",
];

export function addFastTrackers(magnet: string): string {
  if (!magnet.startsWith("magnet:?")) return magnet;
  const lower = magnet.toLowerCase();
  const suffix = FAST_TRACKERS
    .filter((tracker) => !lower.includes(encodeURIComponent(tracker).toLowerCase()))
    .map((tracker) => `tr=${encodeURIComponent(tracker)}`)
    .join("&");
  return suffix ? `${magnet}&${suffix}` : magnet;
}
