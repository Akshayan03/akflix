import { test } from "node:test";
import assert from "node:assert/strict";
import { episodeMark, resumeClock, seasonWatched, trimShows, withEpisode, withSeason, type ShowMarks } from "../src/lib/episodeMarks";
import { episodeAfter } from "../src/lib/continueActions";
import type { StremioVideo } from "../src/types/stremio";

test("an episode is watched from 90 %, part-way keeps its place, an early start is not kept", () => {
  let show = withEpisode(undefined, 1, 1, { position: 1300, duration: 1400 }, 1);
  assert.deepEqual(episodeMark(show, 1, 1), { position: 0, progress: 100, watched: true });
  show = withEpisode(show, 1, 2, { position: 600, duration: 1400 }, 2);
  assert.deepEqual(episodeMark(show, 1, 2), { position: 600, progress: 42.9, watched: false });
  show = withEpisode(show, 1, 3, { position: 4, duration: 1400 }, 3);
  assert.equal(show.episodes["1:3"], undefined);
  assert.equal(show.updatedAt, 3);
});

test("marking by hand: watched clears the resume point, unwatched clears the mark", () => {
  let show = withEpisode(undefined, 2, 5, { position: 600, duration: 1400 });
  show = withEpisode(show, 2, 5, { watched: true });
  assert.deepEqual(episodeMark(show, 2, 5), { position: 0, progress: 100, watched: true });
  show = withEpisode(show, 2, 5, { watched: false });
  assert.deepEqual(episodeMark(show, 2, 5), { position: 0, progress: 0, watched: false });
  assert.deepEqual(show.episodes, {});
});

test("a whole season at once", () => {
  const show: ShowMarks = withSeason(undefined, 3, [1, 2, 3], true);
  assert.equal(seasonWatched(show, 3, [1, 2, 3]), true);
  assert.equal(seasonWatched(show, 3, [1, 2, 3, 4]), false);
  assert.equal(seasonWatched(show, 4, []), false);
  assert.equal(seasonWatched(withSeason(show, 3, [1, 2, 3], false), 3, [1, 2, 3]), false);
});

test("the record keeps the shows changed last", () => {
  const shows: Record<string, ShowMarks> = {};
  for (let i = 0; i < 5; i += 1) shows[`p|tt${i}`] = { episodes: {}, updatedAt: i };
  assert.deepEqual(Object.keys(trimShows(shows, 2)).sort(), ["p|tt3", "p|tt4"]);
});

test("resume clock and the episode after (seasons roll over, specials skipped)", () => {
  assert.equal(resumeClock(812.4), "13:32");
  assert.equal(resumeClock(3725), "1:02:05");
  const v = (season: number, episode: number) => ({ id: `x:${season}:${episode}`, season, episode } as StremioVideo);
  const videos = [v(2, 1), v(0, 1), v(1, 2), v(1, 1)];
  assert.equal(episodeAfter(videos, 1, 2)?.id, "x:2:1");
  assert.equal(episodeAfter(videos, 1, 1)?.id, "x:1:2");
  assert.equal(episodeAfter(videos, 2, 1), null);
});

test("Continue Watching cards have Play (straight into the player) instead of Mark as watched", async () => {
  const { readFileSync } = await import("node:fs");
  const home = readFileSync("src/pages/Home.tsx", "utf8");
  assert.match(home, /\?play=1/);
  assert.doesNotMatch(home, /Mark\$\{episode\} as watched/);
  const details = readFileSync("src/pages/DiscoverDetails.tsx", "utf8");
  assert.match(details, /searchParams\.get\("play"\) !== "1"/);
  assert.match(details, /watchNowRef\.current = \(\) => void watchNow\(\);/);
});
