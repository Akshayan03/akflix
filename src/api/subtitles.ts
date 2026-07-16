import { httpJson, httpRaw } from "@/lib/http";
import type { StremioMediaType } from "@/types/stremio";

const OPEN_SUBTITLES_URL = "https://opensubtitles-v3.strem.io";

interface SubtitleResource {
  id: string;
  url: string;
  lang: string;
}

interface SubtitleResponse {
  subtitles?: SubtitleResource[];
}

export interface PreparedSubtitle {
  id: string;
  language: string;
  label: string;
  url: string;
}

function languageLabel(language: string): string {
  try {
    const display = new Intl.DisplayNames(["en"], { type: "language" });
    return display.of(language) ?? language.toUpperCase();
  } catch {
    return language.toUpperCase();
  }
}

function srtToVtt(value: string): string {
  const body = value
    .replace(/^\uFEFF/, "")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2 --> $3.$4");
  return body.startsWith("WEBVTT") ? body : `WEBVTT\n\n${body}`;
}

/** Fetch a small, useful caption set and convert SRT responses for native video tracks. */
export async function directSubtitleTracks(
  catalogId: string,
  type: StremioMediaType,
  preferredLanguage: string,
  season?: number,
  episode?: number
): Promise<PreparedSubtitle[]> {
  const videoId =
    type === "series" && season && episode
      ? `${catalogId}:${season}:${episode}`
      : catalogId;
  const response = await httpJson<SubtitleResponse>(
    `${OPEN_SUBTITLES_URL}/subtitles/${type}/${encodeURIComponent(videoId)}.json`
  );
  const ranked = [...(response.subtitles ?? [])]
    .filter((subtitle) => !!subtitle.url)
    .sort((a, b) => {
      const rank = (language: string) =>
        language === preferredLanguage ? 0 : language === "eng" ? 1 : 2;
      return rank(a.lang) - rank(b.lang);
    });

  const perLanguage = new Map<string, number>();
  const selected = ranked.filter((subtitle) => {
    const count = perLanguage.get(subtitle.lang) ?? 0;
    if (count >= 2) return false;
    perLanguage.set(subtitle.lang, count + 1);
    return true;
  }).slice(0, 10);

  const prepared = await Promise.all(
    selected.map(async (subtitle, index) => {
      try {
        const response = await httpRaw(subtitle.url);
        if (!response.ok) return null;
        const vtt = srtToVtt(await response.text());
        return {
          id: subtitle.id,
          language: subtitle.lang,
          label: `${languageLabel(subtitle.lang)}${index ? ` ${index + 1}` : ""}`,
          url: URL.createObjectURL(new Blob([vtt], { type: "text/vtt" })),
        } satisfies PreparedSubtitle;
      } catch {
        return null;
      }
    })
  );
  return prepared.filter((subtitle): subtitle is PreparedSubtitle => !!subtitle);
}
