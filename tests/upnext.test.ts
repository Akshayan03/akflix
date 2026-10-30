// Next episode / Watch credits / Skip recap / Skip intro on a first episode:
// the online timestamp databases (src/lib/skip/online.ts), the credits card's
// timing, the countdown and autoplay rules (src/lib/skip/markers.ts), and the
// cold start: markers before playback, with nothing played before.
// Shared by akflixmac and akflixios (identical copies).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ONLINE_MISS_TTL_MS,
  combineOnlineParts,
  introDbUrl,
  onlineLookupFor,
  onlineParts,
  partsFromIntroDb,
  partsFromTheIntroDb,
  theIntroDbUrl,
  type OnlineParts,
} from "../src/lib/skip/online";
import {
  FALLBACK_CARD_SECONDS,
  NEXT_COUNTDOWN_SECONDS,
  STILL_WATCHING_AFTER,
  autoplayAtEnd,
  creditsCard,
  nextCountdown,
  type SkipMarkers,
} from "../src/lib/skip/markers";
import { SkipMemory, type SkipStorage } from "../src/lib/skip/cache";
import { analyzeSkipMarkers } from "../src/lib/skip/detector";

class MemoryStorage implements SkipStorage {
  map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

// Real answers (2026-10-30) for Desperate Housewives S1E2 and Breaking Bad S2E2.
const DH_THEINTRODB = {
  tmdb_id: 693, type: "tv", season: 1, episode: 2,
  intro: [{ start_ms: 198000, end_ms: 237000 }],
  recap: [{ start_ms: 1000, end_ms: 42000 }],
  credits: [{ start_ms: 2580000, end_ms: null }],
};
const DH_INTRODB = {
  imdb_id: "tt0410975", media_type: "tv", is_movie: false, season: 1, episode: 2,
  intro: { start_sec: 202, end_sec: 240, start_ms: 202000, end_ms: 240000 },
  recap: { start_sec: 12, end_sec: 53, start_ms: 12000, end_ms: 53000 },
  outro: { start_sec: 2472, end_sec: 2510, start_ms: 2472000, end_ms: 2510000 },
  post_credits: null, no_intro: false, no_recap: false, no_outro: false,
};
const BB_THEINTRODB = {
  tmdb_id: 1396, type: "tv", season: 2, episode: 2,
  intro: [{ start_ms: 77994, end_ms: 95191 }],
  credits: [{ start_ms: 2828165, end_ms: 2881880 }],
};
const BB_INTRODB = {
  imdb_id: "tt0903747", media_type: "tv", season: 2, episode: 2,
  intro: { start_sec: 78, end_sec: 94, start_ms: 78000, end_ms: 94000 },
  recap: null,
  outro: { start_sec: 2826, end_sec: 2886, start_ms: 2826000, end_ms: 2886000 },
};

test("lookups: IMDb episodes and movies only, both database URLs", () => {
  assert.deepEqual(onlineLookupFor("tt0903747", 2, 2), { imdbId: "tt0903747", season: 2, episode: 2 });
  assert.deepEqual(onlineLookupFor("tt15398776"), { imdbId: "tt15398776" });
  assert.equal(onlineLookupFor("jellyfin-series-id", 1, 1), null);
  assert.equal(onlineLookupFor("release:abc", 1, 1), null);
  assert.equal(onlineLookupFor("tt0903747", 0, 1), null);
  assert.equal(
    theIntroDbUrl({ imdbId: "tt0903747", season: 2, episode: 2 }),
    "https://api.theintrodb.org/v2/media?imdb_id=tt0903747&season=2&episode=2"
  );
  assert.equal(
    introDbUrl({ imdbId: "tt0903747", season: 2, episode: 2 }),
    "https://api.introdb.app/segments?imdb_id=tt0903747&season=2&episode=2"
  );
  assert.equal(introDbUrl({ imdbId: "tt15398776" }), "https://api.introdb.app/segments?imdb_id=tt15398776&is_movie=true");
});

test("parsing both databases (null start = 0, null end = runs to the end, outro = credits)", () => {
  assert.deepEqual(partsFromTheIntroDb(DH_THEINTRODB), {
    intro: { start: 198, end: 237 },
    recap: { start: 1, end: 42 },
    credits: { start: 2580, end: null },
  });
  assert.deepEqual(partsFromTheIntroDb({ intro: [{ start_ms: null, end_ms: 31000 }] }), { intro: { start: 0, end: 31 } });
  assert.deepEqual(partsFromTheIntroDb({ error: "no submissions for this media" }), {});
  assert.deepEqual(partsFromIntroDb(DH_INTRODB), {
    intro: { start: 202, end: 240 },
    recap: { start: 12, end: 53 },
    credits: { start: 2472, end: 2510 },
  });
  assert.deepEqual(partsFromIntroDb({ intro: null, recap: null, outro: null }), {});
  assert.deepEqual(partsFromIntroDb(null), {});
});

test("two databases: only the stretch both call the part; disagreement gives none", () => {
  const duration = 2614;
  const dh = combineOnlineParts([partsFromTheIntroDb(DH_THEINTRODB), partsFromIntroDb(DH_INTRODB)], duration);
  // Intro 198-237 vs 202-240: both agree on 202-237.
  assert.deepEqual(dh.intro, { start: 202, end: 237, source: "online" });
  // Recap 1-42 vs 12-53 (11 s apart): two different copies; never skip on that.
  assert.equal(dh.recap, undefined);
  // Credits 2580 vs 2472 (108 s apart): not the same credits.
  assert.equal(dh.credits, undefined);

  const bb = combineOnlineParts([partsFromTheIntroDb(BB_THEINTRODB), partsFromIntroDb(BB_INTRODB)], 2886);
  assert.deepEqual(bb.intro, { start: 78, end: 94, source: "online" });
  // The later credits start: the card never covers the last scene.
  assert.deepEqual(bb.credits, { start: 2828.165, end: 2886, source: "online" });
});

test("one database alone is used; credits wait for the duration and must fit the file", () => {
  const recapOnly: OnlineParts = { recap: { start: 0, end: 35 }, credits: { start: 2537, end: null } };
  assert.deepEqual(combineOnlineParts([recapOnly], 0), { recap: { start: 0, end: 35, source: "online" } });
  assert.deepEqual(combineOnlineParts([recapOnly], 2580).credits, { start: 2537, end: 2580, source: "online" });
  // A credits start past this (shorter) file's end: another cut, dropped.
  assert.equal(combineOnlineParts([recapOnly], 2540).credits, undefined);
  // TheIntroDB's "recap 0-0" (marked as none) is not a recap.
  assert.deepEqual(combineOnlineParts([{ recap: { start: 0, end: 0 } }], 2600), {});
});

test("lookups are remembered: one request per episode, misses retried after a while", async () => {
  const memory = new SkipMemory(new MemoryStorage());
  let now = 1_000_000;
  const asked: string[] = [];
  const fetchJson = async (url: string) => {
    asked.push(url);
    return url.includes("theintrodb") ? BB_THEINTRODB : BB_INTRODB;
  };
  const lookup = { imdbId: "tt0903747", season: 2, episode: 2 };
  const signal = new AbortController().signal;
  const [a, b] = await Promise.all([
    onlineParts(lookup, memory, fetchJson, signal, () => now),
    onlineParts(lookup, memory, fetchJson, signal, () => now),
  ]);
  assert.equal(asked.length, 2, "two databases, asked once for both callers");
  assert.deepEqual(a, b);
  await onlineParts(lookup, memory, fetchJson, signal, () => now);
  assert.equal(asked.length, 2, "remembered");

  const none = { imdbId: "tt0000001", season: 1, episode: 1 };
  const empty = async () => ({});
  assert.deepEqual(await onlineParts(none, memory, empty, signal, () => now), []);
  let calls = 0;
  const counting = async () => {
    calls += 1;
    return {};
  };
  await onlineParts(none, memory, counting, signal, () => now + 60_000);
  assert.equal(calls, 0, "a miss is remembered for a while");
  await onlineParts(none, memory, counting, signal, () => now + ONLINE_MISS_TTL_MS + 1);
  assert.equal(calls, 2, "then asked again");

  // Offline: nothing remembered, nothing thrown.
  const offline = async () => {
    throw new Error("offline");
  };
  assert.equal(await onlineParts({ imdbId: "tt0000002", season: 1, episode: 1 }, memory, offline, signal, () => now), null);
  assert.equal(memory.online("tt0000002:1:1"), null);
});

test("COLD START: a first episode (nothing played before) gets its markers before playback starts", async () => {
  const memory = new SkipMemory(new MemoryStorage()); // a fresh install / nothing of this season seen
  const published: Array<{ markers: SkipMarkers; playing: boolean }> = [];
  let playing = false;
  let startPlayback!: () => void;
  const started = new Promise<void>((resolve) => (startPlayback = resolve));
  const controller = new AbortController();
  const done = analyzeSkipMarkers({
    identity: { show: "tt0903747", season: 2, episode: 2, source: "x" },
    duration: () => 2886,
    memory,
    adapter: {
      chapters: async () => [],
      online: async () => [partsFromTheIntroDb(BB_THEINTRODB), partsFromIntroDb(BB_INTRODB)],
      // Audio of silence: the fingerprints find nothing (no other episode to compare with).
      pcm: async (_start, seconds) => new Int16Array(Math.round(seconds * 8000)),
    },
    audioReady: () => started,
    onMarkers: (markers) => published.push({ markers, playing }),
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(published.length >= 1, "published before playback started");
  assert.equal(published[0].playing, false);
  assert.deepEqual(published[0].markers.intro, { start: 78, end: 94, source: "online" });
  assert.equal(published[0].markers.credits?.start, 2828.165);
  playing = true;
  startPlayback();
  const final = await done;
  assert.deepEqual(final.intro, { start: 78, end: 94, source: "online" }, "audio that matches nothing keeps them");
});

test("COLD START, old behaviour kept for comparison: without the databases a first episode has nothing", async () => {
  const memory = new SkipMemory(new MemoryStorage());
  const final = await analyzeSkipMarkers({
    identity: { show: "tt0903747", season: 2, episode: 2, source: "x" },
    duration: () => 2886,
    memory,
    adapter: { chapters: async () => [], pcm: async (_start, seconds) => new Int16Array(Math.round(seconds * 8000)) },
    onMarkers: () => {},
    signal: new AbortController().signal,
  });
  assert.deepEqual(final, {});
});

test("fingerprints of this exact file beat the databases", async () => {
  const memory = new SkipMemory(new MemoryStorage());
  const identity = { show: "tt0903747", season: 2, episode: 2, source: "file" };
  memory.saveMarkers(identity, { intro: { start: 80, end: 96, source: "fingerprint" } });
  const final = await analyzeSkipMarkers({
    identity,
    duration: () => 2886,
    memory,
    adapter: { online: async () => [partsFromTheIntroDb(BB_THEINTRODB)] },
    onMarkers: () => {},
    signal: new AbortController().signal,
  });
  assert.deepEqual(final.intro, { start: 80, end: 96, source: "cache" });
  assert.equal(final.credits?.source, "online");
});

const credits = { start: 2400, end: 2600, source: "online" as const };

test("credits card: at the credits, else the fallback before the end; never for a finale", () => {
  const base = { markers: {} as SkipMarkers, duration: 2600, isEpisode: true, hasNext: true, dismissed: false };
  assert.equal(creditsCard({ ...base, markers: { credits }, time: 2399 }), null);
  assert.deepEqual(creditsCard({ ...base, markers: { credits }, time: 2400 }), { kind: "next", at: 2400, reason: "credits" });
  // Unknown credits: the last FALLBACK_CARD_SECONDS.
  assert.equal(creditsCard({ ...base, time: 2600 - FALLBACK_CARD_SECONDS - 1 }), null);
  assert.deepEqual(creditsCard({ ...base, time: 2600 - FALLBACK_CARD_SECONDS }), {
    kind: "next",
    at: 2600 - FALLBACK_CARD_SECONDS,
    reason: "fallback",
  });
  assert.equal(creditsCard({ ...base, markers: { credits }, time: 2500, hasNext: false }), null, "series finale");
  assert.equal(creditsCard({ ...base, markers: { credits }, time: 2500, dismissed: true }), null, "Watch Credits");
  assert.equal(creditsCard({ ...base, markers: { credits }, time: 2599.6 }), null, "ended");
  assert.equal(creditsCard({ ...base, markers: { credits }, time: 2500, duration: 0 }), null, "duration unknown");
  // A very short file: its last quarter.
  assert.deepEqual(creditsCard({ ...base, duration: 32, time: 24 }), { kind: "next", at: 24, reason: "fallback" });
  assert.equal(creditsCard({ ...base, duration: 32, time: 23.9 }), null);
});

test("credits card for a movie: only at known credits, Watch Credits / Back to browse", () => {
  const movie = { duration: 9000, isEpisode: false, hasNext: false, dismissed: false };
  assert.equal(creditsCard({ ...movie, markers: {}, time: 8990 }), null);
  const movieCredits = { start: 8600, end: 9000, source: "online" as const };
  assert.deepEqual(creditsCard({ ...movie, markers: { credits: movieCredits }, time: 8700 }), {
    kind: "movie",
    at: 8600,
    reason: "credits",
  });
});

test("Next Episode countdown: 10 s of playback, pauses with it, off with autoplay", () => {
  const at = { autoplay: true, streak: 0, shownAt: 2400 };
  assert.deepEqual(nextCountdown({ ...at, time: 2400 }), { left: NEXT_COUNTDOWN_SECONDS, progress: 0, stillWatching: false, due: false });
  assert.deepEqual(nextCountdown({ ...at, time: 2405 }), { left: 5, progress: 0.5, stillWatching: false, due: false });
  // Paused: media time does not move, neither does the countdown.
  assert.equal(nextCountdown({ ...at, time: 2405 }).left, 5);
  assert.equal(nextCountdown({ ...at, time: 2410 }).due, true);
  assert.deepEqual(nextCountdown({ ...at, autoplay: false, time: 2420 }), { left: null, progress: 0, stillWatching: false, due: false });
});

test("Are you still watching? after 3 episodes autoplay started with no input", () => {
  assert.equal(nextCountdown({ autoplay: true, streak: STILL_WATCHING_AFTER - 1, shownAt: 0, time: 20 }).due, true);
  const asked = nextCountdown({ autoplay: true, streak: STILL_WATCHING_AFTER, shownAt: 0, time: 20 });
  assert.equal(asked.stillWatching, true);
  assert.equal(asked.due, false);
  assert.equal(autoplayAtEnd(true, STILL_WATCHING_AFTER - 1, true), true);
  assert.equal(autoplayAtEnd(true, STILL_WATCHING_AFTER, true), false);
  assert.equal(autoplayAtEnd(false, 0, true), false);
  assert.equal(autoplayAtEnd(true, 0, false), false);
});
