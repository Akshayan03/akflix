import { test } from "node:test";
import assert from "node:assert/strict";
import { decideStart, orderForStartup, START_LIMITS, startStage, startupScore, type StartSnapshot } from "../src/lib/streamStart";
import { rememberSource } from "../src/lib/sourceMemory";
import { useTorrents } from "../src/stores/torrentStore";
import { useSettings } from "../src/stores/settingsStore";
import type { QbtTorrent, TorrentResult } from "../src/types/torrent";

const T0 = 1_000_000;
const snapshot = (over: Partial<StartSnapshot> = {}): StartSnapshot => ({
  now: T0,
  startedAt: T0,
  requestStartedAt: T0,
  fileSelected: true,
  peers: 0,
  firstByte: false,
  fallbacks: 3,
  ...over,
});

test("a source with nobody sharing it is replaced after the no-peers deadline", () => {
  assert.equal(decideStart(snapshot({ now: T0 + START_LIMITS.noPeersMs - 1 })).kind, "wait");
  const late = decideStart(snapshot({ now: T0 + START_LIMITS.noPeersMs }));
  assert.equal(late.kind, "failover");
  assert.match((late as { reason: string }).reason, /Nobody is sharing/);
});

test("the stall check keeps applying after a trickle (it used to run once at 10 s)", () => {
  assert.equal(decideStart(snapshot({ now: T0 + 10_000, peers: 1 })).kind, "wait");
  assert.equal(decideStart(snapshot({ now: T0 + START_LIMITS.noFirstByteMs + 5_000, peers: 1 })).kind, "failover");
  // Receiving data: the opening piece is on its way, so it gets longer before moving on.
  const receiving = { peers: 22, downloadBps: 2_000_000 };
  assert.equal(decideStart(snapshot({ now: T0 + START_LIMITS.noFirstByteMs + 5_000, ...receiving })).kind, "wait");
  assert.equal(decideStart(snapshot({ now: T0 + START_LIMITS.receivingNoFirstByteMs + 1_000, ...receiving })).kind, "failover");
});

test("the last source ends the attempt with a reason (it used to be cancelled silently at 30 s or never)", () => {
  assert.equal(decideStart(snapshot({ fallbacks: 0, now: T0 + START_LIMITS.noPeersMs })).kind, "wait");
  assert.equal(decideStart(snapshot({ fallbacks: 0, now: T0 + START_LIMITS.lastSourceNoPeersMs })).kind, "give-up");
  assert.equal(decideStart(snapshot({ fallbacks: 0, peers: 2, now: T0 + START_LIMITS.lastSourceNoFirstByteMs })).kind, "give-up");
});

test("a missing file list counts as a stall, served bytes never do, and Play has a total budget", () => {
  assert.match((decideStart(snapshot({ fileSelected: false, now: T0 + START_LIMITS.noPeersMs })) as { reason: string }).reason, /file list/);
  assert.equal(decideStart(snapshot({ firstByte: true, now: T0 + 600_000 })).kind, "wait");
  const budget = decideStart(snapshot({ startedAt: T0 + START_LIMITS.requestBudgetMs - 1_000, now: T0 + START_LIMITS.requestBudgetMs }));
  assert.equal(budget.kind, "give-up");
});

test("the status card names the stage", () => {
  assert.equal(startStage({ hasTorrent: false, fileSelected: false, peers: 0, firstByte: false }), "source");
  assert.equal(startStage({ hasTorrent: true, fileSelected: false, peers: 0, firstByte: false }), "files");
  assert.equal(startStage({ hasTorrent: true, fileSelected: true, peers: 0, firstByte: false }), "peers");
  assert.equal(startStage({ hasTorrent: true, fileSelected: true, peers: 4, firstByte: false }), "opening");
});

const hashFor = (n: number) => n.toString(16).padStart(40, "0");
const source = (title: string, seeders: number, n: number, extra: Partial<TorrentResult> = {}): TorrentResult => ({
  guid: title,
  title,
  indexer: "fixture",
  size: 1024 ** 3,
  seeders,
  leechers: 0,
  magnetUrl: `magnet:?xt=urn:btih:${hashFor(n)}&dn=${encodeURIComponent(title)}`,
  fileIndex: 0,
  ...extra,
});

test("startup order puts a healthy source before the 1-seeder the provider ranked first", () => {
  // Gilmore Girls S1E1 on the owner's Mac: the FGT x264 release (1 seeder) was tried first and hung.
  const dead = source("Gilmore.Girls.S01E01.WEBRip.x264-FGT.mp4", 1, 1);
  const healthy = source("Gilmore Girls S01E01 720p WEB H264", 20, 2);
  assert.deepEqual(orderForStartup([dead, healthy]).map((r) => r.title), [healthy.title, dead.title]);
  assert.ok(startupScore(source("Movie.2160p.UHD.BluRay.REMUX.mkv", 50, 3, { size: 60 * 1024 ** 3 })) < startupScore(source("Movie.1080p.WEB-DL.mkv", 50, 4)));
});

test("explicitly foreign releases go last only when English audio is preferred", () => {
  const foreign = source("Movie 1080p Latino", 60, 5, { sourceLanguage: "non-english" });
  const english = source("Movie 1080p", 20, 6, { sourceLanguage: "english" });
  assert.equal(orderForStartup([foreign, english])[0], english);
  assert.equal(orderForStartup([foreign, english], { english: false })[0], foreign);
});

test("the desktop player prefers a healthy H.264 MP4 it can play at once over a busier MKV it must convert", () => {
  // Oppenheimer on 2026-10-20: the GalaxyRG MKV (more peers) used to win and waited for FFmpeg.
  const mp4 = source("Oppenheimer.2023.1080p.BluRay.x264.AAC5.1-[YTS.MX].mp4", 616, 11);
  const mkv = source("Oppenheimer.2023.1080p.BluRay.DD5.1.x264-GalaxyRG.mkv", 1100, 12);
  assert.equal(orderForStartup([mkv, mp4], { webPlayer: true })[0], mp4);
  // Only a tie-breaker: an MP4 almost nobody shares still loses.
  const scarce = source("Oppenheimer.2023.1080p.WEB.x264.mp4", 3, 13);
  assert.equal(orderForStartup([scarce, mkv], { webPlayer: true })[0], mkv);
  // HEVC MP4s need the conversion too, so they get no head start.
  const hevc = source("Show.S01E01.1080p.BluRay.x265-RARBG.mp4", 129, 14);
  const hevcMkv = source("Show.S01E01.1080p.10bit.BluRay.x265.HEVC-PSA.mkv", 661, 15);
  assert.equal(orderForStartup([hevc, hevcMkv], { webPlayer: true })[0], hevcMkv);
});

/** An instant (rqbit-like) engine that records adds; `dead` hashes never resolve metadata. */
function fakeEngine(dead = new Set<string>()) {
  const torrents = new Map<string, QbtTorrent>();
  const adds: string[] = [];
  const phases: Array<string | null> = [];
  const engine = {
    instantStreaming: true,
    list: async () => [...torrents.values()],
    add: async (link: string) => {
      const hash = link.match(/btih:([a-f\d]{40})/i)![1].toLowerCase();
      adds.push(hash);
      phases.push(useTorrents.getState().streamLaunchPhase);
      if (dead.has(hash)) throw new Error("No peers shared this source in time.");
      torrents.set(hash, { hash, name: hash, category: "akflix-stream", num_seeds: 0, num_leechs: 0, progress: 0, dlspeed: 0, seq_dl: true } as QbtTorrent);
    },
    setSequential: async () => {},
    delete: async (hash: string) => { torrents.delete(hash); },
    streamUrl: () => null,
  };
  return { engine, torrents, adds, phases };
}

async function withFakeEngine<T>(engine: object, run: () => Promise<T>): Promise<T> {
  const globals = globalThis as Record<string, unknown>;
  const previousStorage = globals.localStorage;
  const items = new Map<string, string>();
  globals.localStorage = {
    get length() { return items.size; },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
  const qbt = useTorrents.getState().qbt;
  const torrentEngine = useSettings.getState().torrentEngine;
  // Not "embedded": skips the native free-space check, the engine is the fake.
  useSettings.setState({ torrentEngine: "qbittorrent" });
  useTorrents.setState({ qbt: () => engine as never });
  try {
    return await run();
  } finally {
    await useTorrents.getState().cancelPendingStream().catch(() => {});
    useTorrents.setState({ qbt, handedOff: null, activeStreamHash: null, activeStreamTemporary: false });
    useSettings.setState({ torrentEngine });
    globals.localStorage = previousStorage;
  }
}

const gilmore = { title: "Gilmore Girls", catalogId: "tt0238784", season: 1, episode: 1, isEpisode: true };

test("a remembered release that is barely shared no longer goes first", async () => {
  const { engine, adds } = fakeEngine();
  await withFakeEngine(engine, async () => {
    const dead = source("Gilmore.Girls.S01E01.WEBRip.x264-FGT.mp4", 1, 1);
    const healthy = source("Gilmore Girls S01E01 720p WEB H264", 20, 2);
    rememberSource(gilmore, hashFor(1));
    await useTorrents.getState().raceStreamSources([dead, healthy], gilmore);
    assert.equal(adds[0], hashFor(2));
    assert.equal(useTorrents.getState().pendingStreamHash, hashFor(2));
    assert.deepEqual(useTorrents.getState().pendingStreamFallbacks.map((r) => r.title), [dead.title]);

    // A remembered release with real peers still goes first (resume lands on the same file).
    adds.length = 0;
    const solid = source("Gilmore Girls S01E01 1080p", 9, 3);
    rememberSource(gilmore, hashFor(3));
    await useTorrents.getState().raceStreamSources([healthy, solid], gilmore);
    assert.equal(adds[0], hashFor(3));
  });
});

test("sources that fail to load are not offered again as fallbacks", async () => {
  const { engine, adds } = fakeEngine(new Set([hashFor(1)]));
  await withFakeEngine(engine, async () => {
    await useTorrents.getState().raceStreamSources(
      [source("A 1080p", 50, 1), source("B 1080p", 40, 2), source("C 1080p", 30, 3)],
      { title: "Movie" }
    );
    assert.deepEqual(adds, [hashFor(1), hashFor(2)]);
    assert.equal(useTorrents.getState().streamStartAttempt, 2);
    assert.deepEqual(useTorrents.getState().pendingStreamFallbacks.map((r) => r.title), ["C 1080p"]);
  });
});

test("switching sources keeps the status card up and counts the attempts", async () => {
  const { engine, torrents, phases } = fakeEngine(new Set([hashFor(7)]));
  await withFakeEngine(engine, async () => {
    const requestId = await useTorrents.getState().beginStreamRequest({ title: "Show" });
    torrents.set(hashFor(9), { hash: hashFor(9), category: "akflix-stream" } as QbtTorrent);
    useTorrents.setState({
      pendingStreamHash: hashFor(9),
      pendingStreamTemporary: true,
      pendingStreamStartedAt: Date.now(),
      streamStartAttempt: 1,
      pendingStreamFallbacks: [source("dead", 5, 7), source("live", 9, 8)],
    });
    const next = await useTorrents.getState().failoverPendingStream(requestId);
    assert.equal(next?.title, "live");
    assert.ok(phases.every((phase) => !!phase), "the card shows a phase while no source is attached");
    const state = useTorrents.getState();
    assert.equal(state.pendingStreamHash, hashFor(8));
    assert.equal(state.streamStartAttempt, 3);
    assert.equal(torrents.has(hashFor(9)), false, "the abandoned source is deleted");
  });
});

test("a source the player took but never showed a picture for moves on to the next one", async () => {
  const { engine, torrents, adds } = fakeEngine();
  await withFakeEngine(engine, async () => {
    await useTorrents.getState().raceStreamSources([source("A 1080p", 50, 1), source("B 1080p", 40, 2)], { title: "Movie" });
    const { streamRequestId } = useTorrents.getState();
    assert.equal(useTorrents.getState().markStreamReady(hashFor(1), streamRequestId), true);
    assert.equal(useTorrents.getState().activeStreamHash, hashFor(1));
    assert.deepEqual(useTorrents.getState().handedOff?.fallbacks.map((r) => r.title), ["B 1080p"]);

    const next = await useTorrents.getState().startNextSource();
    assert.equal(next?.title, "B 1080p");
    const state = useTorrents.getState();
    assert.equal(state.pendingStreamHash, hashFor(2));
    assert.equal(state.streamStartAttempt, 2);
    assert.equal(torrents.has(hashFor(1)), false, "the source that showed nothing is removed");
    assert.deepEqual(adds, [hashFor(1), hashFor(2)]);
    // Nothing left after B.
    useTorrents.setState({ handedOff: { hash: hashFor(2), media: null, fallbacks: [], attempt: 2 } });
    assert.equal(await useTorrents.getState().startNextSource(), null);
  });
});

test("an idle engine is listed every 15 s, a starting stream every second", async () => {
  const { torrentPollDelay } = await import("../src/stores/torrentStore");
  const idle = { pendingStreamHash: null, sourceRaceActive: false, streamLaunchPhase: null, activeStreamHash: null };
  const seeding = { hash: "a", progress: 1, state: "uploading" } as QbtTorrent;
  const downloading = { hash: "b", progress: 0.4, state: "downloading" } as QbtTorrent;
  const paused = { hash: "c", progress: 0.4, state: "pausedDL" } as QbtTorrent;
  assert.equal(torrentPollDelay(idle, [seeding, paused]), 15_000);
  assert.equal(torrentPollDelay(idle, [downloading]), 2_000);
  assert.equal(torrentPollDelay({ ...idle, activeStreamHash: "a" }, []), 2_000);
  assert.equal(torrentPollDelay({ ...idle, streamLaunchPhase: "Finding available sources" }, []), 1_000);
  assert.equal(torrentPollDelay({ ...idle, pendingStreamHash: "a" }, []), 1_000);
});
