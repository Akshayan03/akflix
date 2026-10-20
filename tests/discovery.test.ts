// Home discovery: taste profile, scoring, rows, dates, engagement and its sync.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { StremioMeta, StremioVideo } from "../src/types/stremio";
import type { HistoryTitle, PersonalRating, WatchHistoryEntry } from "../src/stores/historyStore";
import type { SavedTitle } from "../src/stores/listStore";
import {
  DAY,
  airedAfter,
  calendarDaysAgo,
  datedEpisodes,
  isDateOnly,
  dayLabel,
  latestStartedSeason,
  parseDate,
  upcoming,
} from "../src/lib/discovery/dates";
import { genreRowName, normalizeGenre } from "../src/lib/discovery/genres";
import {
  FeatureIndex,
  buildProfile,
  collectSeeds,
  createScorer,
  diversify,
  keyOf,
  poolStats,
  similarity,
  type Signals,
} from "../src/lib/discovery/taste";
import { MIN_ROW, emptyDiscoveryData, newness, planHome, planWhatsNew, type DiscoveryData, type HomeRow } from "../src/lib/discovery/rows";
import { applyWatchEvents, emptyEngagement, watchEvents } from "../src/lib/discovery/engagement";
import { loadDiscovery, trimMeta, DISCOVERY_CACHE_PREFIX } from "../src/lib/discovery/feeds";
import { recommendedTitles } from "../src/lib/recommendations";
import {
  collectLocalChanges,
  emptyPatch,
  fingerprint,
  localTitles,
  mergeTitles,
  titleFromDoc,
  titleToDoc,
  type CloudTitle,
} from "../src/lib/cloud/model";
import { fromFields, toFields } from "../src/lib/cloud/firestore";
import { useHistory } from "../src/stores/historyStore";
import { useEngagement } from "../src/stores/engagementStore";

const NOW = Date.UTC(2026, 9, 19, 12);
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
const UTC = { timeZone: "UTC" };

// ----------------------------------------------------------------- fixtures

let serial = 0;
function meta(name: string, type: "movie" | "series", genres: string[], extra: Partial<StremioMeta> = {}): StremioMeta {
  serial += 1;
  return {
    id: `tt${9_000_000 + serial}`,
    type,
    name,
    poster: `https://img.test/${serial}.jpg`,
    background: `https://img.test/${serial}-bg.jpg`,
    genres,
    imdbRating: "7.1",
    year: "2016",
    releaseInfo: "2016",
    released: "2016-04-01T00:00:00.000Z",
    popularity: 1,
    popularities: { trakt: 800, moviedb: 15 },
    cast: [],
    director: [],
    writer: [],
    country: "United States",
    description: "",
    ...extra,
  };
}

/** `count` titles that share genres, people and keywords. */
function cluster(prefix: string, count: number, type: "movie" | "series", genres: string[], people: { cast?: string[]; director?: string[]; writer?: string[] }, words: string, extra: (i: number) => Partial<StremioMeta> = () => ({})) {
  return Array.from({ length: count }, (_, i) =>
    meta(`${prefix} ${i + 1}`, type, genres, {
      cast: [...(people.cast ?? []).slice(0, 2), `${prefix} Actor ${i}`],
      director: people.director ?? [`${prefix} Director ${i}`],
      writer: people.writer ?? [],
      description: `${words} ${prefix.toLowerCase()} chapter${i}`,
      imdbRating: (7 + (i % 5) * 0.3).toFixed(1),
      popularity: 1 + (i % 7),
      popularities: { trakt: 300 + i * 120, moviedb: 10 + i },
      ...extra(i),
    })
  );
}

const crime = cluster("Harbor", 14, "series", ["Crime", "Drama"], { cast: ["Idris Vale", "Dominic Shore"], writer: ["Dana Simmons"] }, "detectives wiretap baltimore drug corner police corruption");
const crimeFilms = cluster("Precinct", 10, "movie", ["Crime", "Drama", "Thriller"], { cast: ["Idris Vale"] }, "detective police corruption heist city");
const comedy = cluster("Laughs", 14, "movie", ["Comedy"], {}, "wedding roommates awkward party hilarious");
const scifi = cluster("Orbit", 12, "movie", ["Sci-Fi", "Adventure"], {}, "spaceship planet astronaut galaxy alien");
const horror = cluster("Hollow", 10, "movie", ["Horror", "Thriller"], {}, "haunted house ghost possession demon");
const hollywood = cluster("Agency", 8, "series", ["Comedy", "Drama"], { cast: ["Adrian Grant", "Jeremy Pike"], writer: ["Doug Ellis"] }, "hollywood agent actor fame friends limousine");
const ALL = [...crime, ...crimeFilms, ...comedy, ...scifi, ...horror, ...hollywood];

const media = (item: StremioMeta): HistoryTitle => ({
  source: "discover",
  id: item.id,
  type: item.type,
  name: item.name,
  poster: item.poster,
  background: item.background,
  description: item.description,
  genres: item.genres,
  year: item.year,
  imdbRating: item.imdbRating,
});
const finished = (item: StremioMeta, daysAgo: number, patch: Partial<WatchHistoryEntry> = {}): WatchHistoryEntry => ({
  profileId: "p",
  media: media(item),
  position: 6000,
  duration: 6000,
  progress: 100,
  completed: true,
  updatedAt: NOW - daysAgo * DAY,
  ...patch,
});
const watching = (item: StremioMeta, season: number, episode: number, daysAgo: number, progress = 40): WatchHistoryEntry => ({
  profileId: "p",
  media: media(item),
  position: 900,
  duration: 2600,
  progress,
  completed: false,
  season,
  episode,
  updatedAt: NOW - daysAgo * DAY,
});
const rated = (item: StremioMeta, value: number, daysAgo = 2): PersonalRating => ({ profileId: "p", media: media(item), value, updatedAt: NOW - daysAgo * DAY });
const saved = (item: StremioMeta, daysAgo = 3): SavedTitle => ({ profileId: "p", media: media(item), saved: true, at: NOW - daysAgo * DAY });
const signals = (partial: Partial<Signals> = {}): Signals => ({ now: NOW, history: [], ratings: [], list: [], engagement: [], ...partial });
const catalog = (partial: Partial<DiscoveryData> = {}): DiscoveryData => ({
  ...emptyDiscoveryData(),
  trendingMovies: [...comedy, ...scifi, ...horror, ...crimeFilms].filter((_, i) => i % 2 === 0),
  trendingSeries: [...crime, ...hollywood].filter((_, i) => i % 2 === 0),
  catalog: ALL,
  ...partial,
});
const keys = (items: StremioMeta[]) => items.map(keyOf);
const rowOf = (rows: HomeRow[], kind: HomeRow["kind"]) => rows.find((row) => row.kind === kind);

function scorerFor(input: Signals, pool: StremioMeta[] = ALL) {
  const byKey = new Map(pool.map((item) => [keyOf(item), item]));
  const seeds = collectSeeds(input, (key) => byKey.get(key));
  const index = new FeatureIndex(pool);
  return createScorer(buildProfile(seeds, index), index, poolStats(pool), input.now);
}

// -------------------------------------------------------------------- dates

test("discovery dates: only real ISO dates count, never a bare year", () => {
  assert.equal(parseDate("2026-10-14T00:00:00.000Z"), Date.UTC(2026, 9, 14));
  assert.equal(parseDate("2026"), null);
  assert.equal(parseDate(""), null);
  assert.equal(parseDate(undefined), null);
  assert.equal(parseDate("soon"), null);
  const noDate = meta("Undated", "movie", ["Drama"], { released: undefined, year: "2026", releaseInfo: "2026" });
  assert.equal(newness(noDate, NOW, 45), null, "a 2026 film without a release date is not 'new'");
  const future = meta("Next month", "movie", ["Drama"], { released: iso(-20) });
  assert.equal(newness(future, NOW, 45), null, "an unreleased film is not out yet");
  assert.equal(newness(meta("Last week", "movie", ["Drama"], { released: iso(6) }), NOW, 45)?.kind, "movie");
  assert.equal(newness(meta("Old", "movie", ["Drama"], { released: iso(200) }), NOW, 45), null);
});

test("discovery dates: episodes skip specials and undated rows, and sort in air order", () => {
  const videos: StremioVideo[] = [
    { id: "a", season: 2, episode: 1, released: "2026-09-16T03:00:00.000Z" },
    { id: "b", season: 0, episode: 4, released: "2026-09-01T00:00:00.000Z" },
    { id: "c", season: 1, episode: 8, released: "2025-10-01T00:00:00.000Z" },
    { id: "d", season: 2, episode: 2, released: undefined },
    { id: "e", season: 2, number: 3, episode: undefined as unknown as number, released: "2026-09-30T03:00:00.000Z" },
    { id: "f", season: 2, episode: 4, firstAired: "2026-10-21T03:00:00.000Z" },
    { id: "a2", season: 2, episode: 1, released: "2026-09-16T03:00:00.000Z" },
  ];
  const episodes = datedEpisodes(videos);
  assert.deepEqual(episodes.map((e) => `${e.season}x${e.episode}`), ["1x8", "2x1", "2x3", "2x4"]);
  assert.deepEqual(airedAfter(episodes, { season: 1, episode: 8 }, NOW).map((e) => `${e.season}x${e.episode}`), ["2x1", "2x3"]);
  assert.deepEqual(upcoming(episodes, NOW, 14).map((e) => e.episode), [4]);
  assert.deepEqual(latestStartedSeason(episodes, NOW), { season: 2, at: Date.parse("2026-09-16T03:00:00.000Z") });
});

test("discovery dates: day labels follow the calendar day", () => {
  assert.equal(dayLabel(NOW - 2 * 3600_000, NOW, "UTC"), "Today");
  assert.equal(dayLabel(NOW - DAY, NOW, "UTC"), "Yesterday");
  assert.equal(dayLabel(NOW + DAY, NOW, "UTC"), "Tomorrow");
  assert.equal(dayLabel(Date.UTC(2026, 9, 14), NOW, "UTC"), "Oct 14");
  assert.equal(dayLabel(Date.UTC(2026, 9, 21, 3), NOW, "UTC"), "Wed Oct 21");
  assert.equal(dayLabel(Date.UTC(2025, 0, 2), NOW, "UTC"), "Jan 2 2025");
  // 23:30 on the 18th in New York is still "Yesterday" there even though it is the 19th in UTC.
  assert.equal(calendarDaysAgo(Date.UTC(2026, 9, 19, 3, 30), NOW, "America/New_York"), 1);
  // A film "released 2026-10-16" (stored at midnight UTC) is Oct 16 everywhere, not Oct 15 in Toronto.
  assert.equal(isDateOnly("2026-10-16T00:00:00.000Z"), true);
  assert.equal(isDateOnly("2026-10-14T03:00:00.000Z"), false);
  assert.equal(dayLabel(Date.UTC(2026, 9, 16), NOW, "America/Toronto", true), "Oct 16");
  assert.equal(dayLabel(Date.UTC(2026, 9, 16), NOW, "America/Toronto"), "Oct 15");
  assert.equal(dayLabel(Date.UTC(2026, 9, 19), Date.UTC(2026, 9, 19, 23), "America/Los_Angeles", true), "Today");
});

test("discovery genres: one spelling, natural row names", () => {
  assert.equal(normalizeGenre("Science Fiction"), "sci-fi");
  assert.equal(normalizeGenre("Sci-Fi"), "sci-fi");
  assert.equal(genreRowName(["Crime", "Drama"]), "Crime dramas");
  assert.equal(genreRowName(["Drama", "Crime"]), "Crime dramas");
  assert.equal(genreRowName(["Thriller"]), "Thrillers");
  assert.equal(genreRowName(["Sci-Fi"]), "Sci-fi");
});

// ------------------------------------------------------------------ scoring

test("discovery scoring: a crime-drama viewer gets crime dramas over comedies", () => {
  const scorer = scorerFor(signals({ history: [finished(crime[0], 3), finished(crime[1], 10)], ratings: [rated(crime[2], 5)] }));
  const crimeScore = scorer.score(crime[5]);
  const comedyScore = scorer.score(comedy[5]);
  assert.ok(crimeScore > comedyScore + 1, `${crimeScore} vs ${comedyScore}`);
  assert.ok(scorer.score(crimeFilms[3]) > scorer.score(scifi[3]), "the shared genre and lead carry over to films");
  assert.equal(scorer.coldStart, false);
});

test("discovery scoring: explicit ratings outweigh watching alone", () => {
  // Finished a comedy, but rated a sci-fi film 5.
  const scorer = scorerFor(signals({ history: [finished(comedy[0], 2), finished(scifi[0], 2)], ratings: [rated(scifi[0], 5)] }));
  assert.ok(scorer.score(scifi[4]) > scorer.score(comedy[4]));
  const seeds = collectSeeds(signals({ history: [finished(comedy[0], 2)], ratings: [rated(scifi[0], 5)] }));
  assert.ok(seeds[0].key === keyOf(scifi[0]) && seeds[0].liked, "the 5-star title is the strongest signal");
});

test("discovery scoring: signals fade with age but never vanish", () => {
  const [recent] = collectSeeds(signals({ history: [finished(crime[0], 1)] }));
  const [old] = collectSeeds(signals({ history: [finished(crime[0], 720)] }));
  assert.ok(recent.weight > old.weight * 2);
  assert.ok(old.weight > 0.3);
});

test("discovery scoring: binges, rewatches and My List add weight", () => {
  const base = collectSeeds(signals({ history: [watching(crime[0], 2, 3, 1)] }))[0].weight;
  const binged = collectSeeds(signals({
    history: [watching(crime[0], 2, 3, 1)],
    engagement: [{ media: media(crime[0]), plays: 9, rewatches: 1, binges: 2, at: NOW - DAY }],
  }))[0].weight;
  assert.ok(binged > base + 1);
  const listed = collectSeeds(signals({ list: [saved(scifi[0])] }))[0];
  assert.ok(listed.weight > 0.5 && listed.saved && !listed.watched);
});

test("discovery negatives: thumbs-down and abandoned titles push similar titles down", () => {
  const neutral = scorerFor(signals({ history: [finished(crime[0], 3)] }));
  const disliked = scorerFor(signals({ history: [finished(crime[0], 3), finished(horror[0], 3)], ratings: [rated(horror[0], 1)] }));
  assert.ok(disliked.score(horror[4]) < neutral.score(horror[4]) - 0.5);
  const abandoned = collectSeeds(signals({ history: [{ ...finished(scifi[0], 30), completed: false, progress: 12 }] }))[0];
  assert.ok(abandoned.abandoned && abandoned.weight < 0, "a film stopped at 12% a month ago is a negative");
  const pilot = collectSeeds(signals({ history: [watching(crime[0], 1, 1, 40, 20)] }))[0];
  assert.ok(pilot.abandoned && pilot.weight < 0, "a pilot left unfinished for weeks is a negative");
  const fresh = collectSeeds(signals({ history: [{ ...finished(scifi[0], 2), completed: false, progress: 12 }] }))[0];
  assert.ok(!fresh.abandoned, "starting a film two days ago is not giving up");
});

test("discovery explanations name the title behind a pick", () => {
  const scorer = scorerFor(signals({ history: [finished(hollywood[0], 4)], ratings: [rated(crime[0], 5)] }));
  assert.equal(scorer.explain(crime[3]), `Because you liked ${crime[0].name}`);
  assert.equal(scorer.explain(hollywood[3]), `Because you watched ${hollywood[0].name}`);
});

test("discovery diversity: MMR spreads near-identical titles out", () => {
  const scorer = scorerFor(signals({ history: [finished(crime[0], 2), finished(comedy[0], 2), finished(scifi[0], 2)] }));
  // Close scores at the top, as in a real pool; a long tail sets the scale.
  const ranked = [...crime.slice(1, 9), comedy[3], scifi[3], ...horror].map((item, i) => ({ item, key: keyOf(item), score: i < 10 ? 10 - i * 0.05 : 5 - i * 0.01 }));
  const plain = ranked.slice(0, 4).map((entry) => entry.item.name.split(" ")[0]);
  const mixed = diversify(ranked, 4, scorer).map((entry) => entry.item.name.split(" ")[0]);
  assert.deepEqual(plain, ["Harbor", "Harbor", "Harbor", "Harbor"]);
  assert.ok(new Set(mixed).size >= 2, mixed.join(","));
  assert.equal(mixed[0], "Harbor", "the best title still leads");
  assert.ok(similarity(scorer.index.of(crime[1]), scorer.index.of(crime[2]), true) > similarity(scorer.index.of(crime[1]), scorer.index.of(comedy[2]), false));
});

// --------------------------------------------------------------- cold start

test("discovery cold start: trending, new and top rated, plus an optional pick-3", () => {
  const fresh = cluster("Premiere", 8, "movie", ["Drama"], {}, "debut festival", (i) => ({ released: iso(2 + i * 3) }));
  const classics = cluster("Classic", 8, "movie", ["Drama"], {}, "masterpiece", (i) => ({ imdbRating: (8.2 + i * 0.1).toFixed(1), popularities: { trakt: 50_000 + i, moviedb: 90 } }));
  const plan = planHome(signals(), catalog({ newMovies: fresh, featured: classics, catalog: [...ALL, ...classics] }), UTC);
  assert.equal(plan.coldStart, true);
  const kinds = plan.rows.map((row) => row.kind);
  assert.ok(kinds.includes("whats-new") && kinds.includes("trending") && kinds.includes("top-rated"), kinds.join(","));
  assert.ok(!kinds.includes("top-picks") && !kinds.includes("hidden-gems") && !kinds.some((kind) => kind.startsWith("because")));
  assert.ok(plan.onboarding.length >= 6 && plan.onboarding.length <= 12);
  assert.ok(plan.hero && plan.hero.item.background);
});

test("discovery cold start ends after a few real signals", () => {
  const plan = planHome(signals({ ratings: [rated(crime[0], 5), rated(scifi[0], 4), rated(comedy[0], 4)] }), catalog(), UTC);
  assert.equal(plan.coldStart, false);
  assert.ok(rowOf(plan.rows, "top-picks"));
  assert.equal(plan.onboarding.length, 0);
});

// --------------------------------------------------------------------- rows

function richPlan() {
  const input = signals({
    history: [
      finished(crime[0], 2),
      finished(crime[1], 9),
      watching(hollywood[0], 3, 4, 1, 60),
      finished(scifi[0], 20),
      finished(comedy[0], 60),
      { ...finished(horror[0], 40), completed: false, progress: 8 },
    ],
    ratings: [rated(crime[0], 5), rated(scifi[0], 4), rated(comedy[1], 1)],
    list: [saved(crimeFilms[0])],
  });
  return { input, plan: planHome(input, catalog(), UTC) };
}

test("discovery rows: enough good titles, ordered by interest, no repeats", () => {
  const { plan } = richPlan();
  assert.ok(plan.rows.length >= 5, plan.rows.map((row) => row.title).join(" | "));
  for (const row of plan.rows) {
    const min = row.kind === "watch-again" ? 3 : row.kind.startsWith("because") ? 5 : row.kind === "more-from" ? 4 : row.kind === "new-episodes" || row.kind === "finish-series" ? 1 : MIN_ROW;
    assert.ok(row.items.length >= min, `${row.title}: ${row.items.length}`);
    assert.equal(new Set(keys(row.items)).size, row.items.length, `${row.title} repeats a title`);
    assert.ok(row.items.every((item) => item.poster), "every card has artwork");
  }
  const discover = plan.rows.filter((row) => row.kind !== "watch-again");
  const all = discover.flatMap((row) => keys(row.items));
  assert.equal(new Set(all).size, all.length, "no title appears in two rows");
  // Interest order holds apart from spacing out rows of the same kind.
  const sorted = [...plan.rows].sort((a, b) => b.interest - a.interest).map((row) => row.id);
  assert.equal(plan.rows[0].id, sorted[0]);
  for (let i = 1; i < plan.rows.length; i += 1) assert.notEqual(plan.rows[i].kind, plan.rows[i - 1].kind, "same-kind rows are spaced out");
});

test("discovery rows: never a disliked or finished title outside Watch it again", () => {
  const { plan } = richPlan();
  const blocked = new Set([keyOf(comedy[1]), keyOf(crime[0]), keyOf(crime[1]), keyOf(scifi[0]), keyOf(comedy[0]), keyOf(horror[0])]);
  for (const row of plan.rows) {
    if (row.kind === "watch-again") continue;
    for (const item of row.items) assert.ok(!blocked.has(keyOf(item)), `${row.title} shows ${item.name}`);
  }
  const again = rowOf(plan.rows, "watch-again");
  assert.ok(again, "finished titles come back in Watch it again");
  assert.ok(!keys(again!.items).includes(keyOf(comedy[1])), "but never a thumbs-down");
  assert.ok(!keys(again!.items).includes(keyOf(horror[0])), "or something abandoned");
});

test("discovery rows: Because you liked / watched come from the strongest recent signals", () => {
  const { plan } = richPlan();
  const because = plan.rows.filter((row) => row.kind === "because-liked" || row.kind === "because-watched");
  assert.ok(because.length >= 2 && because.length <= 5, because.map((row) => row.title).join(" | "));
  assert.ok(because.some((row) => row.title === `Because you liked ${crime[0].name}`));
  assert.ok(because.some((row) => row.title === `Because you watched ${hollywood[0].name}`), because.map((row) => row.title).join(" | "));
  const liked = because.find((row) => row.title.includes(crime[0].name))!;
  assert.ok(liked.items.filter((item) => item.name.startsWith("Harbor") || item.name.startsWith("Precinct")).length >= liked.items.length - 1);
  // Anchors are distinct: the second crime finish does not get its own near-identical row.
  assert.ok(!because.some((row) => row.title.includes(crime[1].name)));
});

test("discovery rows: Top picks say why, and My List titles are not repeated", () => {
  const { plan } = richPlan();
  const picks = rowOf(plan.rows, "top-picks")!;
  assert.ok(picks);
  assert.ok(Object.values(picks.reasons).some((reason) => /^Because you (liked|watched) /.test(reason)));
  for (const row of plan.rows) assert.ok(!keys(row.items).includes(keyOf(crimeFilms[0])), `${row.title} repeats a My List title`);
  assert.equal(plan.hero?.eyebrow, "Top pick for you");
  assert.ok(!keys(picks.items).includes(keyOf(plan.hero!.item)), "the hero is not repeated right below it");
});

test("discovery rows: More from a creator, and genre rows named for the taste", () => {
  const input = signals({
    history: [finished(hollywood[0], 2), watching(hollywood[1], 2, 3, 3, 70)],
    ratings: [rated(hollywood[0], 5), rated(crime[0], 5), rated(crime[2], 4)],
  });
  const films = cluster("Ellis Film", 8, "movie", ["Comedy", "Romance"], { writer: ["Doug Ellis"] }, "romance comedy summer");
  const dramas = cluster("Coast", 16, "series", ["Crime", "Drama"], {}, "harbor smugglers coastguard");
  const plan = planHome(input, catalog({ credits: { "Doug Ellis": films }, catalog: [...ALL, ...dramas] }), UTC);
  const more = plan.rows.find((row) => row.kind === "more-from");
  assert.ok(more, plan.rows.map((row) => row.title).join(" | "));
  assert.equal(more!.title, "More from Doug Ellis");
  const genre = plan.rows.filter((row) => row.kind === "genre").map((row) => row.title);
  assert.ok(genre.length >= 1 && genre.every((title) => title.endsWith(" for you")), genre.join(","));
  assert.ok(genre.some((title) => /Crime dramas|Comedy dramas/.test(title)), genre.join(","));
});

test("discovery rows: hidden gems are well rated, less known and on taste", () => {
  const gems = cluster("Quiet", 16, "series", ["Crime", "Drama"], {}, "detectives wiretap police", (i) => ({ imdbRating: (8 + i * 0.1).toFixed(1), popularity: 0.1, popularities: { trakt: 5 + i, moviedb: 6 } }));
  const famous = cluster("Blockbuster", 30, "movie", ["Action"], {}, "explosion", (i) => ({ popularity: 50 + i, popularities: { trakt: 90_000 + i, moviedb: 400 } }));
  const plan = planHome(signals({ history: [finished(crime[0], 2), finished(crime[1], 5)], ratings: [rated(crime[0], 5)] }), catalog({ catalog: [...ALL, ...gems, ...famous] }), UTC);
  const row = rowOf(plan.rows, "hidden-gems");
  assert.ok(row, plan.rows.map((r) => r.title).join(" | "));
  assert.ok(row!.items.every((item) => Number(item.imdbRating) >= 7.4));
  const obscure = meta("No Data", "series", ["Crime", "Drama"], { imdbRating: "9.4", popularity: undefined, popularities: undefined, writer: ["Dana Simmons"] });
  const again = planHome(signals({ history: [finished(crime[0], 2), finished(crime[1], 5)], ratings: [rated(crime[0], 5)] }), catalog({ catalog: [...ALL, ...gems, ...famous, obscure] }), UTC);
  assert.ok(!keys(rowOf(again.rows, "hidden-gems")?.items ?? []).includes(keyOf(obscure)), "no popularity data at all is not a gem");
  assert.ok(row!.items.some((item) => item.name.startsWith("Quiet")));
  assert.ok(!row!.items.some((item) => item.name.startsWith("Blockbuster")));
});

test("discovery rows: a row without enough titles stays hidden", () => {
  const tiny = [meta("Lonely", "movie", ["Western"], { released: iso(3) })];
  const plan = planHome(signals(), { ...emptyDiscoveryData(), trendingMovies: tiny, newMovies: tiny }, UTC);
  assert.deepEqual(plan.rows, []);
  assert.equal(plan.hero, null);
});

// ------------------------------------------------------------ your shows

const showVideos = (seasons: { season: number; episodes: number; start: number; weekly?: boolean }[]): StremioVideo[] =>
  seasons.flatMap(({ season, episodes, start, weekly }) =>
    Array.from({ length: episodes }, (_, i) => ({ id: `x:${season}:${i + 1}`, season, episode: i + 1, released: iso(start - (weekly ? i * 7 : 0)) }))
  );

test("discovery shows: new episodes use real air dates after the viewer's episode", () => {
  const weekly = meta("Weekly Show", "series", ["Drama"], { videos: showVideos([{ season: 6, episodes: 6, start: 33, weekly: true }]) });
  // Aired 33, 26, 19, 12, 5 days ago and one in 2 days' time.
  const plan = planHome(
    signals({ history: [watching(weekly, 6, 3, 18, 95)] }),
    catalog({ details: { [keyOf(weekly)]: weekly } }),
    UTC
  );
  const row = rowOf(plan.rows, "new-episodes");
  assert.ok(row, plan.rows.map((r) => r.title).join(" | "));
  assert.equal(row!.variant, "landscape");
  assert.equal(row!.badges[keyOf(weekly)], "2 new episodes · Oct 14");
  const page = planWhatsNew(signals({ history: [watching(weekly, 6, 3, 18, 95)] }), catalog({ details: { [keyOf(weekly)]: weekly } }), "series", UTC);
  const coming = page.find((section) => section.id === "your-upcoming");
  assert.equal(coming?.badges[keyOf(weekly)], "S6 E6 · Wed Oct 21");
});

test("discovery shows: next season is out, finish the series, nothing invented", () => {
  const returning = meta("Returning Show", "series", ["Drama"], { videos: showVideos([{ season: 1, episodes: 8, start: 400 }, { season: 2, episodes: 8, start: 20 }]) });
  const almost = meta("Almost Done", "series", ["Comedy"], { videos: showVideos([{ season: 1, episodes: 10, start: 300 }]) });
  const unknown = meta("Calendar Only", "series", ["Drama"], {});
  const calendarOnly = { ...unknown, videos: showVideos([{ season: 4, episodes: 10, start: 10 }]) };
  const input = signals({
    history: [
      { ...watching(returning, 1, 8, 200, 100) },
      watching(almost, 1, 7, 12, 30),
      watching(unknown, 2, 5, 30, 50),
    ],
  });
  const plan = planHome(input, catalog({ details: { [keyOf(returning)]: returning, [keyOf(almost)]: almost }, calendar: { [unknown.id]: calendarOnly } }), UTC);
  assert.equal(rowOf(plan.rows, "new-episodes")?.badges[keyOf(returning)], "Season 2 is out");
  assert.equal(rowOf(plan.rows, "finish-series")?.badges[keyOf(almost)], "4 episodes left");
  // The calendar starts at season 4 but the viewer is at 2x5: the gap is unknown, so no claim.
  for (const row of plan.rows) assert.ok(!keys(row.items).includes(keyOf(unknown)), `${row.title} claims ${unknown.name}`);
  // Shows already in Continue Watching get the news on that card, not a second row.
  const continuing = [keyOf(returning), keyOf(almost)];
  const deduped = planHome(input, catalog({ details: { [keyOf(returning)]: returning, [keyOf(almost)]: almost }, calendar: { [unknown.id]: calendarOnly } }), { ...UTC, continuing });
  assert.equal(rowOf(deduped.rows, "new-episodes"), undefined);
  assert.equal(rowOf(deduped.rows, "finish-series"), undefined);
  assert.deepEqual(deduped.continueBadges, { [keyOf(returning)]: "Season 2 is out", [keyOf(almost)]: "4 episodes left" });
});

// ------------------------------------------------------------- What's New

test("What's New page: newest first, filterable, real release dates only", () => {
  const films = cluster("Fresh Film", 5, "movie", ["Drama"], {}, "festival", (i) => ({ released: iso(1 + i * 9) }));
  const shows = cluster("Fresh Show", 3, "series", ["Drama"], {}, "limited", (i) => ({ released: iso(2 + i * 20) }));
  const season = meta("Season Return", "series", ["Comedy"], { released: "2019-01-01T00:00:00.000Z", videos: showVideos([{ season: 1, episodes: 2, start: 900 }, { season: 3, episodes: 2, start: 12 }]) });
  const undated = meta("No Date", "movie", ["Drama"], { released: undefined, year: "2026" });
  const data = catalog({ newMovies: [...films, undated], newSeries: [...shows, season] });
  const all = planWhatsNew(signals(), data, "all", UTC);
  const items = all.flatMap((section) => section.items);
  assert.ok(!keys(items).includes(keyOf(undated)));
  const week = all.find((section) => section.id === "this-week")!;
  assert.deepEqual(week.items.map((item) => item.name), ["Fresh Film 1", "Fresh Show 1"]);
  assert.equal(week.badges[keyOf(films[0])], "Yesterday");
  assert.equal(all.find((section) => section.id === "new-seasons")?.badges[keyOf(season)], "Season 3 · Oct 7");
  const moviesOnly = planWhatsNew(signals(), data, "movie", UTC).flatMap((section) => section.items);
  assert.ok(moviesOnly.length >= 5 && moviesOnly.every((item) => item.type === "movie"));
  const seriesOnly = planWhatsNew(signals(), data, "series", UTC).flatMap((section) => section.items);
  assert.ok(seriesOnly.length >= 4 && seriesOnly.every((item) => item.type === "series"));
  const home = planHome(signals(), data, UTC);
  assert.equal(rowOf(home.rows, "whats-new")?.seeAll, "/new");
});

// --------------------------------------------------------------- engagement

const histMovie = media(scifi[0]);
const histShow = media(crime[0]);
const row = (m: HistoryTitle, patch: Partial<WatchHistoryEntry>): WatchHistoryEntry => ({ profileId: "p", media: m, position: 10, duration: 100, progress: 10, completed: false, updatedAt: NOW, ...patch });

test("engagement: finishing and restarting a film counts plays and rewatches", () => {
  assert.deepEqual(watchEvents(row(histMovie, { progress: 50 }), row(histMovie, { completed: true, progress: 100 })), ["finished"]);
  assert.deepEqual(watchEvents(row(histMovie, { completed: true, progress: 100 }), row(histMovie, { progress: 3 })), ["restarted"]);
  assert.deepEqual(watchEvents(row(histMovie, { progress: 3 }), row(histMovie, { progress: 9 })), []);
  let stats = emptyEngagement("p", histMovie, NOW);
  stats = applyWatchEvents(stats, ["finished"], NOW, "movie");
  stats = applyWatchEvents(stats, ["restarted"], NOW + DAY, "movie");
  stats = applyWatchEvents(stats, ["restarted"], NOW + DAY + 3600_000, "movie");
  assert.equal(stats.plays, 1);
  assert.equal(stats.rewatches, 1, "restarting twice within hours is one rewatch");
});

test("engagement: three episodes within eight hours is one binge session", () => {
  const at = (h: number) => NOW + h * 3600_000;
  assert.deepEqual(watchEvents(row(histShow, { season: 1, episode: 1, progress: 97 }), row(histShow, { season: 1, episode: 2, position: 0, progress: 0 }), true), ["finished"]);
  assert.deepEqual(watchEvents(row(histShow, { season: 1, episode: 4 }), row(histShow, { season: 1, episode: 2 })), ["restarted"]);
  let stats = emptyEngagement("p", histShow, NOW);
  for (const hour of [0, 1, 2, 3]) stats = applyWatchEvents(stats, ["finished"], at(hour), "series");
  assert.equal(stats.plays, 4);
  assert.equal(stats.binges, 1, "the fourth episode is the same session");
  for (const hour of [30, 31, 32]) stats = applyWatchEvents(stats, ["finished"], at(hour), "series");
  assert.equal(stats.binges, 2);
});

function withStorage<T>(run: () => T): T {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() { return values.size; },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    },
  });
  try {
    return run();
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

test("engagement: the history store records finishes as they happen", () => {
  withStorage(() => {
    useHistory.setState({ entries: [], ratings: [] });
    useEngagement.setState({ rows: [] });
    const movie: HistoryTitle = { source: "discover", id: "tt0133093", type: "movie", name: "The Matrix" };
    useHistory.getState().recordProgress(movie, 600, 8160);
    useHistory.getState().recordProgress(movie, 8100, 8160);
    useHistory.getState().recordProgress(movie, 60, 8160);
    const [stats] = useEngagement.getState().rows;
    assert.equal(stats.plays, 1);
    assert.equal(stats.rewatches, 1);
    const jellyfin: HistoryTitle = { source: "jellyfin", id: "abc", type: "movie", name: "Local" };
    useHistory.getState().recordProgress(jellyfin, 8100, 8160);
    assert.equal(useEngagement.getState().rows.length, 1, "only catalogue titles (they sync by id)");
  });
});

// ------------------------------------------------------------------- sync

const cloudTitle = (patch: Partial<CloudTitle>): CloudTitle => ({ key: "series:tt0387199", type: "series", id: "tt0387199", meta: { name: "Entourage" }, ...patch });

test("engagement sync: the engage facet round-trips and merges last-writer-wins", () => {
  const title = cloudTitle({ engage: { at: 1760744000123, plays: 12, rewatches: 1, binges: 3, lastFinishedAt: 1760744000000 } });
  const back = titleFromDoc(fromFields(JSON.parse(JSON.stringify(toFields(titleToDoc(title))))))!;
  assert.deepEqual(back.engage, title.engage);
  const older = cloudTitle({ engage: { at: 10, plays: 1, rewatches: 0, binges: 0 } });
  const newer = cloudTitle({ engage: { at: 20, plays: 4, rewatches: 0, binges: 1 } });
  assert.equal(mergeTitles(older, newer)?.engage?.plays, 4);
  assert.equal(mergeTitles(newer, older)?.engage?.plays, 4);
  assert.notEqual(fingerprint(older), fingerprint(newer), "a change in counts is synced");
});

test("engagement sync: a Roku watch update keeps the counts, and the cloud copy reaches this device", () => {
  const local = localTitles("p", {
    entries: [],
    ratings: [],
    list: [],
    engagement: [{ profileId: "p", media: { source: "discover", id: "tt0387199", type: "series", name: "Entourage" }, plays: 5, rewatches: 0, binges: 1, at: 100 }],
    journal: { watchRemoved: {}, ratingCleared: {} },
  }).get("series:tt0387199")!;
  // The Roku writes only `watch` (with an update mask); the doc keeps `engage`.
  const roku = cloudTitle({ watch: { at: 200, position: 5, duration: 1500, progress: 1, completed: false, season: 7, episode: 4 } });
  const merged = mergeTitles(local, roku)!;
  assert.equal(merged.engage?.plays, 5);
  assert.equal(merged.watch?.episode, 4);
  const patch = emptyPatch();
  collectLocalChanges("p", cloudTitle({ engage: { at: 300, plays: 9, rewatches: 2, binges: 2 } }), local, patch);
  assert.equal(patch.engagement.length, 1);
  assert.equal(patch.engagement[0].plays, 9);
  // Older documents without the facet still parse.
  assert.equal(titleFromDoc({ type: "movie", id: "tt1", meta: { name: "x" } })?.engage, undefined);
});

// ------------------------------------------------------------------ feeds

test("discovery feeds: responses are trimmed to what discovery uses", () => {
  const raw = {
    id: "tt1", type: "series", name: "Show", poster: "p", background: "b", description: "x".repeat(900), genre: ["Drama"], trailers: [{ source: "abc" }],
    links: [{ name: "x" }], behaviorHints: {}, popularities: { trakt: 10, moviedb: 2.12345, stremio: 1, stremio_lib: 0 }, popularity: 1.234567,
    cast: ["a", "b", "c", "d", "e", "f", "g", "h"], released: "2020-01-01T00:00:00.000Z",
    videos: showVideos([{ season: 1, episodes: 6, start: 900 }, { season: 2, episodes: 6, start: 500 }, { season: 3, episodes: 6, start: 100 }, { season: 4, episodes: 6, start: 10 }]),
  } as unknown as StremioMeta;
  const trimmed = trimMeta(raw);
  assert.equal(trimmed.description?.length, 320);
  assert.deepEqual(trimmed.genres, ["Drama"]);
  assert.equal(trimmed.cast?.length, 6);
  assert.deepEqual(trimmed.popularities, { trakt: 10, moviedb: 2.12 });
  assert.equal((trimmed as Record<string, unknown>).trailers, undefined);
  assert.deepEqual(trimmed.videos?.map((v) => `${v.season}x${v.episode}`), ["2x1", "2x6", "3x1", "3x6", "4x1", "4x6"]);
  assert.equal(trimMeta(raw, "all").videos?.length, 24);
});

test("discovery feeds: a failing feed means fewer rows, and the cache answers offline", async () => {
  const values = new Map<string, string>();
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() { return values.size; },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    },
  });
  const original = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (url: string) => {
    requested.push(String(url));
    if (String(url).includes("/series/top")) return new Response("down", { status: 503 });
    if (String(url).includes("/movie/top.json")) return new Response(JSON.stringify({ metas: comedy.slice(0, 3) }));
    if (String(url).includes("calendar-videos")) return new Response(JSON.stringify({ metasDetailed: [{ ...crime[0], videos: showVideos([{ season: 1, episodes: 2, start: 3 }]) }] }));
    return new Response(JSON.stringify({ metas: [] }));
  }) as typeof fetch;
  try {
    const input = signals({ now: Date.now(), history: [watching(crime[0], 1, 1, 0, 50)] });
    const first = await loadDiscovery(input);
    assert.equal(first.complete, false, "the failed feed is reported");
    assert.deepEqual(first.data.trendingSeries, []);
    assert.equal(first.data.trendingMovies.length, 3);
    assert.ok(first.data.calendar[crime[0].id]?.videos?.length);
    assert.ok(requested.some((url) => url.includes(`calendarVideosIds=${crime[0].id}`)));
    assert.ok([...values.keys()].every((key) => key.startsWith(DISCOVERY_CACHE_PREFIX) || !key.startsWith("akflix.catalog")));
    const count = requested.length;
    const offline = await loadDiscovery(input, { network: false });
    assert.equal(requested.length, count, "cache-only loads never touch the network");
    assert.equal(offline.data.trendingMovies.length, 3);
  } finally {
    globalThis.fetch = original;
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test("Recommended for You keeps its API and now uses the taste engine", () => {
  const picks = recommendedTitles(ALL, [finished(crime[0], 1)], [rated(crime[1], 5)], 10);
  assert.equal(picks.length, 10);
  assert.ok(!keys(picks).includes(keyOf(crime[0])) && !keys(picks).includes(keyOf(crime[1])));
  assert.ok(picks.slice(0, 5).every((item) => item.genres?.includes("Crime")), picks.map((item) => item.name).join(","));
});
