import { test } from "node:test";
import assert from "node:assert/strict";
import { selectVideoFile } from "../src/lib/mediaSelection";
import { withTimeout } from "../src/lib/withTimeout";
import { CinemetaClient } from "../src/api/cinemeta";
import { balancedCatalog } from "../src/lib/catalogRanking";
import type { QbtFile } from "../src/types/torrent";

const file = (name: string, index = 0, size = 100) => ({ name, index, size } as QbtFile);

test("non-video payloads are never selected", () => {
  assert.equal(selectVideoFile([file("movie.mp4.exe"), file("movie.zip")]), null);
});
test("wrong-episode fallback is blocked", () => {
  assert.equal(selectVideoFile([file("Show.S01E02.mp4")], { season: 1, episode: 3, preferredIndex: 0 }), null);
});
test("exact episode beats a mismatched provider file index", () => {
  const wanted = file("Show.S01E03.mp4", 1);
  assert.equal(selectVideoFile([file("Show.S01E02.mp4"), wanted], { season: 1, episode: 3, preferredIndex: 0 }), wanted);
});
test("unlabelled provider-selected movie still plays", () => {
  const wanted = file("film.mp4", 1);
  assert.equal(selectVideoFile([file("sample.mp4"), wanted], { preferredIndex: 1 }), wanted);
});
test("timeouts abort requests even when a provider ignores cancellation", async () => {
  let signal: AbortSignal | undefined;
  await assert.rejects(withTimeout((value) => { signal = value; return new Promise(() => {}); }, 10), /too long/);
  assert.equal(signal?.aborted, true);
});
test("cancelled queries do not start and cannot publish stale results", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(withTimeout(async () => { called = true; }, 100, controller.signal), { name: "AbortError" });
  assert.equal(called, false);
  const active = new AbortController();
  const request = withTimeout(() => new Promise(() => {}), 1000, active.signal);
  active.abort();
  await assert.rejects(request, { name: "AbortError" });
});
test("catalog keeps movie results if the series service fails", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).includes("/movie/")
    ? new Response(JSON.stringify({ metas: [{ id: "tt0063350", type: "movie", name: "Night of the Living Dead" }] }))
    : new Response("Unavailable", { status: 503 });
  try {
    const result = await new CinemetaClient().search("  Night of the Living Dead  ");
    assert.equal(result[0].name, "Night of the Living Dead");
  } finally { globalThis.fetch = original; }
});
test("catalog failure is reported, not disguised as zero results", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("Unavailable", { status: 503 });
  try {
    await assert.rejects(new CinemetaClient().search("unavailable"), /unavailable/);
  } finally { globalThis.fetch = original; }
});
test("catalog ranking surfaces a highly-rated older title", () => {
  const result = balancedCatalog([
    { id: "new-1", type: "movie", name: "New", year: "2026", imdbRating: "6.5" },
    { id: "new-2", type: "movie", name: "New 2", year: "2026", imdbRating: "6.4" },
    { id: "old", type: "movie", name: "Classic", year: "1990", imdbRating: "9.0" },
  ]);
  assert.equal(result[0]?.name, "Classic");
});
test("cancelled catalog results stay cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(new CinemetaClient().search("cancelled", controller.signal), { name: "AbortError" });
});
