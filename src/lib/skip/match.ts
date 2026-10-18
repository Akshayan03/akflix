/**
 * Finds the longest stretch of the same audio in two fingerprints (the intro
 * Intro Skipper-style: exact hash matches propose alignments, each alignment
 * is scanned for a contiguous run of near-identical hashes). A run only counts
 * when it is long, dense and varied enough that it can't be silence, a tone or
 * chance: false skips are worse than no skip.
 */

import {
  FP_SECONDS_PER_HASH,
  bitDifference,
  hashTime,
  slicePrint,
  type AudioPrint,
} from "./fingerprint";

/**
 * Where shared audio starts and ends relative to the first and last strong
 * matches. Measured on 60 synthetic pairs (dialogue noise, rumble, music and
 * silence around the intro): the first strong hash is 1.5 s before to 0.2 s
 * after the true start, the last one 2.5 s to 0.4 s before the true end. So
 * a found intro starts at most 1.8 s late and ends up to 2.1 s early: it
 * never reaches into the episode on either side.
 */
export const MATCH_START_PAD = 1.6;
export const MATCH_END_PAD = 0.4;

export interface MatchOptions {
  minSeconds: number;
  maxSeconds: number;
  /** Hashes count as the same audio when at most this many bits differ. */
  maxBitDiff?: number;
  /** A run may skip this many seconds of unmatched hashes. */
  maxGapSeconds?: number;
  /** Matched hashes / hashes in the run. */
  minRatio?: number;
  /** Distinct hash values / hashes in the run (rules out tones and hum). */
  minDistinct?: number;
  /** Media-time windows the run must lie within, per side. */
  aRange?: [number, number];
  bRange?: [number, number];
}

export interface SideMatch {
  start: number;
  end: number;
  first: number;
  last: number;
}

export interface SegmentMatch {
  a: SideMatch;
  b: SideMatch;
  duration: number;
  matched: number;
  ratio: number;
  distinct: number;
  bitErrors: number;
}

const DEFAULTS = {
  maxBitDiff: 6,
  maxGapSeconds: 3.5,
  minRatio: 0.55,
  minDistinct: 0.3,
};
const MAX_SHIFTS = 40;
const MAX_POSITIONS = 4;

function indexRange(print: AudioPrint, range?: [number, number]): [number, number] {
  if (!range) return [0, print.hashes.length];
  const first = Math.max(0, Math.ceil((range[0] - print.offset) / FP_SECONDS_PER_HASH));
  const last = Math.min(print.hashes.length, Math.floor((range[1] - print.offset) / FP_SECONDS_PER_HASH));
  return [first, Math.max(first, last)];
}

function addPosition(index: Map<number, number[]>, key: number, position: number) {
  const list = index.get(key);
  if (!list) index.set(key, [position]);
  else if (list.length < MAX_POSITIONS) list.push(position);
}

/** Alignments (b index - a index) proposed by exact matches of either hash half. */
export function candidateShifts(a: AudioPrint, b: AudioPrint, aWindow: [number, number], bWindow: [number, number]): number[] {
  const high = new Map<number, number[]>();
  const low = new Map<number, number[]>();
  const genericA = genericMask(a);
  const genericB = genericMask(b);
  for (let j = bWindow[0]; j < bWindow[1]; j += 1) {
    if (genericB[j]) continue;
    addPosition(high, b.hashes[j] >>> 16, j);
    addPosition(low, b.hashes[j] & 0xffff, j);
  }
  const votes = new Map<number, number>();
  for (let i = aWindow[0]; i < aWindow[1]; i += 1) {
    if (genericA[i]) continue;
    const seen = new Set<number>();
    for (const list of [high.get(a.hashes[i] >>> 16), low.get(a.hashes[i] & 0xffff)]) {
      if (!list) continue;
      for (const j of list) {
        const shift = j - i;
        if (seen.has(shift)) continue;
        seen.add(shift);
        votes.set(shift, (votes.get(shift) ?? 0) + 1);
      }
    }
  }
  return [...votes.entries()]
    .filter(([, count]) => count >= 3)
    .sort((x, y) => y[1] - x[1] || x[0] - y[0])
    .slice(0, MAX_SHIFTS)
    .map(([shift]) => shift);
}

/** Offsets (hashes: 5 to 32 s) a hash is compared with in its own print. */
const SELF_OFFSETS = [40, 56, 72, 96, 128, 160, 200, 256];
/** A hash that resembles this share of its surroundings describes generic audio. */
const GENERIC_SHARE = 0.5;
/** Run edges must sit in stretches at least this dense in strong matches (2 s windows). */
const EDGE_WINDOW = 16;
const EDGE_DENSITY = 0.5;
/** A strong match: re-encoded copies of the same audio agree this closely
 * (97-99% of hashes on the generated episodes), unrelated noise almost never (1%). */
const STRONG_BIT_DIFF = 2;
const MIN_STRONG_RATIO = 0.35;
const genericCache = new WeakMap<AudioPrint, Uint8Array>();

/**
 * Hashes of steady audio (a held tone, hum, silence) look alike wherever they
 * are, so two episodes "share" them by chance. A hash that resembles half of
 * its own surroundings is generic; generic and quiet hashes are never evidence
 * of shared audio. Music changes note to note and passes; a looped bar or a
 * repeated chorus only resembles itself at a few offsets. (Noise-like audio is
 * handled by the strong-match edges in evaluateShift.)
 */
export function genericMask(print: AudioPrint, maxBitDiff = DEFAULTS.maxBitDiff): Uint8Array {
  const cached = genericCache.get(print);
  if (cached) return cached;
  const { hashes, quiet } = print;
  const mask = new Uint8Array(hashes.length);
  for (let i = 0; i < hashes.length; i += 1) {
    if (quiet[i]) {
      mask[i] = 1;
      continue;
    }
    let total = 0;
    let alike = 0;
    for (const offset of SELF_OFFSETS) {
      for (const k of [i - offset, i + offset]) {
        if (k < 0 || k >= hashes.length || quiet[k]) continue;
        total += 1;
        if (bitDifference(hashes[i], hashes[k]) <= maxBitDiff) alike += 1;
      }
    }
    mask[i] = total >= 4 && alike >= total * GENERIC_SHARE ? 1 : 0;
  }
  genericCache.set(print, mask);
  return mask;
}

function evaluateShift(
  a: AudioPrint,
  b: AudioPrint,
  shift: number,
  aWindow: [number, number],
  bWindow: [number, number],
  options: Required<Omit<MatchOptions, "aRange" | "bRange">>
): SegmentMatch | null {
  const start = Math.max(aWindow[0], bWindow[0] - shift);
  const end = Math.min(aWindow[1], bWindow[1] - shift);
  const maxGap = Math.round(options.maxGapSeconds / FP_SECONDS_PER_HASH);
  const genericA = genericMask(a, options.maxBitDiff);
  const genericB = genericMask(b, options.maxBitDiff);
  let best: SegmentMatch | null = null;
  // Matched positions of the current run, and which of them are strong.
  let run: number[] = [];
  let strong: boolean[] = [];

  const finish = () => {
    // A run starts and ends inside stretches dense in strong matches: weak
    // near-matches (noise resembles noise) may fill gaps, never stretch edges.
    const prefix = new Int32Array(run.length + 1);
    for (let m = 0; m < run.length; m += 1) prefix[m + 1] = prefix[m] + (strong[m] ? 1 : 0);
    /** First run index whose position is >= `position`. */
    const lower = (position: number) => {
      let lo = 0;
      let hi = run.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (run[mid] < position) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    /** Strong matches at positions [from, to). */
    const strongIn = (from: number, to: number) => prefix[lower(to)] - prefix[lower(from)];
    let from = 0;
    let to = run.length - 1;
    const need = EDGE_WINDOW * EDGE_DENSITY;
    while (from <= to && !(strong[from] && strongIn(run[from], run[from] + EDGE_WINDOW) >= need)) from += 1;
    while (to >= from && !(strong[to] && strongIn(run[to] - EDGE_WINDOW + 1, run[to] + 1) >= need)) to -= 1;
    if (from <= to) {
      const first = run[from];
      const last = run[to];
      const matched = to - from + 1;
      let strongCount = 0;
      for (let m = from; m <= to; m += 1) if (strong[m]) strongCount += 1;
      const length = last - first + 1;
      const duration = length * FP_SECONDS_PER_HASH;
      if (duration >= options.minSeconds && duration <= options.maxSeconds) {
        const ratio = matched / length;
        const values = new Set<number>();
        let bits = 0;
        for (let i = first; i <= last; i += 1) {
          values.add(a.hashes[i]);
          bits += bitDifference(a.hashes[i], b.hashes[i + shift]);
        }
        const distinct = values.size / length;
        if (
          ratio >= options.minRatio &&
          strongCount / length >= MIN_STRONG_RATIO &&
          distinct >= options.minDistinct &&
          (!best || matched > best.matched)
        ) {
          best = {
            a: { first, last, start: hashTime(a, first) + MATCH_START_PAD, end: hashTime(a, last) + MATCH_END_PAD },
            b: {
              first: first + shift,
              last: last + shift,
              start: hashTime(b, first + shift) + MATCH_START_PAD,
              end: hashTime(b, last + shift) + MATCH_END_PAD,
            },
            duration: hashTime(a, last) + MATCH_END_PAD - (hashTime(a, first) + MATCH_START_PAD),
            matched,
            ratio,
            distinct,
            bitErrors: bits / length,
          };
        }
      }
    }
    run = [];
    strong = [];
  };

  for (let i = start; i < end; i += 1) {
    const j = i + shift;
    if (genericA[i] || genericB[j]) continue;
    const difference = bitDifference(a.hashes[i], b.hashes[j]);
    if (difference > options.maxBitDiff) continue;
    if (run.length && i - run[run.length - 1] > maxGap) finish();
    run.push(i);
    strong.push(difference <= STRONG_BIT_DIFF);
  }
  finish();
  return best;
}

/** The longest qualifying run of shared audio, or null. */
export function bestCommonSegment(a: AudioPrint, b: AudioPrint, options: MatchOptions): SegmentMatch | null {
  const settings = { ...DEFAULTS, ...options };
  const aWindow = indexRange(a, options.aRange);
  const bWindow = indexRange(b, options.bRange);
  let best: SegmentMatch | null = null;
  for (const shift of candidateShifts(a, b, aWindow, bWindow)) {
    const found = evaluateShift(a, b, shift, aWindow, bWindow, settings);
    if (found && (!best || found.matched > best.matched)) best = found;
  }
  return best;
}

/** A stored intro/credits signature: the hashes of one episode's shared run. */
export interface Signature extends AudioPrint {
  /** Length of the shared audio in seconds (start pad to end pad). */
  seconds: number;
}

export function signatureFrom(print: AudioPrint, match: SideMatch): Signature {
  const slice = slicePrint(print, match.first, match.last + 1);
  return { ...slice, offset: 0, seconds: match.end - match.start };
}

/** A signature from a found stretch of `print` given in media time (as reported, pads included). */
export function signatureFromRange(print: AudioPrint, start: number, end: number): Signature {
  const first = Math.max(0, Math.round((start - MATCH_START_PAD - print.offset) / FP_SECONDS_PER_HASH));
  const last = Math.min(print.hashes.length - 1, Math.round((end - MATCH_END_PAD - print.offset) / FP_SECONDS_PER_HASH));
  return signatureFrom(print, { first, last: Math.max(first, last), start, end });
}

export interface SignatureHit {
  start: number;
  end: number;
  coverage: number;
  match: SegmentMatch;
}

/** Where a known signature occurs in `print` (most of it must be there). */
export function findSignature(
  signature: Signature,
  print: AudioPrint,
  options: { range?: [number, number]; minCoverage?: number; minSeconds?: number } = {}
): SignatureHit | null {
  const length = signature.hashes.length;
  if (length < 8) return null;
  const minCoverage = options.minCoverage ?? 0.7;
  const match = bestCommonSegment(signature, print, {
    minSeconds: Math.max(options.minSeconds ?? 8, signature.seconds * minCoverage * 0.9),
    maxSeconds: signature.seconds + 10,
    bRange: options.range,
  });
  if (!match) return null;
  const coverage = (match.a.last - match.a.first + 1) / length;
  if (coverage < minCoverage) return null;
  // Extend to the signature's own edges when only a little is missing.
  const missingStart = match.a.first * FP_SECONDS_PER_HASH;
  const missingEnd = (length - 1 - match.a.last) * FP_SECONDS_PER_HASH;
  const start = match.b.start - (missingStart <= 3 ? missingStart : 0);
  const end = match.b.end + (missingEnd <= 3 ? missingEnd : 0);
  return { start: Math.max(0, start), end, coverage, match };
}
