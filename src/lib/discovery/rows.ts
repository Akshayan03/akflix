/**
 * Which rows the home screen and the What's New page show, in which order,
 * with which titles. Pure: everything comes in through `Signals` (this
 * profile's synced history) and `DiscoveryData` (catalogue feeds), so the Mac
 * and the iPhone build the same home from the same account.
 *
 * Rules:
 * - a row appears only with enough good titles (artwork, a match);
 * - rows are ordered by predicted interest;
 * - discovery rows never repeat a title another row already shows;
 * - titles rated 1-2 or finished never appear, except in Watch it again;
 * - "new" always means a real release or air date from the catalogue.
 */
import type { StremioMeta } from "@/types/stremio";
import {
  DAY,
  isDateOnly,
  airedAfter,
  airedBy,
  compareEpisodes,
  datedEpisodes,
  dayLabel,
  latestStartedSeason,
  releasedAt,
  upcoming,
  type Episode,
} from "@/lib/discovery/dates";
import { genreRowName, hasPairName, normalizeGenre } from "@/lib/discovery/genres";
import {
  FeatureIndex,
  buildProfile,
  collectSeeds,
  createScorer,
  diversify,
  keyOf,
  poolStats,
  type Scored,
  type Scorer,
  type Seed,
  type Signals,
  type TasteProfile,
} from "@/lib/discovery/taste";

export interface DiscoveryData {
  /** Cinemeta "Popular" order: what is being watched now. */
  trendingMovies: StremioMeta[];
  trendingSeries: StremioMeta[];
  /** This year's releases (and last year's early in the year). */
  newMovies: StremioMeta[];
  newSeries: StremioMeta[];
  /** Cinemeta "Featured" and the older-decade feeds that keep classics in the pool. */
  featured: StremioMeta[];
  catalog: StremioMeta[];
  /** Popular titles by genre, keyed `movie:Crime` (favourite genres and the generic rows). */
  byGenre: Record<string, StremioMeta[]>;
  /** Full metadata by `type:id` (people for seeds, every episode for some series). */
  details: Record<string, StremioMeta>;
  /** Series id → that show with its latest and scheduled episodes. */
  calendar: Record<string, StremioMeta>;
  /** Person → titles that credit them. */
  credits: Record<string, StremioMeta[]>;
}

export const emptyDiscoveryData = (): DiscoveryData => ({
  trendingMovies: [],
  trendingSeries: [],
  newMovies: [],
  newSeries: [],
  featured: [],
  catalog: [],
  byGenre: {},
  details: {},
  calendar: {},
  credits: {},
});

export type RowKind =
  | "new-episodes"
  | "finish-series"
  | "top-picks"
  | "because-liked"
  | "because-watched"
  | "more-from"
  | "genre"
  | "whats-new"
  | "trending"
  | "top-rated"
  | "hidden-gems"
  | "watch-again";

export interface HomeRow {
  id: string;
  kind: RowKind;
  title: string;
  tagline?: string;
  items: StremioMeta[];
  /** Card key (`type:id`) → why it is here. */
  reasons: Record<string, string>;
  /** Card key → a short fact for the card ("S6 E5 · Oct 14", "New season"). */
  badges: Record<string, string>;
  variant: "poster" | "landscape";
  interest: number;
  seeAll?: string;
}

export interface HomePlan {
  rows: HomeRow[];
  coldStart: boolean;
  hero: { item: StremioMeta; eyebrow: string } | null;
  /** Well-known titles for the optional "pick 3 you like" start. */
  onboarding: StremioMeta[];
  /** Continue Watching card key → news about that show. */
  continueBadges: Record<string, string>;
  profile: TasteProfile;
}

export interface PlanOptions {
  /** Only for tests; the app formats dates in the viewer's zone. */
  timeZone?: string;
  /**
   * Titles (`type:id`) already in Continue Watching. Their news ("Season 4
   * is out", "2 episodes left") goes on that card instead of a second row.
   */
  continuing?: string[];
}

export const MIN_ROW = 6;
const NEW_WINDOW = 45;

interface Candidate extends Scored {
  badge?: string;
}

interface RowSpec {
  id: string;
  kind: RowKind;
  title: string;
  tagline?: string;
  candidates: Candidate[];
  min: number;
  limit: number;
  /** MMR trade-off; undefined keeps the ranked order. */
  lambda?: number;
  /** "yours" rows (your shows, watch again) only de-duplicate among themselves. */
  group: "discover" | "yours";
  variant: "poster" | "landscape";
  interest: number;
  seeAll?: string;
}

// ------------------------------------------------------------------ context

interface Context {
  now: number;
  timeZone?: string;
  pool: StremioMeta[];
  byKey: Map<string, StremioMeta>;
  seeds: Seed[];
  seedByKey: Map<string, Seed>;
  scorer: Scorer;
  /** Watched, rated or abandoned: not "new to you". */
  seen: Set<string>;
  /** Rated 1-2. */
  blocked: Set<string>;
  saved: Set<string>;
  /** Pool score → [0, 1]. */
  norm: (score: number) => number;
  data: DiscoveryData;
}

const usable = (item: StremioMeta | undefined): item is StremioMeta =>
  !!item && !!item.id && !!item.name && !!item.poster && (item.type === "movie" || item.type === "series");

function uniqueItems(lists: StremioMeta[][], details: Record<string, StremioMeta>) {
  const byKey = new Map<string, StremioMeta>();
  for (const list of lists) {
    for (const item of list) {
      if (!usable(item)) continue;
      const key = keyOf(item);
      const known = byKey.get(key);
      // Keep whichever copy has more to say (people, episodes).
      if (!known || (item.cast?.length ?? 0) + (item.videos?.length ?? 0) > (known.cast?.length ?? 0) + (known.videos?.length ?? 0)) {
        byKey.set(key, known ? { ...known, ...item } : item);
      }
    }
  }
  for (const [key, item] of Object.entries(details)) {
    if (!usable(item)) continue;
    const known = byKey.get(key);
    byKey.set(key, known ? { ...known, ...item, videos: item.videos ?? known.videos } : item);
  }
  return byKey;
}

function buildContext(signals: Signals, data: DiscoveryData, options: PlanOptions): Context {
  const byKey = uniqueItems(
    [data.trendingMovies, data.trendingSeries, data.newMovies, data.newSeries, data.featured, data.catalog, ...Object.values(data.byGenre), ...Object.values(data.credits)],
    data.details
  );
  const pool = [...byKey.values()];
  const seeds = collectSeeds(signals, (key) => data.details[key] ?? byKey.get(key) ?? data.calendar[key.slice(key.indexOf(":") + 1)]);
  const index = new FeatureIndex([...pool, ...seeds.map((seed) => seed.item)]);
  const profile = buildProfile(seeds, index);
  const scorer = createScorer(profile, index, poolStats(pool), signals.now);
  const seen = new Set<string>();
  const blocked = new Set<string>();
  const saved = new Set<string>();
  for (const seed of seeds) {
    if (!seed.catalog) continue;
    if (seed.watched || seed.finished || seed.rating !== undefined || seed.abandoned) seen.add(seed.key);
    if (seed.disliked) blocked.add(seed.key);
    if (seed.saved) saved.add(seed.key);
  }
  // Scale scores by what can be recommended; seen titles score themselves high.
  const scores = pool.filter((item) => !seen.has(keyOf(item)) && !blocked.has(keyOf(item))).map((item) => scorer.score(item));
  const max = scores.length ? Math.max(...scores) : 1;
  const min = scores.length ? Math.min(...scores) : 0;
  const span = max - min || 1;
  return {
    now: signals.now,
    timeZone: options.timeZone,
    pool,
    byKey,
    seeds,
    seedByKey: new Map(seeds.map((seed) => [seed.key, seed])),
    scorer,
    seen,
    blocked,
    saved,
    norm: (score) => Math.max(0, Math.min(1, (score - min) / span)),
    data,
  };
}

/** New to this profile: not watched, rated or given up on, and not already on My List. */
const fresh = (ctx: Context, item: StremioMeta) =>
  !ctx.seen.has(keyOf(item)) && !ctx.blocked.has(keyOf(item)) && !ctx.saved.has(keyOf(item));

/** No popularity data anywhere (Cinemeta activity, TMDB or Trakt): any rating it has comes from a handful of votes. */
const unknown = (item: StremioMeta) =>
  !((item.popularity ?? 0) > 0) && !((item.popularities?.moviedb ?? 0) > 0) && !((item.popularities?.trakt ?? 0) > 0);

/**
 * Good enough to recommend: rated 6+ on IMDb by a title people actually
 * watch, or too new to be rated yet but already drawing viewers. Factual
 * lists (What's New, Trending) skip this.
 */
function recommendable(ctx: Context, item: StremioMeta, floor = 6) {
  if (unknown(item)) return false;
  const rating = ctx.scorer.index.of(item).rating;
  if (rating) return rating >= floor;
  const released = releasedAt(item);
  return released !== null && released <= ctx.now && ctx.now - released <= 90 * DAY && ctx.scorer.stats.buzz(item) >= 0.35;
}

const meanTop = (ctx: Context, candidates: Candidate[], count = 6) => {
  const top = candidates.slice(0, count);
  return top.length ? top.reduce((sum, entry) => sum + ctx.norm(ctx.scorer.score(entry.item)), 0) / top.length : 0;
};

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

const byValue = (a: Candidate, b: Candidate) => b.score - a.score;

// ------------------------------------------------------------- what is new

export interface Freshness {
  at: number;
  dateOnly?: boolean;
  /** "New", "New series", "New season". */
  kind: "movie" | "series" | "season";
  season?: number;
}

/** When a title became new (release, first air date, or its latest season's start). */
export function newness(item: StremioMeta, now: number, windowDays: number, details?: StremioMeta): Freshness | null {
  const within = (at: number | null): at is number => at !== null && at <= now && now - at <= windowDays * DAY;
  const raw = releasedAt(item) !== null ? item.released : details?.released;
  const released = releasedAt({ released: raw });
  const dateOnly = isDateOnly(raw) || undefined;
  if (item.type === "movie") return within(released) ? { at: released, dateOnly, kind: "movie" } : null;
  if (within(released)) return { at: released, dateOnly, kind: "series" };
  const episodes = datedEpisodes(details?.videos ?? item.videos);
  const latest = latestStartedSeason(episodes, now);
  if (latest && latest.season >= 2 && within(latest.at)) {
    const first = episodes.find((episode) => episode.season === latest.season && episode.at === latest.at);
    return { at: latest.at, dateOnly: first?.dateOnly, kind: "season", season: latest.season };
  }
  return null;
}

const newBadge = (freshness: Freshness) =>
  freshness.kind === "season" ? `Season ${freshness.season} · new` : freshness.kind === "series" ? "New series" : "New";

// -------------------------------------------------------------- your shows

interface ShowState {
  seed: Seed;
  item: StremioMeta;
  episodes: Episode[];
  place: { season: number; episode: number };
  unwatched: Episode[];
}

/** What the catalogue knows about each series this profile watches. */
function showStates(ctx: Context): ShowState[] {
  const states: ShowState[] = [];
  for (const seed of ctx.seeds) {
    if (!seed.catalog || seed.type !== "series" || seed.disliked || seed.abandoned || !seed.entry) continue;
    const detail = ctx.data.details[seed.key];
    const calendar = ctx.data.calendar[seed.id];
    const complete = !!detail?.videos?.length;
    const episodes = datedEpisodes(complete ? detail!.videos : calendar?.videos);
    if (!episodes.length) continue;
    let place = seed.entry.season && seed.entry.episode ? { season: seed.entry.season, episode: seed.entry.episode } : null;
    if (!place && seed.entry.completed) {
      const watchedBy = airedBy(episodes, seed.entry.updatedAt);
      const last = watchedBy[watchedBy.length - 1];
      if (last) place = { season: last.season, episode: last.episode };
    }
    if (!place) continue;
    // A partial (calendar) list must reach back to the viewer's episode, or
    // the gap between them is unknown and nothing is claimed about it.
    if (!complete && compareEpisodes(episodes[0], place) > 0) continue;
    const item = detail ?? calendar ?? ctx.byKey.get(seed.key) ?? seed.item;
    if (!item.background && !item.poster) continue;
    states.push({ seed, item, episodes, place, unwatched: airedAfter(episodes, place, ctx.now) });
  }
  return states;
}

function episodeBadge(episodes: Episode[], ctx: Context) {
  const latest = episodes[episodes.length - 1];
  const day = dayLabel(latest.at, ctx.now, ctx.timeZone, latest.dateOnly);
  return episodes.length === 1 ? `New: S${latest.season} E${latest.episode} · ${day}` : `${episodes.length} new episodes · ${day}`;
}

interface YourShows {
  newEpisodes: Candidate[];
  nextSeason: Candidate[];
  finish: Candidate[];
  upcoming: Candidate[];
}

function yourShows(ctx: Context): YourShows {
  const out: YourShows = { newEpisodes: [], nextSeason: [], finish: [], upcoming: [] };
  for (const show of showStates(ctx)) {
    const { seed, item, unwatched, place, episodes } = show;
    const key = seed.key;
    const next = upcoming(episodes, ctx.now, 14)[0];
    if (next && compareEpisodes(next, place) > 0) {
      out.upcoming.push({ item, key, score: -next.at, badge: `S${next.season} E${next.episode} · ${dayLabel(next.at, ctx.now, ctx.timeZone, next.dateOnly)}` });
    }
    if (!unwatched.length) continue;
    const first = unwatched[0];
    if (first.season > place.season) {
      const start = unwatched.find((episode) => episode.season === first.season)!;
      if (ctx.now - start.at <= 180 * DAY) {
        out.nextSeason.push({ item, key, score: start.at, badge: `Season ${first.season} is out` });
      }
      continue;
    }
    const recent = unwatched.filter((episode) => ctx.now - episode.at <= 30 * DAY);
    if (recent.length) {
      out.newEpisodes.push({ item, key, score: recent[recent.length - 1].at, badge: episodeBadge(recent, ctx) });
      continue;
    }
    const remaining = unwatched.length + ((seed.entry?.progress ?? 0) < 85 ? 1 : 0);
    const idle = ctx.now - (seed.entry?.updatedAt ?? ctx.now);
    if (!seed.finished && remaining >= 1 && remaining <= 6 && idle >= 5 * DAY) {
      out.finish.push({ item, key, score: -remaining, badge: `${remaining} episode${remaining === 1 ? "" : "s"} left` });
    }
  }
  for (const list of [out.newEpisodes, out.nextSeason]) list.sort(byValue);
  out.finish.sort(byValue);
  out.upcoming.sort(byValue);
  return out;
}

// --------------------------------------------------------------- the rows

function topPicks(ctx: Context): Candidate[] {
  return ctx.pool
    .filter((item) => fresh(ctx, item) && recommendable(ctx, item))
    .map((item) => ({ item, key: keyOf(item), score: ctx.scorer.score(item), reason: ctx.scorer.explain(item) }))
    .sort(byValue);
}

function becauseOf(ctx: Context, seed: Seed): Candidate[] {
  const out: Candidate[] = [];
  for (const item of ctx.pool) {
    const key = keyOf(item);
    if (key === seed.key || !fresh(ctx, item) || !recommendable(ctx, item)) continue;
    const s = ctx.scorer.similarity(seed.item, item);
    if (s < 0.24) continue;
    out.push({ item, key, score: 0.55 * s + 0.45 * ctx.norm(ctx.scorer.score(item)) });
  }
  return out.sort(byValue);
}

/** The strongest recent signals: 1-2 liked titles, then 2-3 watched ones, never two near-identical anchors. */
function rowSeeds(ctx: Pick<Context, "seeds" | "now" | "scorer">) {
  const recency = (seed: Seed) => 0.4 + 0.6 * Math.pow(0.5, Math.max(0, ctx.now - seed.at) / DAY / 60);
  const anchors = ctx.seeds.filter((seed) => seed.catalog && !seed.disliked && seed.weight > 0);
  const liked = anchors
    .filter((seed) => seed.liked)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.weight * recency(b) - a.weight * recency(a));
  const watched = anchors
    .filter((seed) => !seed.liked && seed.watched && seed.weight >= 0.8)
    .sort((a, b) => b.weight * recency(b) - a.weight * recency(a));
  const chosen: { seed: Seed; kind: "liked" | "watched" }[] = [];
  const distinct = (seed: Seed) => chosen.every((other) => ctx.scorer.similarity(seed.item, other.seed.item) <= 0.6);
  for (const seed of liked) {
    if (chosen.length >= 2) break;
    if (distinct(seed)) chosen.push({ seed, kind: "liked" });
  }
  let watchedRows = 0;
  for (const seed of watched) {
    if (watchedRows >= 3) break;
    if (distinct(seed)) { chosen.push({ seed, kind: "watched" }); watchedRows += 1; }
  }
  return chosen;
}

function moreFrom(ctx: Context) {
  const out: { person: string; creator: boolean; affinity: number; candidates: Candidate[] }[] = [];
  const profile = ctx.scorer.profile;
  const people = [...profile.people.entries()].filter(([, value]) => value >= 0.35).sort((a, b) => b[1] - a[1]).slice(0, 4);
  for (const [person, affinity] of people) {
    const credited = new Map<string, StremioMeta>();
    for (const item of [...(ctx.data.credits[person] ?? []), ...ctx.pool]) {
      if (!usable(item) || !fresh(ctx, item) || !recommendable(ctx, item, 5.5)) continue;
      if (ctx.scorer.index.of(item).people.has(person)) credited.set(keyOf(item), ctx.byKey.get(keyOf(item)) ?? item);
    }
    const creator = ctx.seeds.some((seed) => seed.weight > 0 && ctx.scorer.index.of(seed.item).creators.has(person));
    const candidates = [...credited.values()].map((item) => ({ item, key: keyOf(item), score: ctx.scorer.score(item) })).sort(byValue);
    out.push({ person, creator, affinity, candidates });
  }
  return out;
}

function genreSpecs(ctx: Context): { genres: string[]; weight: number }[] {
  const profile = ctx.scorer.profile;
  const top = [...profile.genres.entries()].filter(([, value]) => value >= 0.3).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const pairs = new Map<string, number>();
  for (const seed of profile.positives) {
    const genres = ctx.scorer.index.of(seed.item).genres;
    for (let i = 0; i < genres.length; i += 1) {
      for (let j = i + 1; j < genres.length; j += 1) {
        if (!hasPairName(genres[i], genres[j])) continue;
        const pair = [genres[i], genres[j]].sort().join("+");
        pairs.set(pair, (pairs.get(pair) ?? 0) + seed.weight);
      }
    }
  }
  const topNames = new Set(top.map(([genre]) => genre));
  const specs: { genres: string[]; weight: number }[] = [];
  const bestPairs = [...pairs.entries()]
    .filter(([pair]) => pair.split("+").every((genre) => topNames.has(genre)))
    .sort((a, b) => b[1] - a[1]);
  const strongest = Math.max(1e-6, ...pairs.values());
  for (const [pair, weight] of bestPairs.slice(0, 2)) {
    if (weight < strongest * 0.45) break;
    const genres = pair.split("+");
    specs.push({ genres, weight: Math.min(...genres.map((genre) => profile.genres.get(genre) ?? 0)) });
  }
  for (const [genre, weight] of top) {
    if (specs.length >= 3) break;
    // A single genre already covered by a chosen pair would mostly repeat it.
    if (specs.some((spec) => spec.genres.includes(genre))) continue;
    specs.push({ genres: [genre], weight });
  }
  return specs.slice(0, 3);
}

function genreCandidates(ctx: Context, genres: string[]): Candidate[] {
  return ctx.pool
    .filter((item) => fresh(ctx, item) && recommendable(ctx, item))
    .filter((item) => {
      const own = ctx.scorer.index.of(item).genres;
      return genres.every((genre) => own.includes(normalizeGenre(genre)));
    })
    .map((item) => ({ item, key: keyOf(item), score: ctx.scorer.score(item) }))
    .sort(byValue);
}

function whatsNew(ctx: Context, windowDays = NEW_WINDOW): Candidate[] {
  const out: Candidate[] = [];
  for (const item of ctx.pool) {
    if (!fresh(ctx, item)) continue;
    const freshness = newness(item, ctx.now, windowDays, ctx.data.details[keyOf(item)]);
    if (!freshness) continue;
    const recency = 1 - (ctx.now - freshness.at) / (windowDays * DAY);
    // The twentieth season of a procedural is less news than a new film or show.
    const routine = freshness.kind === "season" && (freshness.season ?? 0) >= 4 ? 0.75 : 1;
    out.push({
      item,
      key: keyOf(item),
      score: routine * (0.35 * recency + 0.45 * ctx.norm(ctx.scorer.score(item)) + 0.2 * ctx.scorer.stats.buzz(item)),
      badge: newBadge(freshness),
    });
  }
  // Keep the row mostly releases: at most a third returning seasons.
  let seasons = 0;
  return out.sort(byValue).filter((entry) => !entry.badge?.startsWith("Season") || (seasons += 1) <= 8);
}

function trending(ctx: Context): Candidate[] {
  const out = new Map<string, Candidate>();
  for (const list of [ctx.data.trendingMovies, ctx.data.trendingSeries]) {
    list.forEach((raw, position) => {
      const item = ctx.byKey.get(keyOf(raw));
      if (!item || !fresh(ctx, item)) return;
      const rank = 1 - position / Math.max(1, list.length);
      const score = 0.75 * rank + 0.25 * ctx.norm(ctx.scorer.score(item));
      const key = keyOf(item);
      if ((out.get(key)?.score ?? -Infinity) < score) out.set(key, { item, key, score });
    });
  }
  return [...out.values()].sort(byValue);
}

function topRated(ctx: Context): Candidate[] {
  return ctx.pool
    .filter((item) => fresh(ctx, item))
    .map((item) => ({ item, rating: ctx.scorer.index.of(item).rating }))
    .filter(({ item, rating }) => rating >= 7.9 && ctx.scorer.stats.fame(item) >= 0.3)
    .map(({ item, rating }) => ({
      item,
      key: keyOf(item),
      score: 0.6 * clamp((rating - 7.9) / 1.4, 0, 1) + 0.4 * ctx.norm(ctx.scorer.score(item)),
    }))
    .sort(byValue);
}

function hiddenGems(ctx: Context): Candidate[] {
  const scores = ctx.pool.map((item) => ctx.scorer.score(item)).sort((a, b) => a - b);
  const median = scores[Math.floor(scores.length / 2)] ?? 0;
  return ctx.pool
    .filter((item) => fresh(ctx, item))
    .map((item) => ({ item, rating: ctx.scorer.index.of(item).rating, score: ctx.scorer.score(item) }))
    .filter(({ item, rating, score }) => {
      const fame = ctx.scorer.stats.fame(item);
      // Less known, but not unknown: titles with no popularity data at all
      // tend to be rated by a handful of people, which makes any score look great.
      const known = (item.popularities?.moviedb ?? 0) >= 5;
      return rating >= 7.4 && score >= median && known && fame <= 0.5 && ctx.scorer.stats.buzz(item) <= 0.55;
    })
    // "Matched to taste" means a real link: a title or person they like, or a
    // strong genre match.
    .filter(({ item, score }) => {
      const reason = ctx.scorer.explain(item);
      return !!reason && (!reason.startsWith("Because you like ") || ctx.norm(score) >= 0.7);
    })
    .map(({ item, rating, score }) => ({
      item,
      key: keyOf(item),
      score: 0.55 * ctx.norm(score) + 0.45 * clamp((rating - 7.4) / 1.6, 0, 1),
    }))
    .sort(byValue);
}

function watchAgain(ctx: Context): Candidate[] {
  const ratingValue: Record<number, number> = { 3: 0.6, 4: 1.6, 5: 2.4 };
  return ctx.seeds
    .filter((seed) => seed.catalog && !seed.disliked)
    .filter((seed) => seed.finished || ((seed.rating ?? 0) >= 4 && (seed.entry?.progress ?? 0) >= 80))
    // A rewatch already under way is in Continue Watching.
    .filter((seed) => seed.finished || !seed.entry || seed.entry.completed || ctx.now - seed.entry.updatedAt > 3 * DAY)
    .map((seed) => {
      const item = ctx.byKey.get(seed.key) ?? ctx.data.details[seed.key] ?? seed.item;
      const age = (ctx.now - seed.at) / DAY;
      const score =
        (seed.rating ? ratingValue[seed.rating] ?? 0 : 0.8) +
        0.5 * Math.min(3, seed.engagement?.rewatches ?? 0) +
        0.3 * Math.min(3, seed.engagement?.plays ?? 0) +
        0.6 * Math.min(1, age / 120);
      return { item, key: seed.key, score };
    })
    .filter((entry) => usable(entry.item))
    .sort(byValue);
}

// --------------------------------------------------------------- assembly

const PRIOR: Record<RowKind, number> = {
  "new-episodes": 100,
  "top-picks": 9.5,
  "because-liked": 7.4,
  "because-watched": 7.2,
  "whats-new": 7,
  "more-from": 6.4,
  "finish-series": 6.2,
  genre: 6,
  trending: 5.6,
  "hidden-gems": 5.2,
  "top-rated": 4.8,
  "watch-again": 4,
};

const COLD_PRIOR: Partial<Record<RowKind, number>> = { "whats-new": 9, trending: 8.5, "top-rated": 7.5 };

function assemble(ctx: Context, specs: RowSpec[]): HomeRow[] {
  // Two passes in order of interest: every row first claims just enough
  // titles to stand (its minimum), then rows fill up to their limit from
  // what is left. A narrow row (a creator, hidden gems) is not starved by a
  // broad one above it, and the top row still gets the best titles.
  const ordered = [...specs].sort((a, b) => b.interest - a.interest);
  const used = { discover: new Set<string>(), yours: new Set<string>() };
  const picks = new Map<RowSpec, Scored[]>();
  const take = (spec: RowSpec, count: number, already: Scored[]) => {
    const taken = used[spec.group];
    const available = spec.candidates.filter((entry) => !taken.has(entry.key) && usable(entry.item));
    const chosen = spec.lambda === undefined ? available.slice(0, count) : diversify(available, count, ctx.scorer, spec.lambda, already);
    for (const entry of chosen) taken.add(entry.key);
    return chosen;
  };
  for (const spec of ordered) {
    const taken = used[spec.group];
    const available = spec.candidates.filter((entry) => !taken.has(entry.key) && usable(entry.item));
    if (available.length < spec.min) continue;
    picks.set(spec, take(spec, spec.min, []));
  }
  for (const spec of ordered) {
    const first = picks.get(spec);
    if (!first) continue;
    picks.set(spec, [...first, ...take(spec, spec.limit - first.length, first)]);
  }
  const rows: HomeRow[] = [];
  for (const spec of ordered) {
    const picked = picks.get(spec);
    if (!picked) continue;
    const reasons: Record<string, string> = {};
    const badges: Record<string, string> = {};
    for (const entry of picked as Candidate[]) {
      if (entry.reason) reasons[entry.key] = entry.reason;
      if (entry.badge) badges[entry.key] = entry.badge;
    }
    rows.push({
      id: spec.id,
      kind: spec.kind,
      title: spec.title,
      tagline: spec.tagline,
      items: picked.map((entry) => entry.item),
      reasons,
      badges,
      variant: spec.variant,
      interest: spec.interest,
      seeAll: spec.seeAll,
    });
  }
  // Two rows of the same kind in a row read as one long row; space them out.
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].kind !== rows[i - 1].kind) continue;
    const j = rows.findIndex((row, index) => index > i && row.kind !== rows[i].kind);
    if (j > i) rows.splice(i, 0, rows.splice(j, 1)[0]);
  }
  return rows;
}

export function planHome(signals: Signals, data: DiscoveryData, options: PlanOptions = {}): HomePlan {
  const ctx = buildContext(signals, data, options);
  const { scorer } = ctx;
  const cold = scorer.coldStart;
  const prior = (kind: RowKind) => (cold ? COLD_PRIOR[kind] ?? PRIOR[kind] : PRIOR[kind]);
  const interest = (kind: RowKind, candidates: Candidate[], factor = 1) =>
    prior(kind) * (0.75 + 0.5 * meanTop(ctx, candidates)) * factor;
  const specs: RowSpec[] = [];
  const add = (spec: Omit<RowSpec, "interest" | "group" | "variant" | "min" | "limit"> & Partial<Pick<RowSpec, "group" | "variant" | "min" | "limit">>, factor = 1) =>
    specs.push({
      group: "discover",
      variant: "poster",
      min: MIN_ROW,
      limit: 20,
      ...spec,
      interest: interest(spec.kind, spec.candidates, factor),
    });

  const shows = yourShows(ctx);
  const continuing = new Set(options.continuing ?? []);
  const continueBadges: Record<string, string> = {};
  const notContinuing = (list: Candidate[]) =>
    list.filter((entry) => {
      if (!continuing.has(entry.key)) return true;
      continueBadges[entry.key] ??= entry.badge ?? "";
      return false;
    });
  // A new season reads as new episodes too: one row, newest first.
  const news = notContinuing([...shows.newEpisodes, ...shows.nextSeason].sort(byValue));
  add({ id: "new-episodes", kind: "new-episodes", title: "New episodes of your shows", candidates: news, group: "yours", variant: "landscape", min: 1 });
  add({ id: "finish-series", kind: "finish-series", title: "Finish the series", tagline: "A few episodes to go", candidates: notContinuing(shows.finish), group: "yours", variant: "landscape", min: 1 });

  add({ id: "whats-new", kind: "whats-new", title: "What's New", tagline: "Films, series and seasons just out", candidates: whatsNew(ctx), limit: 24, lambda: 0.85, seeAll: "/new" });
  add({ id: "trending", kind: "trending", title: "Trending now", tagline: "What people are watching", candidates: trending(ctx), limit: 24 });
  add({ id: "top-rated", kind: "top-rated", title: "Top rated", tagline: "Highest IMDb ratings", candidates: topRated(ctx), limit: 24, lambda: 0.8 });

  if (!cold) {
    add({ id: "top-picks", kind: "top-picks", title: "Top picks for you", tagline: "From what you watch and rate", candidates: topPicks(ctx), limit: 24, lambda: 0.72 });
    rowSeeds(ctx).forEach(({ seed, kind }, index) => {
      const rowKind = kind === "liked" ? "because-liked" : "because-watched";
      add(
        {
          id: `${rowKind}:${seed.key}`,
          kind: rowKind,
          title: `Because you ${kind} ${seed.name}`,
          candidates: becauseOf(ctx, seed),
          min: 5,
          limit: 18,
          lambda: 0.8,
        },
        clamp(0.75 + seed.weight / 6, 0.75, 1.25) * Math.pow(0.94, index)
      );
    });
    moreFrom(ctx).forEach(({ person, creator, affinity, candidates }, index) => {
      if (index >= 2) return;
      add(
        { id: `more-from:${person}`, kind: "more-from", title: `${creator ? "More from" : "More with"} ${person}`, candidates, min: 4, limit: 18 },
        clamp(0.7 + affinity * 0.4, 0.7, 1.1)
      );
    });
    genreSpecs(ctx).forEach(({ genres, weight }, index) => {
      add(
        { id: `genre:${genres.join("+")}`, kind: "genre", title: `${genreRowName(genres)} for you`, candidates: genreCandidates(ctx, genres), lambda: 0.75 },
        clamp(0.7 + weight * 0.4, 0.7, 1.1) * Math.pow(0.94, index)
      );
    });
    add({ id: "hidden-gems", kind: "hidden-gems", title: "Hidden gems", tagline: "Highly rated, less known, matched to your taste", candidates: hiddenGems(ctx), lambda: 0.75 });
  }
  add({ id: "watch-again", kind: "watch-again", title: "Watch it again", candidates: watchAgain(ctx), group: "yours", min: 3 });

  const rows = assemble(ctx, specs);
  const heroFrom = (kind: RowKind) => rows.find((row) => row.kind === kind)?.items.find((item) => item.background);
  const pick = !cold ? heroFrom("top-picks") : undefined;
  const latest = heroFrom("whats-new");
  const popular = heroFrom("trending");
  const hero = pick
    ? { item: pick, eyebrow: "Top pick for you" }
    : latest
      ? { item: latest, eyebrow: "New on Akflix" }
      : popular
        ? { item: popular, eyebrow: "Trending now" }
        : null;
  // The hero is not repeated as the first card of the row it came from.
  if (hero) {
    const row = rows.find((candidate) => candidate.items.includes(hero.item));
    if (row && row.items.length > MIN_ROW) row.items = row.items.filter((item) => item !== hero.item);
  }

  const onboarding = cold
    ? diversify(
        ctx.pool
          .filter((item) => fresh(ctx, item) && scorer.index.of(item).rating >= 7 && scorer.stats.fame(item) >= 0.6)
          .map((item) => ({ item, key: keyOf(item), score: scorer.stats.fame(item) + scorer.index.of(item).rating / 10 }))
          .sort(byValue),
        12,
        scorer,
        0.55
      ).map((entry) => entry.item)
    : [];

  return { rows, coldStart: cold, hero, onboarding, continueBadges, profile: scorer.profile };
}

// ---------------------------------------------------------- What's New page

export type NewFilter = "all" | "movie" | "series";

export interface NewSection {
  id: string;
  title: string;
  tagline?: string;
  items: StremioMeta[];
  badges: Record<string, string>;
  variant: "poster" | "landscape";
}

export function planWhatsNew(signals: Signals, data: DiscoveryData, filter: NewFilter, options: PlanOptions = {}): NewSection[] {
  const ctx = buildContext(signals, data, options);
  const wanted = (item: StremioMeta) => filter === "all" || item.type === filter;
  const sections: NewSection[] = [];
  const section = (id: string, title: string, entries: Candidate[], variant: NewSection["variant"] = "poster", tagline?: string) => {
    const items = entries.filter((entry) => wanted(entry.item));
    if (!items.length) return;
    const badges: Record<string, string> = {};
    for (const entry of items) if (entry.badge) badges[entry.key] = entry.badge;
    sections.push({ id, title, tagline, items: items.map((entry) => entry.item), badges, variant });
  };

  if (filter !== "movie") {
    const shows = yourShows(ctx);
    section("your-new-episodes", "New episodes of your shows", [...shows.newEpisodes, ...shows.nextSeason].sort(byValue), "landscape");
    section("your-upcoming", "Coming up for your shows", shows.upcoming, "landscape", "Air dates from the catalogue");
  }

  const dated: (Candidate & { at: number; kind: Freshness["kind"] })[] = [];
  for (const item of ctx.pool) {
    if (ctx.blocked.has(keyOf(item))) continue;
    const freshness = newness(item, ctx.now, 90, ctx.data.details[keyOf(item)]);
    if (!freshness) continue;
    const day = dayLabel(freshness.at, ctx.now, ctx.timeZone, freshness.dateOnly);
    dated.push({
      item,
      key: keyOf(item),
      at: freshness.at,
      kind: freshness.kind,
      // Newest first; the taste score only breaks ties within a day.
      score: Math.floor(freshness.at / DAY) + 0.5 * ctx.norm(ctx.scorer.score(item)),
      badge: freshness.kind === "season" ? `Season ${freshness.season} · ${day}` : day,
    });
  }
  dated.sort(byValue);
  const age = (entry: { at: number }) => (ctx.now - entry.at) / DAY;
  const releases = dated.filter((entry) => entry.kind !== "season");
  section("this-week", "Out this week", releases.filter((entry) => age(entry) <= 7));
  if (filter !== "movie") section("new-seasons", "New seasons", dated.filter((entry) => entry.kind === "season" && age(entry) <= 60));
  section("this-month", "Last 30 days", releases.filter((entry) => age(entry) > 7 && age(entry) <= 30));
  section("earlier", "Last 3 months", releases.filter((entry) => age(entry) > 30));
  return sections;
}
