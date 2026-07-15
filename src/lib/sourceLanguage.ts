import type { TorrentResult } from "@/types/torrent";

export type SourceLanguage = "english" | "multi" | "unknown" | "non-english";

// Short release tags and flags are much safer than matching the word
// "English", which may simply be part of a title (for example The English).
const ENGLISH = /\beng\b|\benglish[\s._-]*(?:audio|dub)\b|🇬🇧|🇺🇸|🇨🇦/i;
const MULTI = /\b(?:multi(?:lingual)?|dual[\s._-]*audio)\b/i;
const NON_ENGLISH = new RegExp(
  String.raw`\b(?:truefrench|vostfr|fra|fre|ita|ger|deu|castellano|latino|spa|hin|tam|tel|rus|ukr|pol|dut|nld|kor|jpn|chi|zho|ara|tur|por|hun|cze|ces|swe|nor|dan|fin|ell|heb|tha|ind|vie)\b`,
  "i"
);

/** Classify only explicit release language tags; unlabelled releases stay neutral. */
export function classifySourceLanguage(text: string): SourceLanguage {
  const normalized = text.replace(/[._]+/g, " ");
  const hasEnglish = ENGLISH.test(normalized);
  const hasNonEnglish = NON_ENGLISH.test(normalized);
  if (MULTI.test(normalized) || (hasEnglish && hasNonEnglish)) return "multi";
  if (hasEnglish) return "english";
  if (hasNonEnglish) return "non-english";
  return "unknown";
}

export function sourceLanguage(result: TorrentResult): SourceLanguage {
  return (
    result.sourceLanguage ??
    classifySourceLanguage(`${result.title} ${result.category ?? ""} ${result.magnetUrl ?? ""}`)
  );
}

/** Avoid explicitly foreign-only releases whenever any safer candidate exists. */
export function englishSafeSources(results: TorrentResult[]): TorrentResult[] {
  const safe = results.filter((result) => sourceLanguage(result) !== "non-english");
  return safe.length ? safe : results;
}
