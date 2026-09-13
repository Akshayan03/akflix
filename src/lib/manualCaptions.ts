export interface ManualCaption {
  name: string;
  vtt: string;
  offsetSeconds: number;
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
