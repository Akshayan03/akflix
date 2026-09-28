import type { StremioMeta } from "@/types/stremio";

const yearOf = (item: StremioMeta) =>
  Number.parseInt(item.year ?? item.releaseInfo?.match(/\d{4}/)?.[0] ?? "", 10) || 0;
const ratingOf = (item: StremioMeta) => Number.parseFloat(item.imdbRating ?? "") || 0;

/** Blend popular, year and genre feeds without burying older highly-rated titles. */
export function balancedCatalog(items: StremioMeta[], limit = 36): StremioMeta[] {
  const unique = [...new Map(items.map((item) => [item.type + ":" + item.id, item])).values()];
  const remaining = unique.map((item, index) => ({ item, index }));
  const decadeCounts = new Map<number, number>();
  const genreCounts = new Map<string, number>();
  const result: StremioMeta[] = [];

  while (remaining.length && result.length < limit) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const { item, index } = remaining[i];
      const year = yearOf(item);
      const decade = year ? Math.floor(year / 10) * 10 : 0;
      const genres = (item.genres ?? []).map((genre) => genre.toLowerCase());
      const base = ratingOf(item) ? ratingOf(item) * 10 : 52 - Math.min(index, 20) * 0.15;
      const decadePenalty = (decadeCounts.get(decade) ?? 0) * 2.8;
      const genrePenalty = genres.reduce((sum, genre) => sum + (genreCounts.get(genre) ?? 0), 0) * 0.35;
      const score = base - decadePenalty - genrePenalty;
      if (score > bestScore) { bestScore = score; bestIndex = i; }
    }
    const [{ item }] = remaining.splice(bestIndex, 1);
    result.push(item);
    const decade = yearOf(item) ? Math.floor(yearOf(item) / 10) * 10 : 0;
    decadeCounts.set(decade, (decadeCounts.get(decade) ?? 0) + 1);
    for (const genre of item.genres ?? []) {
      const key = genre.toLowerCase();
      genreCounts.set(key, (genreCounts.get(key) ?? 0) + 1);
    }
  }
  return result;
}
