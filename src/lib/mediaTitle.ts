export interface MediaDisplayLabel {
  title: string;
  subtitle?: string;
}

const TECHNICAL_MARKER =
  /\b(?:4320p|2160p|1080p|720p|576p|480p|360p|8k|4k|uhd|web[- ]?dl|webrip|web|bluray|blu[- ]?ray|b[dr]rip|remux|hdrip|dvdrip|hdtv|hdcam|camrip|cam|telesync|xvid|x26[45]|h[ .]?26[45]|hevc|av1|aac(?:2|5|7)?(?:[ .]?1)?|ac3|eac3|ddp?(?:[ .]?5[ .]?1)?|dts(?:[- ]?hd)?|truehd|atmos|hdr10\+?|hdr|dovi|dolby[ -]?vision|multi(?:sub)?|proper|repack|extended|unrated)\b/i;

const RELEASE_YEAR =
  /\b(?:19|20)\d{2}\b(?=\s+(?:4320p|2160p|1080p|720p|576p|480p|360p|8k|4k|uhd|web[- ]?dl|webrip|web|bluray|blu[- ]?ray|b[dr]rip|remux|hdrip|dvdrip|hdtv|hdcam|camrip|cam|xvid|x26[45]|h[ .]?26[45]|hevc|av1)\b)/i;

const SMALL_WORDS = new Set(["a", "an", "and", "at", "for", "from", "in", "of", "on", "or", "the", "to", "with"]);
const ACRONYMS = new Set(["DC", "FBI", "NCIS", "NYC", "TV", "UK", "US"]);

function displayCase(value: string): string {
  const letters = value.replace(/[^a-z]/gi, "");
  if (!letters || (letters !== letters.toLowerCase() && letters !== letters.toUpperCase())) {
    return value;
  }
  return value
    .toLowerCase()
    .split(" ")
    .map((word, index) => {
      if (!word || (index > 0 && SMALL_WORDS.has(word))) return word;
      if (ACRONYMS.has(word.toUpperCase())) return word.toUpperCase();
      return word.replace(/[a-z]/, (letter) => letter.toUpperCase());
    })
    .join(" ");
}

function cleanWords(value: string): string {
  return displayCase(
    value
      .replace(/\[[^\]]*]/g, " ")
      .replace(/[.[\]{}()]/g, " ")
      .replace(/_/g, " ")
      .replace(/\s+-\s+[a-z\d]+(?:\s+[a-z\d]+)?$/i, " ")
      .replace(/\s+/g, " ")
      .replace(/^[\s-]+|[\s-]+$/g, "")
      .trim()
  );
}

function titleBeforeTechnicalDetails(value: string): string {
  const year = RELEASE_YEAR.exec(value);
  const technical = TECHNICAL_MARKER.exec(value);
  const cutAt = [year?.index, technical?.index]
    .filter((index): index is number => index !== undefined)
    .sort((a, b) => a - b)[0];
  return cleanWords(cutAt === undefined ? value : value.slice(0, cutAt));
}

/**
 * Turn a release filename into a catalog-style player label.
 *
 * Examples:
 *   The.Batman.2022.1080p.WEBRip.x264.mkv -> The Batman
 *   Silo.S02E03.Solo.1080p.WEB-DL.mkv -> Silo / S2 E3 · Solo
 */
export function mediaDisplayFromRelease(value: string): MediaDisplayLabel {
  const basename = value.split(/[\\/]/).pop()?.trim() ?? "";
  const hasMediaExtension = /\.(?:mkv|mp4|m4v|mov|webm|avi|ts)$/i.test(basename);
  const normalized = basename
    .replace(/\.(?:mkv|mp4|m4v|mov|webm|avi|ts)$/i, "")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return { title: "Akflix stream" };

  const episodeMatch =
    /\bS(\d{1,2})\s*E(\d{1,3})(?:\s*E\d{1,3})?\b/i.exec(normalized) ??
    /\b(\d{1,2})x(\d{1,3})\b/i.exec(normalized);
  if (episodeMatch) {
    const season = Number(episodeMatch[1]);
    const episode = Number(episodeMatch[2]);
    const seriesTitle =
      titleBeforeTechnicalDetails(normalized.slice(0, episodeMatch.index)) || "Series";
    const afterEpisode = normalized.slice(episodeMatch.index + episodeMatch[0].length);
    const episodeTitle = titleBeforeTechnicalDetails(afterEpisode);
    return {
      title: seriesTitle,
      subtitle: `S${season} E${episode}${episodeTitle ? ` · ${episodeTitle}` : ""}`,
    };
  }

  // Catalog titles are already presentation-ready. Preserve their punctuation
  // instead of treating periods in names such as "S.W.A.T." as separators.
  if (!hasMediaExtension && !RELEASE_YEAR.test(normalized) && !TECHNICAL_MARKER.test(normalized)) {
    return { title: basename };
  }

  return {
    title: titleBeforeTechnicalDetails(normalized) || cleanWords(normalized) || "Akflix stream",
  };
}
