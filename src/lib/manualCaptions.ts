export interface ManualCaption {
  name: string;
  vtt: string;
  offsetSeconds: number;
  kind?: "generated" | "synced";
  generatedUntil?: number;
}

export interface CaptionCue {
  start: number;
  end: number;
  text: string;
}

const STORAGE_PREFIX = "akflix.manual-caption.";

export function subtitleToVtt(value: string): string {
  const body = value
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(
      /(\d{2}:\d{2}:\d{2}),(\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}),(\d{3})/g,
      "$1.$2 --> $3.$4"
    );
  return body.trimStart().startsWith("WEBVTT") ? body : `WEBVTT\n\n${body}`;
}

function shiftedTimestamp(
  _match: string,
  hours: string | undefined,
  minutes: string,
  seconds: string,
  milliseconds: string,
  offsetSeconds: number
): string {
  const original =
    (Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000 +
    Number(milliseconds);
  const shifted = Math.max(0, original + Math.round(offsetSeconds * 1000));
  const shiftedHours = Math.floor(shifted / 3_600_000);
  const shiftedMinutes = Math.floor((shifted % 3_600_000) / 60_000);
  const shiftedSeconds = Math.floor((shifted % 60_000) / 1000);
  const shiftedMilliseconds = shifted % 1000;
  const prefix = hours !== undefined || shiftedHours > 0
    ? `${String(shiftedHours).padStart(2, "0")}:`
    : "";
  return `${prefix}${String(shiftedMinutes).padStart(2, "0")}:${String(shiftedSeconds).padStart(2, "0")}.${String(shiftedMilliseconds).padStart(3, "0")}`;
}

export function offsetSubtitle(vtt: string, offsetSeconds: number): string {
  if (Math.abs(offsetSeconds) < 0.001) return vtt;
  return vtt.replace(
    /(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{3})/g,
    (match, hours, minutes, seconds, milliseconds) =>
      shiftedTimestamp(match, hours, minutes, seconds, milliseconds, offsetSeconds)
  );
}

function parseTimestamp(value: string): number {
  const parts = value.replace(",", ".").split(":");
  const seconds = Number(parts.pop() ?? 0);
  const minutes = Number(parts.pop() ?? 0);
  const hours = Number(parts.pop() ?? 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function formatTimestamp(seconds: number): string {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const remainingSeconds = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

export function parseVttCues(value: string): CaptionCue[] {
  const lines = subtitleToVtt(value).split("\n");
  const cues: CaptionCue[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const timing = lines[index].match(
      /((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})/
    );
    if (!timing) continue;
    const text: string[] = [];
    while (++index < lines.length && lines[index].trim()) text.push(lines[index]);
    const cleaned = text.join(" ").replace(/<[^>]+>/g, "").trim();
    if (cleaned) {
      cues.push({ start: parseTimestamp(timing[1]), end: parseTimestamp(timing[2]), text: cleaned });
    }
  }
  return cues;
}

export function cuesToVtt(cues: CaptionCue[]): string {
  const unique = new Map<string, CaptionCue>();
  for (const cue of cues) {
    const text = cue.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    unique.set(`${Math.round(cue.start * 10)}:${text.toLowerCase()}`, {
      start: Math.max(0, cue.start),
      end: Math.max(cue.start + 0.4, cue.end),
      text,
    });
  }
  const ordered = [...unique.values()].sort((a, b) => a.start - b.start);
  return `WEBVTT\n\n${ordered
    .map((cue, index) => `${index + 1}\n${formatTimestamp(cue.start)} --> ${formatTimestamp(cue.end)}\n${cue.text}`)
    .join("\n\n")}\n`;
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "he", "her",
  "his", "i", "if", "in", "is", "it", "me", "my", "of", "on", "or", "our", "she", "so",
  "that", "the", "their", "them", "they", "this", "to", "was", "we", "were", "what", "with",
  "you", "your",
]);

function usefulWords(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9' ]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
  );
}

/** Match recognized dialogue to subtitle text and return the required shift. */
export function estimateCaptionOffset(
  subtitleCues: CaptionCue[],
  speechCues: CaptionCue[]
): number | null {
  const matches: Array<{ offset: number; score: number }> = [];
  for (const speech of speechCues) {
    const spoken = usefulWords(speech.text);
    if (spoken.size < 2) continue;
    let best: { offset: number; score: number } | null = null;
    for (let index = 0; index < subtitleCues.length; index += 1) {
      const window = subtitleCues.slice(index, index + 3);
      const written = usefulWords(window.map((cue) => cue.text).join(" "));
      const shared = [...spoken].filter((word) => written.has(word)).length;
      if (shared < 2) continue;
      const score = (2 * shared) / (spoken.size + written.size);
      if (!best || score > best.score) {
        best = { offset: speech.start - window[0].start, score };
      }
    }
    if (best && best.score >= 0.34) matches.push(best);
  }
  if (matches.length < 2) return null;
  const buckets = new Map<number, { weight: number; values: number[] }>();
  for (const match of matches) {
    const bucket = Math.round(match.offset * 2);
    const current = buckets.get(bucket) ?? { weight: 0, values: [] };
    current.weight += match.score;
    current.values.push(match.offset);
    buckets.set(bucket, current);
  }
  const winner = [...buckets.values()].sort((a, b) => b.weight - a.weight)[0];
  if (!winner || winner.values.length < 2) return null;
  const sorted = winner.values.sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return Math.max(-120, Math.min(120, Math.round(median * 10) / 10));
}

export function loadManualCaption(key: string): ManualCaption | null {
  try {
    const value = localStorage.getItem(`${STORAGE_PREFIX}${key}`);
    if (!value) return null;
    const caption = JSON.parse(value) as Partial<ManualCaption>;
    if (!caption.name || !caption.vtt) return null;
    return {
      name: caption.name,
      vtt: subtitleToVtt(caption.vtt),
      offsetSeconds: Number.isFinite(caption.offsetSeconds) ? caption.offsetSeconds! : 0,
      kind: caption.kind,
      generatedUntil: Number.isFinite(caption.generatedUntil) ? caption.generatedUntil : undefined,
    };
  } catch {
    return null;
  }
}

export function saveManualCaption(key: string, caption: ManualCaption) {
  localStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(caption));
}

export function removeManualCaption(key: string) {
  localStorage.removeItem(`${STORAGE_PREFIX}${key}`);
}
