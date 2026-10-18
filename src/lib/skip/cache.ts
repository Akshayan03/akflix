/**
 * What Akflix remembers between plays, per show and season: the intro and
 * credits signatures found so far and the recent episodes' opening/closing
 * fingerprints (to compare the next episode with). Markers are also kept per
 * exact file, so a rewatch has its buttons at once. Bounded (LRU) so the
 * webview's storage never fills up.
 */

import type { AudioPrint } from "./fingerprint";
import type { Signature } from "./match";
import type { SkipIdentity, SkipMarkers } from "./markers";

export interface SkipStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = "akflix.skip.v1.";
const INDEX_KEY = `${PREFIX}index`;
const MAX_SEASONS = 24;
const MAX_FILES = 300;
/** Episodes whose opening (and closing) prints are kept per season. */
export const PRINTS_PER_SEASON = 4;

interface StoredPrint {
  h: string;
  q: string;
  o: number;
  s?: number;
}

export interface EpisodePrint {
  episode: number;
  print: AudioPrint;
  /** Media duration of that episode (closing prints are relative to it). */
  duration: number;
}

export interface SeasonMemory {
  intro: Signature[];
  credits: Signature[];
  openings: EpisodePrint[];
  closings: EpisodePrint[];
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodePrint(print: AudioPrint & { seconds?: number }): StoredPrint {
  const hashes = new Uint8Array(print.hashes.length * 4);
  const view = new DataView(hashes.buffer);
  print.hashes.forEach((hash, index) => view.setUint32(index * 4, hash, true));
  const quiet = new Uint8Array(Math.ceil(print.quiet.length / 8));
  print.quiet.forEach((flag, index) => {
    if (flag) quiet[index >> 3] |= 1 << (index & 7);
  });
  return {
    h: toBase64(hashes),
    q: toBase64(quiet),
    o: Math.round(print.offset * 1000) / 1000,
    ...(print.seconds !== undefined ? { s: Math.round(print.seconds * 1000) / 1000 } : {}),
  };
}

export function decodePrint(stored: StoredPrint): AudioPrint & { seconds: number } {
  const bytes = fromBase64(stored.h);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hashes = new Uint32Array(Math.floor(bytes.length / 4));
  for (let i = 0; i < hashes.length; i += 1) hashes[i] = view.getUint32(i * 4, true);
  const flags = fromBase64(stored.q);
  const quiet = new Uint8Array(hashes.length);
  for (let i = 0; i < hashes.length; i += 1) quiet[i] = (flags[i >> 3] >> (i & 7)) & 1;
  return { hashes, quiet, offset: stored.o, seconds: stored.s ?? 0 };
}

function seasonKey(identity: Pick<SkipIdentity, "show" | "season">): string {
  return `${PREFIX}season:${identity.show}:${identity.season}`;
}

function fileKey(identity: SkipIdentity): string {
  return `${PREFIX}file:${identity.show}:${identity.season}:${identity.episode}:${identity.source}`;
}

export class SkipMemory {
  constructor(private readonly storage: SkipStorage, private readonly now: () => number = () => Date.now()) {}

  private readIndex(): Record<string, number> {
    try {
      const parsed = JSON.parse(this.storage.getItem(INDEX_KEY) ?? "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private touch(key: string) {
    const index = this.readIndex();
    index[key] = this.now();
    const prune = (kind: string, max: number) => {
      const keys = Object.keys(index).filter((name) => name.startsWith(`${PREFIX}${kind}:`));
      if (keys.length <= max) return;
      keys.sort((a, b) => index[a] - index[b]);
      for (const old of keys.slice(0, keys.length - max)) {
        this.storage.removeItem(old);
        delete index[old];
      }
    };
    prune("season", MAX_SEASONS);
    prune("file", MAX_FILES);
    this.write(INDEX_KEY, JSON.stringify(index));
  }

  /** Storage can be full or unavailable; skipping is optional, playback isn't. */
  private write(key: string, value: string): boolean {
    try {
      this.storage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  markers(identity: SkipIdentity): SkipMarkers | null {
    try {
      const raw = this.storage.getItem(fileKey(identity));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { markers?: SkipMarkers };
      return parsed.markers ?? null;
    } catch {
      return null;
    }
  }

  saveMarkers(identity: SkipIdentity, markers: SkipMarkers) {
    const key = fileKey(identity);
    if (this.write(key, JSON.stringify({ markers, at: this.now() }))) this.touch(key);
  }

  season(identity: Pick<SkipIdentity, "show" | "season">): SeasonMemory {
    const empty: SeasonMemory = { intro: [], credits: [], openings: [], closings: [] };
    try {
      const raw = this.storage.getItem(seasonKey(identity));
      if (!raw) return empty;
      const parsed = JSON.parse(raw) as {
        intro?: StoredPrint[];
        credits?: StoredPrint[];
        openings?: Array<{ e: number; d: number; p: StoredPrint }>;
        closings?: Array<{ e: number; d: number; p: StoredPrint }>;
      };
      return {
        intro: (parsed.intro ?? []).map(decodePrint),
        credits: (parsed.credits ?? []).map(decodePrint),
        openings: (parsed.openings ?? []).map((item) => ({ episode: item.e, duration: item.d, print: decodePrint(item.p) })),
        closings: (parsed.closings ?? []).map((item) => ({ episode: item.e, duration: item.d, print: decodePrint(item.p) })),
      };
    } catch {
      return empty;
    }
  }

  saveSeason(identity: Pick<SkipIdentity, "show" | "season">, memory: SeasonMemory) {
    const key = seasonKey(identity);
    const keep = (list: EpisodePrint[]) =>
      list.slice(-PRINTS_PER_SEASON).map((item) => ({ e: item.episode, d: item.duration, p: encodePrint(item.print) }));
    const value = JSON.stringify({
      intro: memory.intro.slice(-3).map(encodePrint),
      credits: memory.credits.slice(-3).map(encodePrint),
      openings: keep(memory.openings),
      closings: keep(memory.closings),
    });
    if (this.write(key, value)) {
      this.touch(key);
      return;
    }
    // Full storage: keep the signatures, drop the bulky prints.
    const compact = JSON.stringify({
      intro: memory.intro.slice(-2).map(encodePrint),
      credits: memory.credits.slice(-2).map(encodePrint),
      openings: keep(memory.openings.slice(-1)),
      closings: keep(memory.closings.slice(-1)),
    });
    if (this.write(key, compact)) this.touch(key);
  }
}

/** Replace (or add) one episode's print, oldest first. */
export function rememberPrint(list: EpisodePrint[], item: EpisodePrint): EpisodePrint[] {
  return [...list.filter((existing) => existing.episode !== item.episode), item].slice(-PRINTS_PER_SEASON);
}
