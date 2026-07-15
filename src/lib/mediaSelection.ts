import type { QbtFile } from "@/types/torrent";

const VIDEO_FILE = /\.(mp4|m4v|mkv|webm|avi|mov|ts|m2ts)$/i;

export interface EpisodeFileHint {
  preferredIndex?: number;
  season?: number;
  episode?: number;
}

interface EpisodeCoordinates {
  season?: number;
  episode?: number;
  explicitPair: boolean;
}

function episodeCoordinates(filename: string): EpisodeCoordinates {
  const normalized = filename.replace(/\\/g, "/");
  const pairPatterns = [
    /(?:^|[^a-z\d])s0*(\d{1,2})[\s._-]*e0*(\d{1,3})(?!\d)/i,
    /(?:^|[^\d])0*(\d{1,2})x0*(\d{1,3})(?!\d)/i,
    /season[\s._-]*0*(\d{1,2}).{0,24}?episode[\s._-]*0*(\d{1,3})(?!\d)/i,
  ];
  for (const pattern of pairPatterns) {
    const match = normalized.match(pattern);
    if (match) {
      return { season: Number(match[1]), episode: Number(match[2]), explicitPair: true };
    }
  }

  const season = normalized.match(/(?:^|[/\s._-])season[\s._-]*0*(\d{1,2})(?:[/\s._-]|$)/i)?.[1];
  const episode = normalized.match(
    /(?:^|[/\s._-])(?:episode|ep|e)[\s._-]*0*(\d{1,3})(?!\d)/i
  )?.[1];
  return {
    season: season ? Number(season) : undefined,
    episode: episode ? Number(episode) : undefined,
    explicitPair: false,
  };
}

function episodeScore(filename: string, season: number, episode: number): number {
  const found = episodeCoordinates(filename);
  if (found.explicitPair) {
    return found.season === season && found.episode === episode ? 1_000 : -1_000;
  }
  if (found.episode !== undefined) {
    if (found.episode !== episode) return -600;
    if (found.season !== undefined && found.season !== season) return -600;
    return found.season === season ? 800 : 500;
  }
  return 0;
}

/**
 * Select the requested episode from a season pack. Torrentio's fileIdx remains
 * useful, but a filename that clearly identifies another episode is never
 * allowed to override an exact S/E filename match.
 */
export function selectVideoFile(files: QbtFile[], hint: EpisodeFileHint = {}): QbtFile | null {
  if (!files.length) return null;
  const videos = files.filter((file) => VIDEO_FILE.test(file.name));
  const playable = videos.length ? videos : files;
  const preferred = playable.find((file) => file.index === hint.preferredIndex);

  if (hint.season !== undefined && hint.episode !== undefined) {
    const scored = playable.map((file) => ({
      file,
      score: episodeScore(file.name, hint.season!, hint.episode!),
    }));
    const exact = scored
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => {
        const byScore = b.score - a.score;
        if (byScore) return byScore;
        if (a.file.index === hint.preferredIndex) return -1;
        if (b.file.index === hint.preferredIndex) return 1;
        return b.file.size - a.file.size;
      })[0]?.file;
    if (exact) return exact;

    // Trust Torrentio's file index when it is playable and its filename does
    // not explicitly contradict the episode the user clicked.
    if (preferred && episodeScore(preferred.name, hint.season, hint.episode) >= 0) {
      return preferred;
    }

    const unlabelled = scored
      .filter((candidate) => candidate.score === 0)
      .sort((a, b) => b.file.size - a.file.size)[0]?.file;
    if (unlabelled) return unlabelled;
  }

  return preferred ?? [...playable].sort((a, b) => b.size - a.size)[0] ?? null;
}
