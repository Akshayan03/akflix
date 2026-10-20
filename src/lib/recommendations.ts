import type { StremioMeta } from "@/types/stremio";
import type { PersonalRating, WatchHistoryEntry } from "@/stores/historyStore";
import {
  FeatureIndex,
  buildProfile,
  collectSeeds,
  createScorer,
  diversify,
  keyOf,
  poolStats,
} from "@/lib/discovery/taste";

/**
 * Titles ranked for one profile from its watches and ratings, unseen ones
 * only. The home screen's rows use the same engine (lib/discovery).
 */
export function recommendedTitles(
  candidates: StremioMeta[],
  entries: WatchHistoryEntry[],
  ratings: PersonalRating[],
  limit = 24
): StremioMeta[] {
  const pool = [...new Map(candidates.map((item) => [keyOf(item), item])).values()];
  const byKey = new Map(pool.map((item) => [keyOf(item), item]));
  const signals = { now: Date.now(), history: entries, ratings, list: [], engagement: [] };
  const seeds = collectSeeds(signals, (key) => byKey.get(key));
  const index = new FeatureIndex(pool);
  const scorer = createScorer(buildProfile(seeds, index), index, poolStats(pool), signals.now);
  const seen = new Set(seeds.map((seed) => seed.key));
  const ranked = pool
    .filter((item) => !seen.has(keyOf(item)))
    .map((item) => ({ item, key: keyOf(item), score: scorer.score(item) }))
    .sort((a, b) => b.score - a.score);
  return diversify(ranked, limit, scorer).map((entry) => entry.item);
}
