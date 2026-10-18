/**
 * Skip markers (intro, recap, end credits) and the player decisions built on
 * them: which button to show, when to skip on its own and when "Next episode"
 * appears. Pure functions shared by the Mac and iPhone players.
 */

export type SkipKind = "intro" | "recap" | "credits";
export type MarkerSource = "chapter" | "jellyfin" | "fingerprint" | "cache";

export interface SkipSegment {
  start: number;
  end: number;
  source: MarkerSource;
}

export interface SkipMarkers {
  intro?: SkipSegment;
  recap?: SkipSegment;
  credits?: SkipSegment;
}

export interface MediaChapter {
  title: string;
  start: number;
  /** End of the chapter; the next chapter's start or the file's end if unknown. */
  end?: number;
}

const INTRO_RE = /\b(?:intro|opening(?:\s+(?:credits|titles|theme|song))?|title\s+sequence|main\s+titles|theme\s+song)\b/i;
const RECAP_RE = /\b(?:recap|previously(?:\s+on)?|re-cap|story\s+so\s+far)\b/i;
const CREDITS_RE = /\b(?:(?:end(?:ing)?|closing)\s*credits?|credits?|outro|ending(?:\s+theme|\s+song)?|end\s*titles)\b/i;
/** Anime releases name them "OP" / "ED" (sometimes numbered); only as the whole title. */
const ANIME_OP_RE = /^(?:op|nc\s*op)\s*\d*$/i;
const ANIME_ED_RE = /^(?:ed|nc\s*ed)\s*\d*$/i;
/** Chapters named for content ("Introduction" is the content of a documentary). */
const NOT_A_SEGMENT_RE = /\bintroduction\b|\bchapter\s*\d+\b|^\s*\d+\s*$/i;

/** Which skippable part a chapter's title names, if any. */
export function chapterKind(title: string): SkipKind | null {
  const text = title.trim();
  if (!text || NOT_A_SEGMENT_RE.test(text)) return null;
  if (RECAP_RE.test(text)) return "recap";
  // "Opening credits" is the intro; plain "Credits" are the end credits.
  if (INTRO_RE.test(text) || ANIME_OP_RE.test(text)) return "intro";
  if (CREDITS_RE.test(text) || ANIME_ED_RE.test(text)) return "credits";
  return null;
}

const LIMITS: Record<SkipKind, { min: number; max: number }> = {
  intro: { min: 8, max: 240 },
  recap: { min: 8, max: 600 },
  credits: { min: 10, max: 900 },
};

/** Sanity checks every marker must pass before the player may use it. */
export function plausibleSegment(kind: SkipKind, segment: { start: number; end: number }, duration: number): boolean {
  const { start, end } = segment;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return false;
  const length = end - start;
  const limits = LIMITS[kind];
  if (length < limits.min || length > limits.max) return false;
  if (duration > 0) {
    if (end > duration + 1) return false;
    if (kind === "credits") return start >= duration * 0.5 && start < duration - 1;
    // An intro or recap sits in the first part of an episode.
    return start <= Math.max(duration * 0.5, 60) && length < duration * 0.5;
  }
  return kind !== "credits";
}

export function markersFromChapters(chapters: MediaChapter[], duration: number): SkipMarkers {
  const ordered = [...chapters]
    .filter((chapter) => Number.isFinite(chapter.start))
    .sort((a, b) => a.start - b.start);
  const markers: SkipMarkers = {};
  ordered.forEach((chapter, index) => {
    const kind = chapterKind(chapter.title);
    if (!kind || markers[kind]) return;
    const end = chapter.end && chapter.end > chapter.start
      ? chapter.end
      : ordered[index + 1]?.start ?? (duration > 0 ? duration : NaN);
    const segment = { start: Math.max(0, chapter.start), end };
    if (plausibleSegment(kind, segment, duration)) markers[kind] = { ...segment, source: "chapter" };
  });
  return markers;
}

/** Chapters from ffmpeg's `-f ffmetadata` output (how the Mac reads them). */
export function parseFfmetadataChapters(text: string): MediaChapter[] {
  const chapters: MediaChapter[] = [];
  let current: { timebase: number; start?: number; end?: number; title: string } | null = null;
  const flush = () => {
    if (current && current.start !== undefined) {
      chapters.push({
        title: current.title,
        start: current.start * current.timebase,
        ...(current.end !== undefined ? { end: current.end * current.timebase } : {}),
      });
    }
    current = null;
  };
  // Values escape '=', ';', '#', '\' and newlines with a backslash.
  const lines = text.replace(/\\\r?\n/g, "\u0000").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/\u0000/g, "\n");
    if (line.startsWith("[")) {
      flush();
      if (line.trim().toUpperCase() === "[CHAPTER]") current = { timebase: 1 / 1000, title: "" };
      continue;
    }
    if (!current || line.startsWith(";") || line.startsWith("#")) continue;
    const separator = line.search(/(?<!\\)=/);
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).replace(/\\(.)/g, "$1");
    if (key === "timebase") {
      const [num, den] = value.split("/").map(Number);
      if (num > 0 && den > 0) current.timebase = num / den;
    } else if (key === "start") {
      current.start = Number(value);
    } else if (key === "end") {
      current.end = Number(value);
    } else if (key === "title") {
      current.title = value;
    }
  }
  flush();
  return chapters.filter((chapter) => Number.isFinite(chapter.start));
}

/** A Jellyfin 10.10+ media segment (GET /MediaSegments/{itemId}). */
export interface JellyfinSegment {
  Type?: string;
  StartTicks?: number;
  EndTicks?: number;
}

const JELLYFIN_KINDS: Record<string, SkipKind> = { intro: "intro", recap: "recap", outro: "credits" };

export function markersFromJellyfinSegments(segments: JellyfinSegment[], duration: number): SkipMarkers {
  const markers: SkipMarkers = {};
  for (const segment of segments) {
    const kind = JELLYFIN_KINDS[(segment.Type ?? "").toLowerCase()];
    if (!kind || markers[kind]) continue;
    const range = { start: (segment.StartTicks ?? NaN) / 1e7, end: (segment.EndTicks ?? NaN) / 1e7 };
    // An outro that runs to the end is often reported a little past it.
    if (kind === "credits" && duration > 0) range.end = Math.min(range.end, duration);
    if (plausibleSegment(kind, range, duration)) markers[kind] = { ...range, source: "jellyfin" };
  }
  return markers;
}

/** Earlier sources win per kind (pass them in order of trust). */
export function mergeMarkers(...sets: Array<SkipMarkers | null | undefined>): SkipMarkers {
  const merged: SkipMarkers = {};
  for (const set of sets) {
    if (!set) continue;
    for (const kind of ["intro", "recap", "credits"] as const) {
      if (!merged[kind] && set[kind]) merged[kind] = set[kind];
    }
  }
  return merged;
}

export function sameMarkers(a: SkipMarkers, b: SkipMarkers): boolean {
  return (["intro", "recap", "credits"] as const).every((kind) => {
    const x = a[kind];
    const y = b[kind];
    if (!x || !y) return !x && !y;
    return Math.abs(x.start - y.start) < 0.05 && Math.abs(x.end - y.end) < 0.05 && x.source === y.source;
  });
}

// ── Player decisions ──────────────────────────────────────────────────────

/** The button stops being offered this close to the end of the segment. */
export const SKIP_BUTTON_TAIL = 1.5;
/** Auto-skip only when at least this much of the segment is left. */
export const AUTO_SKIP_MIN_LEFT = 3;
/** Continuous playback advances by less than this between two time updates. */
export const CONTINUOUS_PLAYBACK_STEP = 1.6;
/** Where a skip lands, just before the segment ends: never past the content. */
export const SKIP_LANDING_LEAD = 0.25;

export type SkippableKind = Exclude<SkipKind, "credits">;

export interface SkipButtonView {
  kind: SkippableKind;
  label: string;
  target: number;
  /** 0..1 of the segment already played (drives the button's progress line). */
  progress: number;
  remaining: number;
}

export interface SkipInput {
  markers: SkipMarkers;
  time: number;
  /** Time at the previous update; null after a seek or at the first update. */
  previousTime: number | null;
  duration: number;
  autoSkip: boolean;
  /** Kinds already skipped on their own this playback: never twice. */
  autoSkipped: ReadonlySet<SkippableKind>;
  /** Kinds whose button the viewer dismissed (or used) this playback. */
  dismissed: ReadonlySet<SkippableKind>;
  hasNext: boolean;
  /** The viewer dismissed the credits card for this episode. */
  creditsDismissed: boolean;
}

export interface SkipView {
  button: SkipButtonView | null;
  /** Skip there now on the viewer's behalf. */
  autoSkip: { kind: SkippableKind; target: number } | null;
  /** Offer the next episode (the credits started). */
  nextEpisode: { at: number } | null;
}

export function skipTarget(segment: SkipSegment): number {
  return Math.max(segment.start, segment.end - SKIP_LANDING_LEAD);
}

function activeSegment(markers: SkipMarkers, time: number): [SkippableKind, SkipSegment] | null {
  for (const kind of ["recap", "intro"] as const) {
    const segment = markers[kind];
    if (segment && time >= segment.start && time < segment.end - SKIP_BUTTON_TAIL) return [kind, segment];
  }
  return null;
}

export function skipView(input: SkipInput): SkipView {
  const { markers, time } = input;
  const view: SkipView = { button: null, autoSkip: null, nextEpisode: null };
  const active = activeSegment(markers, time);
  if (active) {
    const [kind, segment] = active;
    const target = skipTarget(segment);
    const continuous =
      input.previousTime !== null &&
      time >= input.previousTime &&
      time - input.previousTime <= CONTINUOUS_PLAYBACK_STEP;
    // Reached by playing into it (not a seek or a resume inside it).
    const playedInto = continuous && input.previousTime! <= segment.start + CONTINUOUS_PLAYBACK_STEP;
    if (
      input.autoSkip &&
      playedInto &&
      !input.autoSkipped.has(kind) &&
      !input.dismissed.has(kind) &&
      segment.end - time >= AUTO_SKIP_MIN_LEFT
    ) {
      view.autoSkip = { kind, target };
    } else if (!input.dismissed.has(kind)) {
      const length = segment.end - segment.start;
      view.button = {
        kind,
        label: kind === "intro" ? "Skip Intro" : "Skip Recap",
        target,
        progress: Math.min(1, Math.max(0, (time - segment.start) / length)),
        remaining: Math.max(0, segment.end - time),
      };
    }
  }
  const credits = markers.credits;
  if (
    credits &&
    input.hasNext &&
    !input.creditsDismissed &&
    time >= credits.start &&
    (input.duration <= 0 || time < input.duration - 0.5)
  ) {
    view.nextEpisode = { at: credits.start };
  }
  return view;
}

/** Media identity that markers are cached under. */
export interface SkipIdentity {
  /** Catalog id (IMDb) or Jellyfin series id. */
  show: string;
  season: number;
  episode: number;
  /** The exact file: offsets differ between releases of one episode. */
  source: string;
}

export function sourceKey(input: string): string {
  // FNV-1a, so URLs (which can hold tokens) are never stored as they are.
  let hash = 0x811c9dc5;
  const text = input.replace(/[?#].*$/, "");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}
