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

const PREFERRED_LANGUAGE_TAGS: Record<string, RegExp> = {
  eng: /\beng\b|\benglish[\s._-]*(?:audio|dub)\b|🇬🇧|🇺🇸|🇨🇦/i,
  spa: /\b(?:spa|spanish|castellano|latino)[\s._-]*(?:audio|dub)?\b|🇪🇸|🇲🇽/i,
  fra: /\b(?:fra|fre|french|truefrench)[\s._-]*(?:audio|dub)?\b|🇫🇷/i,
  deu: /\b(?:deu|ger|german)[\s._-]*(?:audio|dub)?\b|🇩🇪/i,
  ita: /\b(?:ita|italian)[\s._-]*(?:audio|dub)?\b|🇮🇹/i,
  por: /\b(?:por|portuguese|brazilian)[\s._-]*(?:audio|dub)?\b|🇵🇹|🇧🇷/i,
  hin: /\b(?:hin|hindi)[\s._-]*(?:audio|dub)?\b|🇮🇳/i,
  jpn: /\b(?:jpn|japanese)[\s._-]*(?:audio|dub)?\b|🇯🇵/i,
  kor: /\b(?:kor|korean)[\s._-]*(?:audio|dub)?\b|🇰🇷/i,
  zho: /\b(?:zho|chi|chinese|mandarin|cantonese)[\s._-]*(?:audio|dub)?\b|🇨🇳|🇭🇰/i,
  rus: /\b(?:rus|russian)[\s._-]*(?:audio|dub)?\b|🇷🇺/i,
};

function sourceText(result: TorrentResult): string {
  let magnet = result.magnetUrl ?? "";
  try {
    magnet = decodeURIComponent(magnet);
  } catch {
    // The visible provider metadata is still enough for classification.
  }
  return `${result.category ?? ""} ${result.title} ${magnet}`.replace(/[._]+/g, " ");
}

export function matchesPreferredAudio(result: TorrentResult, preferredLanguage: string): boolean {
  const preferred = preferredLanguage.trim().toLowerCase();
  if (!preferred || preferred === "und" || preferred === "any") return true;
  if (preferred === "eng") return sourceLanguage(result) === "english";
  return PREFERRED_LANGUAGE_TAGS[preferred]?.test(sourceText(result)) ?? false;
}

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

const LOW_GRADE_RELEASE =
  /\b(?:cam|hdcam|camrip|telesync|tsrip|hdts|screener|telecine)\b/i;

/**
 * Conservative pool for Watch now. Manual source selection intentionally
 * keeps every result, but the automatic path should not choose theatre
 * captures with embedded ads or an explicitly foreign-only audio track when
 * a normal release is available.
 */
export function automaticSafeSources(
  results: TorrentResult[],
  preferredLanguage = "eng"
): TorrentResult[] {
  const clean = results.filter((result) => {
    const text = `${result.title} ${result.category ?? ""}`;
    return !LOW_GRADE_RELEASE.test(text.replace(/[._-]+/g, " "));
  });
  const pool = clean.length ? clean : results;

  // Most English releases do not declare their language. Keep those neutral
  // sources eligible instead of forcing Watch now onto a huge 4K season pack
  // merely because it happens to contain an explicit "English" tag.
  if (preferredLanguage.trim().toLowerCase() === "eng") {
    const likelyEnglish = pool.filter((result) => {
      const language = sourceLanguage(result);
      return language === "english" || language === "unknown";
    });
    if (likelyEnglish.length) return likelyEnglish;
  }

  // For explicitly selected non-English audio, confirmed matches remain the
  // safest automatic choice. Manual source selection still exposes everything.
  const preferred = pool.filter((result) => matchesPreferredAudio(result, preferredLanguage));
  if (preferred.length && !["", "und", "any"].includes(preferredLanguage.trim().toLowerCase())) {
    return preferred;
  }

  // If no confirmed match exists, prefer neutral releases, then multilingual
  // ones, and use an explicitly conflicting release only as a last resort.
  const neutral = pool.filter((result) => sourceLanguage(result) === "unknown");
  if (neutral.length) return neutral;
  const multilingual = pool.filter((result) => sourceLanguage(result) === "multi");
  if (multilingual.length) return multilingual;

  const fallbackPool = preferredLanguage.trim().toLowerCase() === "eng" ? englishSafeSources(pool) : pool;
  const priority: Record<SourceLanguage, number> = {
    english: 0,
    unknown: 1,
    multi: 2,
    "non-english": 3,
  };
  return [...fallbackPool].sort(
    (a, b) => priority[sourceLanguage(a)] - priority[sourceLanguage(b)]
  );
}
