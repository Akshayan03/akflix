/** Assorted formatting helpers. */

const TICKS_PER_SECOND = 10_000_000; // Jellyfin stores durations in 100ns "ticks"

export const ticksToSeconds = (ticks?: number) =>
  ticks ? Math.floor(ticks / TICKS_PER_SECOND) : 0;

export const secondsToTicks = (seconds: number) =>
  Math.round(seconds * TICKS_PER_SECOND);

/** "2h 14m" style runtime label. */
export function formatRuntime(ticks?: number): string {
  const total = ticksToSeconds(ticks);
  if (!total) return "";
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** "1:23:45" clock for the player scrubber. */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = m.toString().padStart(2, "0");
  const ss = s.toString().padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatEta(seconds: number): string {
  if (seconds >= 8_640_000 || seconds < 0) return "∞";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export const uuid = () =>
  (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)) as string;

/** Stable per-install device id used for Jellyfin auth headers. */
export function getDeviceId(): string {
  const KEY = "akflix.deviceId";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = uuid();
    localStorage.setItem(KEY, id);
  }
  return id;
}

/** Debounce for search-as-you-type. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout>;
  return (...args: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
