/**
 * Starting a peer stream, as a set of deadlines instead of hopes.
 *
 * A source must show progress at every stage: the engine must know the file,
 * someone must be connected, and the first bytes of the video must arrive.
 * Whichever stage runs out of time moves on to the next ranked source, and
 * when nothing is left the attempt ends with a reason instead of a spinner.
 */
import type { TorrentResult } from "@/types/torrent";
import { httpRaw } from "@/lib/http";

const MIB = 1024 * 1024;

export const START_LIMITS = {
  /** Nobody connected (or the file list never came) by now: try the next source. */
  noPeersMs: 12_000,
  /** Connected, but the opening of the video never arrived. */
  noFirstByteMs: 25_000,
  /**
   * Connected and receiving data: the opening piece is on its way. A whole
   * piece must arrive before its first byte can be served: 7-26 s for most
   * healthy sources measured on 2026-10-20 (26 s for a 422-seed release of
   * The Office), while waiting 45 s on slow ones cost more than moving on.
   */
  receivingNoFirstByteMs: 35_000,
  receivingBytesPerSecond: 128 * 1024,
  /** The last source left gets longer before Akflix gives up on the title. */
  lastSourceNoPeersMs: 20_000,
  lastSourceNoFirstByteMs: 45_000,
  lastSourceReceivingNoFirstByteMs: 60_000,
  /** Total time for one press of Play across every source tried. */
  requestBudgetMs: 120_000,
  /**
   * Nothing from the source by now: warm up the next ranked one beside it and
   * switch if it delivers first. Which swarm starts fast does not follow the
   * seed count (The Office: a 7-seed pack opened in 4 s, a 422-seed one in 26 s).
   */
  warmNextAfterMs: 8_000,
};

export type StartStage = "source" | "files" | "peers" | "opening" | "player";

export interface StartSnapshot {
  now: number;
  /** When the current source was started. */
  startedAt: number;
  /** When Play was pressed. */
  requestStartedAt: number;
  /** The engine knows which file to play. */
  fileSelected: boolean;
  /** Peers connected to the current source. */
  peers: number;
  /** A byte of the selected file has been served. */
  firstByte: boolean;
  /** Current download speed of the source (bytes per second). */
  downloadBps?: number;
  /** Ranked sources still untried. */
  fallbacks: number;
}

export type StartDecision =
  | { kind: "wait" }
  | { kind: "failover"; reason: string }
  | { kind: "give-up"; reason: string };

function stall(snapshot: StartSnapshot): { limit: number; reason: string } {
  const last = snapshot.fallbacks === 0;
  if (!snapshot.fileSelected) {
    return { limit: last ? START_LIMITS.lastSourceNoPeersMs : START_LIMITS.noPeersMs, reason: "The source's file list never arrived." };
  }
  if (snapshot.peers <= 0) {
    return { limit: last ? START_LIMITS.lastSourceNoPeersMs : START_LIMITS.noPeersMs, reason: "Nobody is sharing this source right now." };
  }
  const receiving = (snapshot.downloadBps ?? 0) >= START_LIMITS.receivingBytesPerSecond;
  const limit = receiving
    ? last
      ? START_LIMITS.lastSourceReceivingNoFirstByteMs
      : START_LIMITS.receivingNoFirstByteMs
    : last
      ? START_LIMITS.lastSourceNoFirstByteMs
      : START_LIMITS.noFirstByteMs;
  return { limit, reason: "The source is too slow to start." };
}

/** What to do with the current source now. Pure: the caller acts on it. */
export function decideStart(snapshot: StartSnapshot): StartDecision {
  if (snapshot.firstByte || !snapshot.startedAt) return { kind: "wait" };
  const { limit, reason } = stall(snapshot);
  const overBudget = snapshot.requestStartedAt > 0 && snapshot.now - snapshot.requestStartedAt >= START_LIMITS.requestBudgetMs;
  if (overBudget) return { kind: "give-up", reason };
  if (snapshot.now - snapshot.startedAt < limit) return { kind: "wait" };
  return snapshot.fallbacks > 0 ? { kind: "failover", reason } : { kind: "give-up", reason };
}

export function startStage(snapshot: Pick<StartSnapshot, "fileSelected" | "peers" | "firstByte"> & { hasTorrent: boolean }): StartStage {
  if (!snapshot.hasTorrent) return "source";
  if (!snapshot.fileSelected) return "files";
  if (snapshot.firstByte) return "player";
  return snapshot.peers > 0 ? "opening" : "peers";
}

/** The longest one request waits for the opening bytes before asking again. */
export const FIRST_BYTE_WAIT_MS = 30_000;

/**
 * rqbit's stream route exists as soon as metadata resolves, but its response
 * blocks until the requested piece arrives. Opening the player before then
 * left a black screen with nobody sharing the source and no way back.
 */
export async function waitForFirstBytes(
  url: string,
  stillWanted: () => boolean,
  size = 0
): Promise<boolean> {
  // One request waits for the opening piece (the engine fetches what is being
  // read first) for as long as this source is still the one starting. Short
  // probes gave up just before it arrived and asked again later.
  const controller = new AbortController();
  const started = Date.now();
  const watch = setInterval(() => {
    if (!stillWanted() || Date.now() - started >= FIRST_BYTE_WAIT_MS) controller.abort();
  }, 250);
  // The player reads the end of the file next when the index is stored there
  // (MP4s without "fast start", MKV cues). Asking for it now downloads both
  // ends together; Oppenheimer's YTS MP4 took 8 s longer one after the other.
  if (size > 4 * MIB) {
    const tail = new AbortController();
    const tailWatch = setInterval(() => {
      if (!stillWanted() || Date.now() - started >= FIRST_BYTE_WAIT_MS) tail.abort();
    }, 250);
    void httpRaw(url, { headers: { Range: `bytes=${size - 2}-${size - 1}` }, signal: tail.signal })
      .then((response) => response.arrayBuffer())
      .catch(() => undefined)
      .finally(() => clearInterval(tailWatch));
  }
  try {
    const response = await httpRaw(url, {
      headers: { Range: "bytes=0-1" },
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const bytes = await response.arrayBuffer();
    return bytes.byteLength > 0;
  } catch {
    return false;
  } finally {
    clearInterval(watch);
  }
}

export const STAGE_LABELS: Record<StartStage, string> = {
  source: "Connecting to the source",
  files: "Reading the source",
  peers: "Looking for people sharing it",
  opening: "Loading the opening",
  player: "Opening the player",
};

const HEVC = /\b(?:h\.?265|x265|hevc)\b/i;
const AVC = /\b(?:h\.?264|x264|avc)\b/i;

function sourceText(result: TorrentResult): string {
  return `${result.title} ${result.fileNameHint ?? ""}`;
}

export interface StartupOptions {
  /** iPhone/iPad: H.264 before HEVC, because many HEVC MP4s are tagged "hev1", which AVPlayer cannot decode. */
  apple?: boolean;
  /** English audio is preferred (default), so explicitly foreign releases go last. */
  english?: boolean;
  /**
   * Desktop web player: H.264 MP4s play as they arrive, while MKVs (and HEVC,
   * whose "hev1" MP4s WebKit refuses) wait for FFmpeg to convert them first.
   */
  webPlayer?: boolean;
}

const DIRECT_FILE = /\.(?:mp4|m4v|mov|webm)\b/i;

/**
 * How likely a source is to start quickly on this device, used to order the
 * sources Akflix tries. Peers matter most, then size and resolution.
 */
export function startupScore(result: TorrentResult, options: StartupOptions = {}): number {
  if (result.streamUrl) return 10_000;
  const text = sourceText(result);
  let score = Math.log2(1 + Math.max(0, result.seeders)) * 10;
  if (result.seeders <= 0) score -= 60;
  else if (result.seeders < 3) score -= 35;
  else if (result.seeders < 8) score -= 12;
  const gb = result.size / 1024 ** 3;
  // Remuxes and 4K need far more data before the first frame.
  if (/\bremux\b/i.test(text)) score -= 20;
  if (/\b(?:2160p|4k|uhd)\b/i.test(text)) score -= 12;
  if (gb > 15) score -= 15;
  else if (gb > 8) score -= 8;
  if (options.apple) {
    if (HEVC.test(text)) score -= 30;
    else if (AVC.test(text)) score += 8;
  }
  if (options.webPlayer && DIRECT_FILE.test(result.fileNameHint ?? result.title) && !HEVC.test(text)) score += 12;
  if (/\b1080p\b/i.test(text)) score += 8;
  else if (/\b720p\b/i.test(text)) score += 5;
  else if (/\b(?:480p|360p)\b/i.test(text)) score -= 6;
  if (options.english !== false) {
    if (result.sourceLanguage === "english") score += 6;
    else if (result.sourceLanguage === "non-english") score -= 40;
  }
  return score;
}

/**
 * Sources in the order they should be tried: the provider's quality order
 * (already language- and format-aware) nudged by how fast each can start.
 */
export function orderForStartup<T extends TorrentResult>(results: T[], options: StartupOptions = {}): T[] {
  return results
    .map((result, index) => ({ result, index, score: startupScore(result, options) + Math.max(0, 20 - index) * 0.5 }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ result }) => result);
}
