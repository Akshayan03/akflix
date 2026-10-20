/**
 * On-device recommendations: a taste profile built from what this profile
 * rated, finished, binged, rewatched, saved and gave up on, then
 * content-based scoring of catalogue titles against it. Pure functions only,
 * shared verbatim by the Mac and iPhone apps and covered by
 * tests/discovery.test.ts.
 *
 * Signals (strongest first): explicit 1-5 ratings; finishing a film or a
 * series and how far into a series someone got; rewatches and binge
 * sessions; adding to My List. Ratings of 1-2 and titles abandoned early
 * count against similar titles. Older signals fade but never vanish.
 *
 * Title features: genres, cast, director, writer/creator, release decade,
 * country, description keywords (TF-IDF), IMDb rating and popularity, all
 * from Cinemeta's free catalogue.
 */
import type { StremioMeta } from "@/types/stremio";
import type { HistoryTitle, PersonalRating, WatchHistoryEntry } from "@/stores/historyStore";
import type { SavedTitle } from "@/stores/listStore";
import type { EngagementStats } from "@/lib/discovery/engagement";
import { DAY, releasedAt } from "@/lib/discovery/dates";
import { genrePhrase, genreRowName, hasPairName, normalizeGenre } from "@/lib/discovery/genres";

export const keyOf = (item: { type: string; id: string }) => `${item.type}:${item.id}`;

// ------------------------------------------------------------------ signals

export interface Signals {
  now: number;
  /** This profile's history (catalogue and Jellyfin rows). */
  history: WatchHistoryEntry[];
  ratings: PersonalRating[];
  /** This profile's My List rows, including removal markers. */
  list: SavedTitle[];
  engagement: (EngagementStats & { media: HistoryTitle })[];
}

export interface Seed {
  key: string;
  type: "movie" | "series";
  id: string;
  name: string;
  /** Catalogue metadata when known (people, keywords), else the history copy. */
  item: StremioMeta;
  /** Signed strength of the preference after fading with age. */
  weight: number;
  rating?: number;
  liked: boolean;
  disliked: boolean;
  abandoned: boolean;
  /** A finished film (now or before a rewatch) or a series marked finished. */
  finished: boolean;
  /** Any real viewing of the title. */
  watched: boolean;
  saved: boolean;
  /** Most recent signal, epoch ms. */
  at: number;
  entry?: WatchHistoryEntry;
  engagement?: EngagementStats;
  /** Only Akflix catalogue titles can anchor a row; Jellyfin rows only shape the profile. */
  catalog: boolean;
}

const RATING_WEIGHT: Record<number, number> = { 1: -3.2, 2: -2.2, 3: 0.3, 4: 2, 5: 3.2 };

/** Weight that fades from 1 toward `floor` with the given half-life. */
const fade = (ageDays: number, halfLife: number, floor = 0.3) =>
  floor + (1 - floor) * Math.pow(0.5, Math.max(0, ageDays) / halfLife);

export function metaFromHistory(media: HistoryTitle): StremioMeta {
  return {
    id: media.id,
    type: media.type,
    name: media.name,
    poster: media.poster ?? undefined,
    background: media.background ?? undefined,
    description: media.description,
    releaseInfo: media.releaseInfo,
    year: media.year,
    imdbRating: media.imdbRating,
    genres: media.genres,
  };
}

function watchWeight(entry: WatchHistoryEntry, engagement: EngagementStats | undefined, now: number) {
  const stale = (now - entry.updatedAt) / DAY;
  const finishedBefore = (engagement?.plays ?? 0) > 0;
  if (entry.media.type === "movie") {
    if (entry.completed || finishedBefore) return { weight: 1.3, abandoned: false };
    if (entry.progress >= 70) return { weight: 0.9, abandoned: false };
    if (entry.progress >= 35) return { weight: 0.45, abandoned: false };
    if (stale >= 14) return { weight: -0.9, abandoned: true };
    return { weight: 0.15, abandoned: false };
  }
  if (entry.completed) return { weight: 1.7, abandoned: false };
  const season = entry.season ?? 1;
  const episode = entry.episode ?? 1;
  if (season === 1 && episode <= 2 && entry.progress < 60 && stale >= 21 && !finishedBefore) {
    return { weight: -0.7, abandoned: true };
  }
  const depth = (season - 1) * 8 + episode;
  return { weight: Math.min(1.8, 0.35 + 0.16 * depth), abandoned: false };
}

/** One seed per title this profile has any signal for. */
export function collectSeeds(signals: Signals, known?: (key: string) => StremioMeta | undefined): Seed[] {
  const { now } = signals;
  const byKey = new Map<string, { media: HistoryTitle; entry?: WatchHistoryEntry; rating?: PersonalRating; saved?: SavedTitle; engagement?: EngagementStats }>();
  const slot = (media: HistoryTitle) => {
    const key = media.source === "discover" ? keyOf(media) : `jellyfin:${media.type}:${media.id}`;
    let row = byKey.get(key);
    if (!row) byKey.set(key, (row = { media }));
    return row;
  };
  for (const entry of signals.history) slot(entry.media).entry = entry;
  for (const rating of signals.ratings) slot(rating.media).rating = rating;
  for (const saved of signals.list) if (saved.saved) slot(saved.media).saved = saved;
  for (const row of signals.engagement) if (row.media.source === "discover") slot(row.media).engagement = row;

  const seeds: Seed[] = [];
  for (const [key, row] of byKey) {
    const { media, entry, rating, saved, engagement } = row;
    const catalog = media.source === "discover";
    const watch = entry ? watchWeight(entry, engagement, now) : null;
    const engaged = engagement
      ? Math.min(1.2, 0.6 * engagement.rewatches) + Math.min(1.5, 0.5 * engagement.binges) + (media.type === "movie" && engagement.plays >= 2 ? 0.4 : 0)
      : 0;
    const watchAt = Math.max(entry?.updatedAt ?? 0, engagement?.lastFinishedAt ?? 0);
    const watchPart = watch ? watch.weight * fade((now - watchAt) / DAY, 120) : 0;
    const listPart = saved ? (entry ? 0.3 : 0.8) * fade((now - saved.at) / DAY, 180) : 0;
    let weight: number;
    if (rating) {
      const value = Math.max(1, Math.min(5, Math.round(rating.value)));
      weight = RATING_WEIGHT[value] * fade((now - rating.updatedAt) / DAY, 540, 0.55)
        + 0.35 * Math.max(0, watchPart)
        + (value >= 3 ? engaged + listPart : 0);
    } else {
      weight = watchPart + engaged + listPart;
    }
    if (!catalog) weight *= 0.6;
    const value = rating ? Math.round(rating.value) : undefined;
    seeds.push({
      key,
      type: media.type,
      id: media.id,
      name: media.name,
      item: (catalog ? known?.(key) : undefined) ?? metaFromHistory(media),
      weight,
      rating: value,
      liked: value !== undefined && value >= 4,
      disliked: value !== undefined && value <= 2,
      abandoned: !value && !!watch?.abandoned,
      finished: !!entry?.completed || (media.type === "movie" && (engagement?.plays ?? 0) > 0),
      watched: !!entry && (entry.progress > 0 || entry.completed || !!entry.season),
      saved: !!saved,
      at: Math.max(entry?.updatedAt ?? 0, rating?.updatedAt ?? 0, saved?.at ?? 0, engagement?.at ?? 0),
      entry,
      engagement,
      catalog,
    });
  }
  return seeds.sort((a, b) => b.weight - a.weight || b.at - a.at);
}

// ----------------------------------------------------------------- features

export interface Features {
  genres: string[];
  /** Person → how central they are to the title (director 1, lead 0.8 …). */
  people: Map<string, number>;
  creators: Set<string>;
  decade: number | null;
  countries: string[];
  /** Unit-length TF-IDF vector of description keywords. */
  terms: Map<string, number>;
  rating: number;
  releasedAt: number | null;
}

const STOP = new Set(
  ("a about after again against all also among an and another any are around as at away back be been before being " +
    "between both but by can cannot come comes could did do does doing down during each even ever every few find finds " +
    "first for from further get gets getting give go goes going had has have having he her here hers herself him " +
    "himself his how however if in into is it its itself just know last later life like lives made make makes man " +
    "many may more most much must my new no nor not now of off on once one only or other others our out over own " +
    "part people place set she should since so some soon still story such take takes than that the their them " +
    "themselves then there these they things this those though through time to together too two under until up upon " +
    "us very was way we well were what when where which while who whom whose why will with within without woman " +
    "world would year years yet you young your film movie series season episode tells follows becomes begins must " +
    "after while when where their them they three four help helps finds trying tries named called comes young old " +
    "years new life world family friends friend love").split(" ")
);

export function descriptionTerms(text: string | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  if (!text) return counts;
  for (const raw of text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^a-z]+/)) {
    if (raw.length < 4 || STOP.has(raw)) continue;
    const word = raw.length > 5 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw;
    if (STOP.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
}

const yearOf = (item: StremioMeta) =>
  Number.parseInt(item.year ?? item.releaseInfo?.match(/\d{4}/)?.[0] ?? "", 10) || 0;

export class FeatureIndex {
  private idf = new Map<string, number>();
  private docs = 1;
  private cache = new Map<string, Features>();

  constructor(corpus: StremioMeta[]) {
    const df = new Map<string, number>();
    const seen = new Set<string>();
    for (const item of corpus) {
      const key = keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      for (const term of descriptionTerms(item.description).keys()) df.set(term, (df.get(term) ?? 0) + 1);
    }
    this.docs = Math.max(1, seen.size);
    for (const [term, count] of df) this.idf.set(term, Math.log((this.docs + 1) / (count + 1)) + 1);
  }

  of(item: StremioMeta): Features {
    const key = keyOf(item);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const people = new Map<string, number>();
    const creators = new Set<string>();
    const add = (name: string | undefined, weight: number, creator = false) => {
      const person = name?.trim();
      if (!person) return;
      people.set(person, Math.max(people.get(person) ?? 0, weight));
      if (creator) creators.add(person);
    };
    for (const name of (item.director ?? []).slice(0, 3)) add(name, 1, true);
    for (const name of (item.writer ?? []).slice(0, 3)) add(name, 0.9, true);
    (item.cast ?? []).slice(0, 6).forEach((name, index) => add(name, index < 3 ? 0.8 - index * 0.1 : 0.35));
    const terms = new Map<string, number>();
    let norm = 0;
    for (const [term, count] of descriptionTerms(item.description)) {
      const weight = (1 + Math.log(count)) * (this.idf.get(term) ?? Math.log(this.docs + 1) + 1);
      terms.set(term, weight);
      norm += weight * weight;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [term, weight] of terms) terms.set(term, weight / norm);
    const year = yearOf(item);
    const features: Features = {
      genres: [...new Set((item.genres ?? []).map(normalizeGenre).filter(Boolean))],
      people,
      creators,
      decade: year ? Math.floor(year / 10) * 10 : null,
      countries: (item.country ?? "").split(",").map((country) => country.trim()).filter(Boolean),
      terms,
      rating: Number.parseFloat(item.imdbRating ?? "") || 0,
      releasedAt: releasedAt(item),
    };
    this.cache.set(key, features);
    return features;
  }
}

function cosine(a: Map<string, number>, b: Map<string, number>) {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let sum = 0;
  for (const [term, weight] of small) sum += weight * (large.get(term) ?? 0);
  return Math.max(0, Math.min(1, sum));
}

/** Content similarity of two titles in [0, 1]. */
export function similarity(a: Features, b: Features, sameType: boolean): number {
  let shared = 0;
  for (const genre of a.genres) if (b.genres.includes(genre)) shared += 1;
  const union = a.genres.length + b.genres.length - shared;
  const genres = union ? shared / union : 0;
  let people = 0;
  for (const [name, weight] of a.people) {
    const other = b.people.get(name);
    if (other) people += Math.min(weight, other);
  }
  const decade = a.decade && b.decade ? (a.decade === b.decade ? 1 : Math.abs(a.decade - b.decade) === 10 ? 0.5 : 0) : 0;
  const country = a.countries.some((value) => b.countries.includes(value)) ? 1 : 0;
  return (
    0.42 * genres +
    0.26 * Math.min(1, people) +
    0.16 * cosine(a.terms, b.terms) +
    0.06 * decade +
    0.06 * country +
    0.04 * (sameType ? 1 : 0)
  );
}

// ------------------------------------------------------------------ profile

export interface TasteProfile {
  genres: Map<string, number>;
  people: Map<string, number>;
  decades: Map<number, number>;
  countries: Map<string, number>;
  types: Record<"movie" | "series", number>;
  terms: Map<string, number>;
  /** Total positive signal; under COLD_START the home falls back to trending and top rated. */
  strength: number;
  seeds: Seed[];
  positives: Seed[];
  negatives: Seed[];
}

export const COLD_START = 1;

function normalizeMap<K>(map: Map<K, number>, floor = 0.04) {
  const max = Math.max(0, ...[...map.values()].map(Math.abs));
  const out = new Map<K, number>();
  if (!max) return out;
  for (const [key, value] of map) {
    const scaled = value / max;
    if (Math.abs(scaled) >= floor) out.set(key, Math.max(-1, Math.min(1, scaled)));
  }
  return out;
}

export function buildProfile(seeds: Seed[], index: FeatureIndex): TasteProfile {
  const genres = new Map<string, number>();
  const people = new Map<string, number>();
  const decades = new Map<number, number>();
  const countries = new Map<string, number>();
  const terms = new Map<string, number>();
  const types = { movie: 0, series: 0 };
  let strength = 0;
  for (const seed of seeds) {
    if (Math.abs(seed.weight) < 0.05) continue;
    const features = index.of(seed.item);
    const w = seed.weight;
    const perGenre = w / Math.sqrt(Math.max(1, features.genres.length));
    for (const genre of features.genres) genres.set(genre, (genres.get(genre) ?? 0) + perGenre);
    for (const [name, role] of features.people) people.set(name, (people.get(name) ?? 0) + w * role);
    if (w > 0) {
      strength += w;
      types[seed.type] += w;
      if (features.decade) decades.set(features.decade, (decades.get(features.decade) ?? 0) + w);
      for (const country of features.countries) countries.set(country, (countries.get(country) ?? 0) + w);
      for (const [term, value] of features.terms) terms.set(term, (terms.get(term) ?? 0) + w * value);
    }
  }
  let norm = 0;
  for (const value of terms.values()) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (const [term, value] of terms) terms.set(term, value / norm);
  const total = types.movie + types.series || 1;
  return {
    genres: normalizeMap(genres),
    people: normalizeMap(people, 0.08),
    decades: normalizeMap(decades),
    countries: normalizeMap(countries),
    types: { movie: types.movie / total, series: types.series / total },
    terms,
    strength,
    seeds,
    positives: seeds.filter((seed) => seed.weight >= 0.4),
    negatives: seeds.filter((seed) => seed.weight <= -0.4),
  };
}

// ------------------------------------------------------------------ scoring

export interface PoolStats {
  /** Percentile of Cinemeta's current popularity (Stremio activity) in the pool. */
  buzz: (item: StremioMeta) => number;
  /**
   * Percentile of TMDB popularity (Trakt when TMDB is missing): how
   * mainstream a title is. Cinemeta has no vote counts; titles with no
   * popularity data at all score 0.
   */
  fame: (item: StremioMeta) => number;
}

function percentiles(values: number[]) {
  const sorted = [...values].filter((value) => value > 0).sort((a, b) => a - b);
  return (value: number) => {
    if (!(value > 0) || !sorted.length) return 0;
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (sorted[mid] < value) low = mid + 1;
      else high = mid;
    }
    return sorted.length === 1 ? 1 : low / (sorted.length - 1);
  };
}

export function poolStats(pool: StremioMeta[]): PoolStats {
  const buzz = percentiles(pool.map((item) => item.popularity ?? 0));
  const fameTmdb = percentiles(pool.map((item) => item.popularities?.moviedb ?? 0));
  const fameTrakt = percentiles(pool.map((item) => item.popularities?.trakt ?? 0));
  return {
    buzz: (item) => buzz(item.popularity ?? 0),
    fame: (item) => (item.popularities?.moviedb ? fameTmdb(item.popularities.moviedb) : fameTrakt(item.popularities?.trakt ?? 0)),
  };
}

export interface Scored {
  item: StremioMeta;
  key: string;
  score: number;
  /** Why it is recommended, in plain words. */
  reason?: string;
}

export interface Scorer {
  profile: TasteProfile;
  index: FeatureIndex;
  stats: PoolStats;
  now: number;
  coldStart: boolean;
  score: (item: StremioMeta) => number;
  similarity: (a: StremioMeta, b: StremioMeta) => number;
  explain: (item: StremioMeta) => string | undefined;
}

export function createScorer(profile: TasteProfile, index: FeatureIndex, stats: PoolStats, now: number): Scorer {
  const coldStart = profile.strength < COLD_START;
  const negatives = profile.negatives.filter((seed) => seed.catalog);
  const positives = profile.positives.filter((seed) => seed.catalog).slice(0, 40);
  const scores = new Map<string, number>();
  const sim = (a: StremioMeta, b: StremioMeta) => similarity(index.of(a), index.of(b), a.type === b.type);

  const quality = (features: Features) => (features.rating ? Math.max(-1, Math.min(1, (features.rating - 6.6) / 1.6)) : -0.15);
  const freshness = (features: Features) => {
    if (features.releasedAt === null || features.releasedAt > now) return 0;
    const age = (now - features.releasedAt) / DAY;
    return age <= 180 ? 1 - age / 180 : 0;
  };

  const score = (item: StremioMeta) => {
    const key = keyOf(item);
    const cached = scores.get(key);
    if (cached !== undefined) return cached;
    const f = index.of(item);
    const buzz = stats.buzz(item);
    let value: number;
    if (coldStart) {
      value = 1.0 * quality(f) + 0.8 * buzz + 0.3 * freshness(f);
    } else {
      let genre = 0;
      for (const g of f.genres) genre += profile.genres.get(g) ?? 0;
      genre /= Math.sqrt(Math.max(1, f.genres.length));
      let people = 0;
      for (const [name, role] of f.people) people += (profile.people.get(name) ?? 0) * role;
      const decade = f.decade ? profile.decades.get(f.decade) ?? 0 : 0;
      const country = Math.max(0, ...f.countries.map((c) => profile.countries.get(c) ?? 0));
      const terms = cosine(profile.terms, f.terms);
      const type = profile.types[item.type] - 0.5;
      let negative = 0;
      for (const seed of negatives) {
        if (seed.key === key) continue;
        negative = Math.max(negative, sim(item, seed.item) * Math.min(1, Math.abs(seed.weight) / 3));
      }
      value =
        1.5 * Math.max(-1.5, Math.min(1.5, genre)) +
        1.1 * Math.max(-1, Math.min(1.2, people)) +
        0.35 * decade +
        0.25 * country +
        0.9 * terms +
        0.5 * type +
        0.8 * quality(f) +
        0.35 * buzz +
        0.25 * freshness(f) -
        1.6 * negative;
    }
    scores.set(key, value);
    return value;
  };

  const explain = (item: StremioMeta) => {
    if (coldStart) return undefined;
    const key = keyOf(item);
    let best: Seed | null = null;
    let bestValue = 0;
    let bestSim = 0;
    for (const seed of positives) {
      if (seed.key === key) continue;
      const s = sim(item, seed.item);
      const value = s * seed.weight;
      if (value > bestValue) { best = seed; bestValue = value; bestSim = s; }
    }
    if (best && bestSim >= 0.3) {
      if (best.liked) return `Because you liked ${best.name}`;
      if (best.watched) return `Because you watched ${best.name}`;
      return `Like ${best.name} on your list`;
    }
    const f = index.of(item);
    let person: string | null = null;
    let personValue = 0;
    for (const [name, role] of f.people) {
      const value = (profile.people.get(name) ?? 0) * role;
      if (value > personValue) { person = name; personValue = value; }
    }
    if (person && personValue >= 0.45) return f.creators.has(person) ? `From ${person}` : `With ${person}`;
    // A named pair both liked ("crime dramas") says more than one genre.
    let pair: string[] | null = null;
    let pairValue = 0;
    for (let i = 0; i < f.genres.length; i += 1) {
      for (let j = i + 1; j < f.genres.length; j += 1) {
        const value = Math.min(profile.genres.get(f.genres[i]) ?? 0, profile.genres.get(f.genres[j]) ?? 0);
        if (value >= 0.3 && value > pairValue && hasPairName(f.genres[i], f.genres[j])) { pair = [f.genres[i], f.genres[j]]; pairValue = value; }
      }
    }
    if (pair) return `Because you like ${genreRowName(pair).toLowerCase()}`;
    let genre: string | null = null;
    let genreValue = 0;
    for (const g of f.genres) {
      const value = profile.genres.get(g) ?? 0;
      if (value > genreValue) { genre = g; genreValue = value; }
    }
    if (genre && genreValue >= 0.5) return `Because you like ${genrePhrase(genre)}`;
    return undefined;
  };

  return { profile, index, stats, now, coldStart, score, similarity: sim, explain };
}

// ---------------------------------------------------------------- diversity

/**
 * Maximal marginal relevance: picks `limit` items, each time the one that best
 * balances its own score against similarity to what is already picked.
 */
export function diversify(
  ranked: Scored[],
  limit: number,
  scorer: Pick<Scorer, "similarity">,
  lambda = 0.72,
  /** Titles the row already has, which new picks should differ from too. */
  already: Scored[] = []
): Scored[] {
  if (limit <= 0) return [];
  if (ranked.length <= 1) return ranked.slice(0, limit);
  const pool = ranked.slice(0, Math.max(limit * 3, 30));
  const max = Math.max(...pool.map((entry) => entry.score));
  const min = Math.min(...pool.map((entry) => entry.score));
  const span = max - min || 1;
  const picked: Scored[] = [];
  const closest = new Map<string, number>(
    pool.map((entry) => [entry.key, Math.max(0, ...already.map((other) => scorer.similarity(entry.item, other.item)))])
  );
  while (picked.length < limit && pool.length) {
    let bestIndex = 0;
    let bestValue = -Infinity;
    for (let i = 0; i < pool.length; i += 1) {
      const entry = pool[i];
      const value = lambda * ((entry.score - min) / span) - (1 - lambda) * (closest.get(entry.key) ?? 0);
      if (value > bestValue) { bestValue = value; bestIndex = i; }
    }
    const [chosen] = pool.splice(bestIndex, 1);
    picked.push(chosen);
    for (const entry of pool) {
      const s = scorer.similarity(entry.item, chosen.item);
      if (s > (closest.get(entry.key) ?? 0)) closest.set(entry.key, s);
    }
  }
  return picked;
}
