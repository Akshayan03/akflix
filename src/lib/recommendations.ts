import type { StremioMeta } from "@/types/stremio";
import {
  historyMediaKey,
  type PersonalRating,
  type WatchHistoryEntry,
} from "@/stores/historyStore";

function catalogKey(item: StremioMeta): string {
  return `discover:${item.type}:${item.id}`;
}

export function recommendedTitles(
  candidates: StremioMeta[],
  entries: WatchHistoryEntry[],
  ratings: PersonalRating[],
  limit = 24
): StremioMeta[] {
  const genreWeights = new Map<string, number>();
  const typeWeights = new Map<StremioMeta["type"], number>();
  const seen = new Set(entries.map((entry) => historyMediaKey(entry.media)));
  ratings.forEach((rating) => seen.add(historyMediaKey(rating.media)));

  const addSignal = (
    genres: string[] | undefined,
    type: StremioMeta["type"],
    weight: number
  ) => {
    for (const genre of genres ?? []) {
      const normalized = genre.toLowerCase();
      genreWeights.set(normalized, (genreWeights.get(normalized) ?? 0) + weight);
    }
    typeWeights.set(type, (typeWeights.get(type) ?? 0) + Math.max(0, weight) * 0.35);
  };

  for (const entry of entries) {
    addSignal(entry.media.genres, entry.media.type, entry.completed ? 1.4 : 0.65);
  }
  for (const rating of ratings) {
    addSignal(rating.media.genres, rating.media.type, (rating.value - 2.5) * 2.1);
  }

  const unique = new Map<string, StremioMeta>();
  for (const candidate of candidates) unique.set(`${candidate.type}:${candidate.id}`, candidate);

  return [...unique.values()]
    .filter((candidate) => !seen.has(catalogKey(candidate)))
    .map((candidate) => {
      const genreScore = (candidate.genres ?? []).reduce(
        (sum, genre) => sum + (genreWeights.get(genre.toLowerCase()) ?? 0),
        0
      );
      const ratingScore = Number.parseFloat(candidate.imdbRating ?? "0") * 0.35;
      const typeScore = typeWeights.get(candidate.type) ?? 0;
      return { candidate, score: genreScore + ratingScore + typeScore };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}
