import "./design-system.test";
import "./storage.test";
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectVideoFile, sourceNamesAnotherShow } from "../src/lib/mediaSelection";
import { classifySourceLanguage } from "../src/lib/sourceLanguage";
import { withTimeout } from "../src/lib/withTimeout";
import { CinemetaClient } from "../src/api/cinemeta";
import { balancedCatalog } from "../src/lib/catalogRanking";
import type { QbtFile } from "../src/types/torrent";
import { RqbitClient } from "../src/api/rqbit";
import { useTorrents } from "../src/stores/torrentStore";
import { convertedSeekTime } from "../src/lib/compatSeek";
import { preferRememberedSource, rememberSource, rememberedSource } from "../src/lib/sourceMemory";

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

// ── Embedded engine orchestration (fake rqbit HTTP API) ─────────────────────

const storage = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, String(value)),
  removeItem: (key: string) => void storage.delete(key),
};
const MODES = "akflix.embedded-torrent-modes";
const HASH = "a".repeat(40);
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Show`;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const engineError = (message: string, status = 400) =>
  json({ error_kind: "internal_error", human_readable: message, status }, status);

type EngineCall = { method: string; path: string; search: string; body?: string };
async function withEngine(
  handler: (call: EngineCall) => Response | Promise<Response>,
  run: (calls: EngineCall[]) => Promise<void>
) {
  const calls: EngineCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const call = {
      method: init.method ?? "GET",
      path: url.pathname,
      search: url.search,
      body: typeof init.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  storage.clear();
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const details = (hash: string, extra: Record<string, unknown> = {}) => ({
  info_hash: hash,
  name: "Show S01",
  output_folder: "/Volumes/Media/Akflix Media/Show S01",
  files: [{ name: "Show.S01E01.mp4", length: 100, included: true }],
  ...extra,
});

test("a paused engine torrent is resumed instead of re-added before streaming", async () => {
  let state = "paused";
  await withEngine((call) => {
    if (call.method === "GET" && call.path === `/torrents/${HASH}`) return json(details(HASH));
    if (call.path === `/torrents/${HASH}/stats/v1`) return json({ state });
    if (call.method === "POST" && call.path === `/torrents/${HASH}/start`) {
      state = "live";
      return json({});
    }
    if (call.method === "POST" && call.path === "/torrents") return json({ details: details(HASH) });
    return json({}, 404);
  }, async (calls) => {
    await new RqbitClient("http://engine").add(MAGNET, "stream");
    assert.equal(state, "live");
    assert.ok(!calls.some((call) => call.method === "POST" && call.path === "/torrents"));
  });
});

test("every add attempt gets a private folder so leftovers never collide", async () => {
  await withEngine((call) => {
    if (call.method === "GET" && call.path === `/torrents/${HASH}`) return json({}, 404);
    if (call.method === "POST" && call.path === "/torrents") {
      const query = new URLSearchParams(call.search);
      if (query.get("overwrite") !== "false" || !/^akflix-rqbit-[0-9a-f]{32}$/.test(query.get("sub_folder") ?? "")) {
        return engineError('error adding torrent: error creating a new file (because allow_overwrite = false) "/m/Show.mp4": File exists (os error 17)');
      }
      return json({ details: details(HASH, { output_folder: `/m/${query.get("sub_folder")}` }) });
    }
    return json({}, 404);
  }, async (calls) => {
    await new RqbitClient("http://engine").add(MAGNET, "stream");
    const adds = calls.filter((call) => call.method === "POST" && call.path === "/torrents");
    assert.equal(adds.length, 1);
    assert.ok(Number(new URLSearchParams(adds[0].search).get("timeout_ms")) > 0);
  });
});

test("keeping a copy upgrades a running stream and streaming never downgrades a download", async () => {
  await withEngine((call) => {
    if (call.method === "GET" && call.path === `/torrents/${HASH}`) return json(details(HASH));
    if (call.path === `/torrents/${HASH}/stats/v1`) return json({ state: "live" });
    if (call.method === "POST" && call.path === "/torrents") return json({ details: details(HASH) });
    return json({}, 404);
  }, async () => {
    storage.set(MODES, JSON.stringify({ [HASH]: "stream" }));
    const client = new RqbitClient("http://engine");
    await client.add(MAGNET, "download");
    assert.equal(JSON.parse(storage.get(MODES)!)[HASH], "download");
    await client.add(MAGNET, "stream");
    assert.equal(JSON.parse(storage.get(MODES)!)[HASH], "download");
  });
});

test("watching one episode keeps the rest of an offline season download", async () => {
  let onlyFiles: number[] = [];
  await withEngine((call) => {
    if (call.path === `/torrents/${HASH}`) {
      return json(details(HASH, {
        files: [
          { name: "Show.S01E01.mp4", length: 100, included: true },
          { name: "Show.S01E02.mp4", length: 100, included: true },
          { name: "Show.S01E03.mp4", length: 100, included: true },
        ],
      }));
    }
    if (call.path === `/torrents/${HASH}/stats/v1`) return json({ state: "live", file_progress: [0, 0, 0] });
    if (call.path === `/torrents/${HASH}/update_only_files`) {
      onlyFiles = JSON.parse(call.body ?? "{}").only_files;
      return json({});
    }
    return json({}, 404);
  }, async () => {
    storage.set(MODES, JSON.stringify({ [HASH]: "download" }));
    const selected = await new RqbitClient("http://engine").prioritizeVideoFile(HASH, undefined, { season: 1, episode: 2 });
    assert.equal(selected?.index, 1);
    assert.deepEqual([...onlyFiles].sort(), [0, 1, 2]);
  });
});

test("startup cleanup runs once when polls overlap and one stuck session cannot block listing", async () => {
  const stuck = "b".repeat(40);
  const offline = "c".repeat(40);
  const present = new Set([HASH, stuck, offline]);
  const deletes: string[] = [];
  await withEngine(async (call) => {
    if (call.path === "/torrents" && call.method === "GET") {
      return json({ torrents: [...present].map((hash) => details(hash, { stats: { state: "live" } })) });
    }
    const match = call.path.match(/^\/torrents\/([0-9a-f]{40})(?:\/(.*))?$/);
    if (!match) return json({}, 404);
    const [, hash, action] = match;
    if (call.method === "POST" && action === "delete") {
      deletes.push(hash);
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (!present.has(hash)) return engineError("error deleting torrent with files: no such torrent in db", 500);
      if (hash === stuck) return engineError("error deleting torrent with files: busy", 500);
      present.delete(hash);
      return json({});
    }
    if (action === "stats/v1") return json({ state: "live" });
    return present.has(hash) ? json(details(hash)) : json({}, 404);
  }, async () => {
    storage.set(MODES, JSON.stringify({ [offline]: "download" }));
    const client = new RqbitClient("http://engine");
    await Promise.all([client.optimizeForStreaming(), client.optimizeForStreaming()]);
    assert.equal(deletes.filter((hash) => hash === HASH).length, 1);
    const listed = (await client.list()).map((torrent) => torrent.hash);
    assert.deepEqual(listed, [offline]);
  });
});

test("deleting a stream in its own folder never removes same-named media", async () => {
  const removed: string[][] = [];
  const g = globalThis as Record<string, unknown>;
  g.window = { __TAURI_INTERNALS__: {} };
  g.__testInvoke = async (command: string, args: { relativePaths?: string[] }) => {
    if (command === "remove_embedded_media_files") removed.push(args.relativePaths ?? []);
  };
  const folder = `akflix-rqbit-${"0".repeat(32)}`;
  try {
    await withEngine((call) => {
      if (call.path === `/torrents/${HASH}`) {
        return json(details(HASH, { output_folder: `/Volumes/Media/Akflix Media/${folder}` }));
      }
      if (call.path === `/torrents/${HASH}/stats/v1`) return json({ state: "live" });
      if (call.method === "POST" && call.path === `/torrents/${HASH}/delete`) return json({});
      return json({}, 404);
    }, async () => {
      await new RqbitClient("http://engine").delete(HASH, true);
      assert.deepEqual(removed, [[folder]]);
    });
  } finally {
    delete g.window;
  }
});

test("a full engine disk stops the source race at the first source with a clear reason", async () => {
  const results = [1, 2, 3].map((n) => ({
    guid: `${String(n).repeat(40)}:0`,
    title: `Show S01E01 1080p ${n}`,
    indexer: "test",
    size: 1_000,
    seeders: 50,
    leechers: 0,
    magnetUrl: `magnet:?xt=urn:btih:${String(n).repeat(40)}&dn=Show`,
    fileIndex: 0,
  }));
  await withEngine((call) => {
    if (call.method === "GET" && call.path === "/torrents") return json({ torrents: [] });
    if (call.method === "POST" && call.path === "/torrents") {
      return engineError('error adding torrent: error writing "/Users/x/Library/Application Support/com.akshayan.akflix/Engine/session.json.tmp": No space left on device (os error 28)');
    }
    return json({}, 404);
  }, async (calls) => {
    await assert.rejects(
      useTorrents.getState().raceStreamSources(results, { title: "Show" }),
      /disk that holds its playback data is full/
    );
    assert.equal(calls.filter((call) => call.method === "POST" && call.path === "/torrents").length, 1);
  });
});

test("choosing Keep offline during playback survives closing the player", async () => {
  const deleted: string[] = [];
  await withEngine((call) => {
    if (call.method === "GET" && call.path === "/torrents") {
      return json({ torrents: [details(HASH, { stats: { state: "live" } })] });
    }
    if (call.path === `/torrents/${HASH}`) return json(details(HASH));
    if (call.path === `/torrents/${HASH}/stats/v1`) return json({ state: "live" });
    if (call.method === "POST" && call.path === `/torrents/${HASH}/delete`) {
      deleted.push(HASH);
      return json({});
    }
    if (call.method === "POST" && call.path === "/torrents") return json({ details: details(HASH) });
    return json({}, 404);
  }, async () => {
    storage.set(MODES, JSON.stringify({ [HASH]: "stream" }));
    useTorrents.setState({ activeStreamHash: HASH, activeStreamTemporary: true });
    await useTorrents.getState().addTorrent({
      guid: `${HASH}:0`, title: "Show", indexer: "test", size: 100, seeders: 9, leechers: 0, magnetUrl: MAGNET,
    }, "download");
    await useTorrents.getState().finishActiveStream();
    assert.deepEqual(deleted, []);
  });
});

// File paths below are the real pack paths and Torrentio rows returned for
// Game of Thrones / The Walking Dead on 2026-10-12 (metadata only).
const TALES = "Xtras - Tales of the Walking Dead S01 (2022- 360p re-webrip)/Tales of the Walking Dead S01E01 Evie - Joe.mp4";

test("a spin-off file inside a pack never plays as the requested show", () => {
  const files = [file("The Walking Dead S11E01 Acheron Part I.mp4", 0), file(TALES, 25)];
  assert.equal(selectVideoFile(files, { season: 1, episode: 1, preferredIndex: 25, title: "The Walking Dead" }), null);
  assert.equal(selectVideoFile([file("Fear the Walking Dead S01E01 Pilot.mkv")], { season: 1, episode: 1, title: "The Walking Dead" }), null);
  // Without a title the old behaviour is unchanged.
  assert.equal(selectVideoFile(files, { season: 1, episode: 1, preferredIndex: 25 })?.index, 25);
});

test("real season-pack paths for the requested show stay selectable", () => {
  const cases: Array<[string, string, number, number]> = [
    ["Game of Thrones", "[TorrentCouch.net].Game.of.Thrones.S08E03.720p.AMZN.WEB-DL.x264.mp4", 8, 3],
    ["Game of Thrones", "Game of Thrones - Season 1/GOT E01/Game of Thrones S01E01 - HDTVRip 720p x264.mp4", 1, 1],
    ["Game of Thrones", "Game.Of.Thrones.Season.1-4.Complete.720p.x264.Arabic-sub/Game of Thrones - Season 4/game.of.thronesS04E09 HDTV x264-KILLERS.mp4", 4, 9],
    ["The Walking Dead", "1.The.Walking.Dead.S01.Season.1.720p.BluRay.x264.anoXmous/01/The.Walking.Dead.S01E01.720p.BluRay.x264.anoXmous_.mp4", 1, 1],
    ["The Walking Dead", "The.Walking.Dead.(2015).S06.720p.NF.Web-DL.[TR-EN].DDP5.1.H.264-TURG/The.Walking.Dead.(2015).S06E16.720p.NF.Web-DL.[TR-EN].DDP5.1.H.264-TURG.mkv", 6, 16],
    ["The Walking Dead", "The Walking Dead Season 6/The Walking Dead S06E16 Last Day on Earth.mp4", 6, 16],
    ["The Walking Dead", "The Walking Dead S11E24 Rest in Peace.mp4", 11, 24],
  ];
  for (const [title, name, season, episode] of cases) {
    assert.equal(selectVideoFile([file(name, 3)], { season, episode, preferredIndex: 3, title })?.name, name, name);
  }
});

test("a provider row pointing at a spin-off file is recognised before it is added", () => {
  const row = {
    title: `The Walking Dead Season 11 + Tales of Season 1 - threesixtyp\n${TALES}\n👤 27 💾 133.2 MB ⚙️ ThePirateBay`,
    fileNameHint: "Tales of the Walking Dead S01E01 Evie - Joe.mp4",
  };
  assert.equal(sourceNamesAnotherShow(row, "The Walking Dead"), true);
  assert.equal(sourceNamesAnotherShow({
    title: "The Walking Dead Season 11 + Tales of Season 1 - threesixtyp\nThe Walking Dead S11E24 Rest in Peace.mp4\n👤 27",
  }, "The Walking Dead"), false);
});

test("dubbed and voice-over releases without ISO tags are not treated as English", () => {
  assert.equal(classifySourceLanguage("Игра престолов / Game of Thrones [S01-08] (2011-2019) BDRip-AVC от DZgas | КПК | LostFilm"), "non-english");
  assert.equal(classifySourceLanguage("The Walking Dead *2010-2022* ((SEZON 1-11)) [1080p.BluRay.WEB.x264-MIX] [Lektor PL]"), "non-english");
  assert.equal(classifySourceLanguage("Game.of.Thrones.S01.1080p.BluRay.x265-RARBG"), "unknown");
  assert.equal(classifySourceLanguage("Game Of Thrones - Season 1 to 6 (Eng Subs) - Mp4 1080p"), "english");
});

test("a source without the requested episode fails over instead of downloading the whole pack", async () => {
  await withEngine((call) => {
    if (call.path === `/torrents/${HASH}`) {
      return json(details(HASH, {
        files: [
          { name: "The Walking Dead S11E01 Acheron Part I.mp4", length: 100, included: true },
          { name: TALES, length: 100, included: true },
        ],
      }));
    }
    if (call.path === `/torrents/${HASH}/stats/v1`) return json({ state: "live" });
    return json({}, 404);
  }, async (calls) => {
    useTorrents.setState({
      streamRequestId: 41,
      pendingStreamHash: HASH,
      pendingStreamFileIndex: 1,
      pendingStreamFileName: null,
      pendingStreamMedia: { title: "The Walking Dead", season: 1, episode: 1, isEpisode: true },
    });
    await assert.rejects(
      useTorrents.getState().prepareStreamFile(41),
      /doesn't contain a playable video for The Walking Dead S1 E1/
    );
    assert.ok(!calls.some((call) => call.path.endsWith("/update_only_files")));
  });
});

const seekable = (...ranges: [number, number][]) => ({
  length: ranges.length,
  start: (index: number) => ranges[index][0],
  end: (index: number) => ranges[index][1],
});

test("a skip into what the converter already produced moves the playhead instead of restarting", () => {
  // Conversion started at 40 s and has produced up to 30 s of its own clock.
  assert.equal(convertedSeekTime(seekable([0, 30]), 40, 56), 16);
  assert.equal(convertedSeekTime(seekable([0, 30]), 40, 45), 5);
});

test("a skip past the converted end or before the conversion start restarts the converter", () => {
  assert.equal(convertedSeekTime(seekable([0, 30]), 40, 80), null);
  assert.equal(convertedSeekTime(seekable([0, 30]), 40, 35), null);
  assert.equal(convertedSeekTime(seekable(), 40, 41), null);
});

test("a freshly loaded stream's infinite seekable end never counts as converted", () => {
  // WebKit reports [0, Infinity] at loadedmetadata, before any video exists.
  assert.equal(convertedSeekTime(seekable([0, Infinity]), 166, 286), null);
});

test("resuming an episode tries the release that last played it first", () => {
  const releases = [{ hash: "aaa" }, { hash: "bbb" }, { hash: "ccc" }];
  const hashOf = (release: { hash: string }) => release.hash;
  assert.deepEqual(preferRememberedSource(releases, hashOf, "ccc").map(hashOf), ["ccc", "aaa", "bbb"]);
  assert.deepEqual(preferRememberedSource(releases, hashOf, "zzz").map(hashOf), ["aaa", "bbb", "ccc"]);
  assert.deepEqual(preferRememberedSource(releases, hashOf, null).map(hashOf), ["aaa", "bbb", "ccc"]);
});

test("the remembered release is per episode and a full storage never throws", () => {
  const globals = globalThis as Record<string, unknown>;
  const previous = globals.localStorage;
  const items = new Map<string, string>();
  let full = false;
  globals.localStorage = {
    get length() { return items.size; },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (full) { const error = new Error("full"); error.name = "QuotaExceededError"; throw error; }
      items.set(key, value);
    },
    removeItem: (key: string) => void items.delete(key),
  };
  try {
    const s7e4 = { catalogId: "tt0387199", season: 7, episode: 4 };
    rememberSource(s7e4, "1521977F8AFBBDB42649B0B9E15E0C4CDD3C05A2");
    assert.equal(rememberedSource(s7e4), "1521977f8afbbdb42649b0b9e15e0c4cdd3c05a2");
    assert.equal(rememberedSource({ ...s7e4, episode: 5 }), null);
    assert.equal(rememberedSource({ season: 7, episode: 4 }), null);
    full = true;
    assert.doesNotThrow(() => rememberSource({ ...s7e4, episode: 6 }, "abc"));
  } finally {
    globals.localStorage = previous;
  }
});
