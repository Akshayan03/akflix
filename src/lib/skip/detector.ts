/**
 * Background skip-marker detection for one playing episode, in order of
 * preference:
 *   1. markers the file (chapters) or server (Jellyfin segments) names;
 *   2. markers remembered for this exact file;
 *   3. audio fingerprints: the opening minutes are matched against the
 *      season's known intro, else against other episodes' openings (the
 *      longest shared stretch is the intro); the last minutes the same way
 *      for the end credits.
 * Every step is optional and failure-tolerant: playback never waits for it,
 * and nothing is offered unless the evidence is strong (see match.ts).
 */

import { Fingerprinter, type AudioPrint } from "./fingerprint";
import {
  bestCommonSegment,
  findSignature,
  signatureFrom,
  signatureFromRange,
  type Signature,
} from "./match";
import { rememberPrint, type SeasonMemory, type SkipMemory } from "./cache";
import {
  markersFromChapters,
  mergeMarkers,
  plausibleSegment,
  sameMarkers,
  type MediaChapter,
  type SkipIdentity,
  type SkipMarkers,
  type SkipSegment,
} from "./markers";

export const OPENING_MAX_SECONDS = 600;
export const CLOSING_SECONDS = 360;
export const CHUNK_SECONDS = 60;
export const INTRO_MIN_SECONDS = 15;
export const INTRO_MAX_SECONDS = 180;
export const CREDITS_MIN_SECONDS = 15;
/** End credits run to the end, give or take a post-credits scene or preview. */
export const CREDITS_TAIL_SECONDS = 60;
/** Intro (and credits) signatures kept per season: intros can change mid-season. */
export const MAX_SIGNATURES = 3;

export interface SkipSourceAdapter {
  /** Chapters in the file's container, if it has any. */
  chapters?: (signal: AbortSignal) => Promise<MediaChapter[]>;
  /** Markers a server already knows (e.g. Jellyfin media segments). */
  known?: (signal: AbortSignal) => Promise<SkipMarkers>;
  /** Mono 8 kHz 16-bit PCM of [start, start + seconds) in media time (less at the end). */
  pcm?: (start: number, seconds: number, signal: AbortSignal) => Promise<Int16Array>;
  /** Resolves when reading the file's last minutes is acceptable. Absent: read them right away. */
  closingReady?: (signal: AbortSignal) => Promise<void>;
}

export interface SkipAnalysis {
  identity: SkipIdentity;
  /** Media duration in seconds; 0 while unknown. */
  duration: () => number;
  memory: SkipMemory;
  adapter: SkipSourceAdapter;
  onMarkers: (markers: SkipMarkers) => void;
  signal: AbortSignal;
  log?: (message: string) => void;
  /** Checked before reading the opening (false: e.g. resumed past it on a slow stream). */
  wantIntro?: () => boolean;
}

/** Seconds at the end that are searched for the end credits. */
export function closingWindow(duration: number): number {
  return Math.min(CLOSING_SECONDS, Math.max(150, duration * 0.3));
}

export function openingWindow(duration: number): number {
  if (!(duration > 0)) return OPENING_MAX_SECONDS;
  return Math.min(OPENING_MAX_SECONDS, duration, Math.max(180, duration * 0.45));
}

function aborted(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("Skip analysis stopped", "AbortError");
}

function knownSignature(list: Signature[], candidate: Signature): boolean {
  return list.some((existing) => {
    const hit = findSignature(existing, { ...candidate, offset: 0 }, { minCoverage: 0.8 });
    return hit !== null && Math.abs(existing.seconds - candidate.seconds) < 6;
  });
}

/** Reads [start, end) chunk by chunk into one fingerprint, calling `step` after each. */
async function fingerprintRange(
  adapter: SkipSourceAdapter,
  start: number,
  end: number,
  signal: AbortSignal,
  step: (print: AudioPrint, readUntil: number) => boolean
): Promise<{ print: AudioPrint; complete: boolean }> {
  const fingerprinter = new Fingerprinter(start);
  let position = start;
  let complete = false;
  while (position < end) {
    aborted(signal);
    const seconds = Math.min(CHUNK_SECONDS, end - position);
    const pcm = await adapter.pcm!(position, seconds, signal);
    aborted(signal);
    fingerprinter.push(pcm);
    position += pcm.length / 8000;
    const short = pcm.length < seconds * 8000 * 0.9;
    if (short) complete = true; // end of the file (or of what can be read)
    if (step(fingerprinter.print(), position) || short) break;
  }
  if (position >= end - 1) complete = true;
  return { print: fingerprinter.print(), complete };
}

export async function analyzeSkipMarkers(job: SkipAnalysis): Promise<SkipMarkers> {
  const { identity, memory, adapter, signal } = job;
  const log = job.log ?? (() => {});
  let shown: SkipMarkers = {};
  let named: SkipMarkers = {};
  let found: SkipMarkers = {};
  const publish = () => {
    const duration = job.duration();
    const merged = mergeMarkers(named, found);
    for (const kind of ["intro", "recap", "credits"] as const) {
      const segment = merged[kind];
      if (segment && !plausibleSegment(kind, segment, duration)) delete merged[kind];
    }
    if (!sameMarkers(merged, shown)) {
      shown = merged;
      job.onMarkers(merged);
    }
  };

  // 1. What the file or server names.
  const [chapters, known] = await Promise.all([
    adapter.chapters?.(signal).catch(() => [] as MediaChapter[]) ?? Promise.resolve([] as MediaChapter[]),
    adapter.known?.(signal).catch(() => ({}) as SkipMarkers) ?? Promise.resolve({} as SkipMarkers),
  ]);
  aborted(signal);
  named = mergeMarkers(markersFromChapters(chapters, job.duration()), known);
  if (chapters.length) log(`chapters: ${chapters.map((chapter) => chapter.title).join(", ")}`);

  // 2. What was found for this file before.
  const cached = memory.markers(identity);
  if (cached) {
    found = Object.fromEntries(
      Object.entries(cached).map(([kind, segment]) => [kind, { ...(segment as SkipSegment), source: "cache" }])
    ) as SkipMarkers;
  }
  publish();

  const season: SeasonMemory = memory.season(identity);
  let seasonChanged = false;
  const save = () => {
    if (seasonChanged) memory.saveSeason(identity, season);
    seasonChanged = false;
    const keep = mergeMarkers(found);
    if (keep.intro || keep.credits || keep.recap) {
      memory.saveMarkers(
        identity,
        Object.fromEntries(
          Object.entries(keep).map(([kind, segment]) => [kind, { ...(segment as SkipSegment), source: "fingerprint" }])
        ) as SkipMarkers
      );
    }
  };

  if (!adapter.pcm) return shown;

  // 3a. The intro, from the opening minutes.
  if (!named.intro && !found.intro && (job.wantIntro?.() ?? true)) {
    const window = openingWindow(job.duration());
    type Candidate = { start: number; end: number; how: string; paired: boolean };
    let learned: { print: AudioPrint; start: number; end: number } | null = null;
    const opening = await fingerprintRange(adapter, 0, window, signal, (print, readUntil) => {
      // Every complete sighting so far: the season's known intros, and the
      // longest stretch shared with each other episode's opening. One sighting
      // may hold only part of the intro (an episode with dialogue over its
      // start, or a shortened one), so overlapping sightings are joined (each
      // part is audio this episode verifiably shares) and the longest wins.
      const candidates: Candidate[] = [];
      for (const signature of season.intro) {
        const hit = findSignature(signature, print, { range: [0, readUntil] });
        if (hit && hit.end < readUntil - 3) {
          candidates.push({ start: hit.start, end: hit.end, how: `season intro, ${Math.round(hit.coverage * 100)}% matched`, paired: false });
        }
      }
      for (const other of season.openings) {
        if (other.episode === identity.episode) continue;
        const match = bestCommonSegment(print, other.print, {
          minSeconds: INTRO_MIN_SECONDS,
          maxSeconds: INTRO_MAX_SECONDS,
          aRange: [0, readUntil],
          bRange: [0, openingWindow(other.duration)],
        });
        if (match && match.a.end < readUntil - 5) {
          candidates.push({
            start: match.a.start,
            end: match.a.end,
            how: `shared with episode ${other.episode}, ${Math.round(match.ratio * 100)}% dense`,
            paired: true,
          });
        }
      }
      const joined: Candidate[] = [];
      for (const candidate of candidates.sort((x, y) => x.start - y.start)) {
        const previous = joined[joined.length - 1];
        if (previous && candidate.start < previous.end - 2) {
          previous.start = Math.min(previous.start, candidate.start);
          previous.end = Math.max(previous.end, candidate.end);
          previous.how = `${previous.how} + ${candidate.how}`;
          previous.paired = previous.paired || candidate.paired;
        } else {
          joined.push({ ...candidate });
        }
      }
      const best = joined
        .filter((candidate) => plausibleSegment("intro", candidate, job.duration()))
        .sort((x, y) => y.end - y.start - (x.end - x.start))[0];
      const current = found.intro;
      const longer = best && (!current || best.end - best.start > current.end - current.start + 1);
      // A longer sighting must overlap the one shown: never jump to another part.
      if (best && longer && (!current || (best.start < current.end && best.end > current.start))) {
        found = { ...found, intro: { start: best.start, end: best.end, source: "fingerprint" } };
        const longestKnown = Math.max(0, ...season.intro.map((signature) => signature.seconds));
        if (best.paired || best.end - best.start > longestKnown + 2) learned = { print, start: best.start, end: best.end };
        log(`intro ${best.start.toFixed(1)}-${best.end.toFixed(1)} s (${best.how})`);
        publish();
      }
      return false;
    });
    if (learned) {
      const { print, start, end } = learned as { print: AudioPrint; start: number; end: number };
      const signature = signatureFromRange(print, start, end);
      if (!knownSignature(season.intro, signature)) {
        season.intro = [...season.intro, signature].slice(-MAX_SIGNATURES);
        seasonChanged = true;
      }
    }
    if (opening.complete && opening.print.hashes.length > 100) {
      season.openings = rememberPrint(season.openings, {
        episode: identity.episode,
        print: opening.print,
        duration: job.duration(),
      });
      seasonChanged = true;
    }
    save();
  }

  // 3b. The end credits, from the last minutes (once the duration is known).
  // Read chunk by chunk like the opening, so "Next episode" can appear as soon
  // as the shared closing audio is seen running up to what has been read.
  if (!named.credits && !found.credits) {
    if (adapter.closingReady) await adapter.closingReady(signal);
    aborted(signal);
    const duration = job.duration();
    if (duration >= 300) {
      const start = duration - closingWindow(duration);
      const acceptCredits = (from: number, how: string) => {
        const segment = { start: from, end: duration };
        if (!plausibleSegment("credits", segment, duration)) return false;
        found = { ...found, credits: { ...segment, source: "fingerprint" } };
        log(`credits from ${from.toFixed(1)} s (${how})`);
        publish();
        return true;
      };
      /** Credits seen in what was read so far. Credits run to the end (give or
       * take a post-credits scene): until the end is read only a stretch still
       * running at the read position counts, and at the end only one that
       * reaches it. A shared cue that stops earlier is not them. */
      const sighting = (print: AudioPrint, readUntil: number, final: boolean) => {
        const reaches = (end: number) => (final ? end >= duration - CREDITS_TAIL_SECONDS : end >= readUntil - 5);
        for (const signature of [...season.credits].reverse()) {
          const hit = findSignature(signature, print, { range: [start, readUntil] });
          if (hit && reaches(hit.end)) {
            return { from: hit.start, how: `season credits, ${Math.round(hit.coverage * 100)}% matched`, match: null };
          }
        }
        for (const other of [...season.closings].reverse()) {
          if (other.episode === identity.episode) continue;
          const match = bestCommonSegment(print, other.print, {
            minSeconds: CREDITS_MIN_SECONDS,
            maxSeconds: CLOSING_SECONDS,
            aRange: [start, readUntil],
            bRange: [other.duration - closingWindow(other.duration), other.duration],
          });
          if (match && reaches(match.a.end)) {
            return { from: match.a.start, how: `shared with episode ${other.episode}`, match };
          }
        }
        return null;
      };
      const closing = await fingerprintRange(adapter, start, duration, signal, (print, readUntil) => {
        if (!found.credits && readUntil < duration - 1) {
          const seen = sighting(print, readUntil, false);
          if (seen) acceptCredits(seen.from, seen.how);
        }
        return false;
      });
      const print = closing.print;
      // The whole closing: the final say (an early sighting that does not hold
      // up is withdrawn), and learn from the full stretch.
      const final = sighting(print, duration, true);
      if (final && (!found.credits || Math.abs(found.credits.start - final.from) > 3)) {
        acceptCredits(final.from, final.how);
      } else if (!final && found.credits && closing.complete) {
        const { credits: _withdrawn, ...rest } = found;
        found = rest;
        log("credits withdrawn: the shared stretch stops before the end");
        publish();
      }
      if (final?.match && found.credits) {
        const signature = signatureFrom(print, final.match.a);
        if (!knownSignature(season.credits, signature)) {
          season.credits = [...season.credits, signature].slice(-MAX_SIGNATURES);
          seasonChanged = true;
        }
      }
      if (closing.complete && print.hashes.length > 100) {
        season.closings = rememberPrint(season.closings, { episode: identity.episode, print, duration });
        seasonChanged = true;
      }
      save();
    }
  }
  return shown;
}
