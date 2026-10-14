// Race tests for the desktop player's skips. They drive the callbacks that
// PlayerHost wires to the ±10 s buttons and arrow keys (seekBy), the scrubber
// (seek), play/pause (toggle) and media events (settle, replacing) with a
// fake clock and a converter whose restarts finish when the test says so.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RESTART_DEBOUNCE_MS,
  RESTART_RETRY_DELAYS_MS,
  createPlayerSeek,
  isTransientConverterFailure,
  type SeekVideo,
} from "../src/lib/playerSeek";
import type { DirectPlaybackRequest } from "../src/stores/playbackStore";

const ranges = (...list: [number, number][]) => ({
  length: list.length,
  start: (index: number) => list[index][0],
  end: (index: number) => list[index][1],
});

class FakeVideo implements SeekVideo {
  private time = 0;
  duration = Number.NaN;
  paused = false;
  seeking = false;
  readyState = 4;
  seekable = ranges([0, 20]);
  src = "playlist-0";
  plays = 0;
  get currentTime() {
    return this.time;
  }
  set currentTime(value: number) {
    this.time = value;
    this.seeking = true;
  }
  /** WebKit finished the seek. */
  seeked() {
    this.seeking = false;
  }
  pause() {
    this.paused = true;
  }
  async play() {
    this.paused = false;
    this.plays += 1;
  }
  load() {
    this.time = 0;
    this.seeking = false;
    this.seekable = ranges();
  }
}

type Restart = { target: number; resolve: (url: string) => void; reject: (reason: string) => void };

function setup(options: { converted?: boolean; paused?: boolean; durationSeconds?: number; at?: number } = {}) {
  let now = 0;
  let ids = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const video = new FakeVideo();
  video.paused = options.paused ?? false;
  const request: DirectPlaybackRequest = {
    id: "torrent:abc:1",
    url: "playlist-0",
    title: "Fixture",
    playbackRequestId: 7,
    durationSeconds: options.durationSeconds ?? 600,
    ...(options.converted === false
      ? {}
      : { compatibility: { streamId: "abc", audioLanguage: "eng", inputUrl: "http://engine/stream", startSeconds: 0 } }),
  };
  const shown = { currentTime: options.at ?? 5, duration: 600, buffering: false, isPlaying: !video.paused };
  video.currentTime = options.at ?? 5;
  video.seeked();
  const restarts: Restart[] = [];
  const attached: number[] = [];
  const failures: { target: number; reason: string }[] = [];
  let active: DirectPlaybackRequest | null = request;

  const seeker = createPlayerSeek({
    video: () => video,
    request: () => active,
    shownPosition: () => shown.currentTime,
    shownDuration: () => shown.duration,
    startConverter: (_request, target) =>
      new Promise<string>((resolve, reject) => restarts.push({ target, resolve, reject })),
    sync: (patch) => Object.assign(shown, patch),
    attached: (_request, target) => attached.push(target),
    failed: (_request, target, reason) => failures.push({ target, reason }),
    setTimeout: (run, ms) => {
      const id = ++ids;
      timers.set(id, { at: now + ms, run });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (id) => void timers.delete(id as unknown as number),
  });

  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const clock = async (ms: number) => {
    await settle(); // let finished restarts schedule their follow-ups first
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].run();
      await settle();
    }
    now = end;
    await settle();
  };
  // What PlayerHost's timeupdate handler does once a seek is done.
  const timeupdate = () => {
    if (seeker.replacing()) return;
    seeker.settle();
    shown.currentTime = (request.compatibility?.startSeconds ?? 0) + video.currentTime;
  };
  return {
    seeker, video, request, shown, restarts, attached, failures, clock, settle, timeupdate,
    switchTitle: () => { active = { ...request, playbackRequestId: 8 }; },
  };
}

test("two quick +10 s skips land 20 s ahead even when the player reports a stale position", async () => {
  const t = setup({ at: 5 });
  t.seeker.seekBy(10); // inside what the converter produced: instant
  assert.equal(t.video.currentTime, 15);
  t.shown.currentTime = 5; // a late timeupdate from before the seek
  await t.clock(100);
  t.seeker.seekBy(10); // past the produced part: converter restart
  await t.clock(RESTART_DEBOUNCE_MS);
  assert.deepEqual(t.restarts.map((r) => r.target), [25]);
  assert.equal(t.shown.currentTime, 25);
  t.restarts[0].resolve("playlist-25");
  await t.settle();
  assert.deepEqual(t.attached, [25]);
  assert.equal(t.request.compatibility?.startSeconds, 25);
  assert.match(t.video.src, /^playlist-25\?seek=/);
  assert.equal(t.video.paused, false, "a burst of skips keeps playing");
});

test("a burst of skips becomes one restart at the summed target, back and forward mixed", async () => {
  const t = setup({ at: 5 });
  t.video.seekable = ranges(); // nothing converted yet
  for (const delta of [10, 10, -10, 10, 30, -10]) {
    t.seeker.seekBy(delta);
    await t.clock(60);
  }
  await t.clock(RESTART_DEBOUNCE_MS);
  assert.deepEqual(t.restarts.map((r) => r.target), [45]);
});

test("skips clamp to the end of the title and to the start", async () => {
  const t = setup({ at: 590, durationSeconds: 600 });
  t.video.seekable = ranges();
  t.seeker.seekBy(10);
  t.seeker.seekBy(10);
  await t.clock(RESTART_DEBOUNCE_MS);
  assert.deepEqual(t.restarts.map((r) => r.target), [599.75]);
  t.restarts[0].resolve("playlist-end");
  await t.settle();
  t.seeker.seek(4);
  t.seeker.seekBy(-10);
  await t.clock(RESTART_DEBOUNCE_MS);
  assert.equal(t.restarts.at(-1)?.target, 0);
});

test("a scrub resets the run of skips and later skips add to it", async () => {
  const t = setup({ at: 5 });
  t.video.seekable = ranges();
  t.seeker.seekBy(10);
  t.seeker.seek(300);
  t.seeker.seekBy(10);
  await t.clock(RESTART_DEBOUNCE_MS);
  assert.deepEqual(t.restarts.map((r) => r.target), [310]);
});

test("a skip that started before a new title never moves the new title", async () => {
  const t = setup({ at: 5 });
  t.video.seekable = ranges();
  t.seeker.seekBy(10);
  t.seeker.reset();
  t.switchTitle();
  await t.clock(RESTART_DEBOUNCE_MS + 10);
  assert.equal(t.restarts.length, 0);
  t.shown.currentTime = 0;
  t.seeker.seekBy(10);
  await t.clock(RESTART_DEBOUNCE_MS);
  assert.deepEqual(t.restarts.map((r) => r.target), [10], "starts from the new title, not the old target");
});

test("restarts that finish out of order leave the newest skip playing", async () => {
  const t = setup({ at: 5 });
  t.video.seekable = ranges();
  t.seeker.seekBy(10);
  await t.clock(RESTART_DEBOUNCE_MS);
  t.seeker.seekBy(10); // while the first restart is still converting
  await t.clock(RESTART_DEBOUNCE_MS);
  assert.deepEqual(t.restarts.map((r) => r.target), [15, 25]);
  t.restarts[1].resolve("playlist-25");
  await t.settle();
  t.restarts[0].resolve("playlist-15"); // the older one answers last
  await t.settle();
  assert.deepEqual(t.attached, [25]);
  assert.match(t.video.src, /^playlist-25/);
  assert.equal(t.request.compatibility?.startSeconds, 25);
  t.restarts[0].reject("The compatibility stream was replaced");
  await t.settle();
  assert.equal(t.failures.length, 0);
});

test("skips while paused stay paused, and play/pause during a restart decides how it lands", async () => {
  const paused = setup({ at: 5, paused: true });
  paused.video.seekable = ranges();
  paused.seeker.seekBy(10);
  paused.seeker.seekBy(10);
  await paused.clock(RESTART_DEBOUNCE_MS);
  paused.restarts[0].resolve("playlist-25");
  await paused.settle();
  assert.equal(paused.video.paused, true);
  assert.equal(paused.video.plays, 0);
  assert.equal(paused.shown.isPlaying, false);

  const playing = setup({ at: 5 });
  playing.video.seekable = ranges();
  playing.seeker.seekBy(10);
  await playing.clock(RESTART_DEBOUNCE_MS);
  assert.equal(playing.video.paused, true, "the restart pauses the replaced conversion");
  assert.equal(playing.seeker.replacing(), true, "...and PlayerHost ignores that pause");
  assert.equal(playing.shown.isPlaying, true, "the controls keep showing the viewer's intent");
  assert.equal(playing.seeker.toggle(), true); // viewer pauses mid-restart
  assert.equal(playing.shown.isPlaying, false);
  assert.equal(playing.video.plays, 0, "never resumes the replaced conversion");
  playing.restarts[0].resolve("playlist-15");
  await playing.settle();
  assert.equal(playing.video.paused, true);
  assert.equal(playing.seeker.replacing(), false);
  assert.equal(playing.seeker.toggle(), false, "ordinary play/pause again");
});

test("a restart into a slow torrent region is retried at the same target and then lands", async () => {
  const t = setup({ at: 5 });
  t.video.seekable = ranges();
  t.seeker.seekBy(10);
  t.seeker.seekBy(10);
  await t.clock(RESTART_DEBOUNCE_MS);
  t.restarts[0].reject("Timed out preparing the compatibility stream");
  await t.settle();
  assert.equal(t.shown.buffering, true, "still buffering, not an error");
  assert.equal(t.shown.currentTime, 25);
  t.seeker.seekBy(10); // the viewer taps again while it waits
  await t.clock(RESTART_DEBOUNCE_MS);
  assert.deepEqual(t.restarts.map((r) => r.target), [25, 35]);
  t.restarts[1].reject("FFmpeg could not read this source yet");
  await t.clock(RESTART_RETRY_DELAYS_MS[0]);
  assert.deepEqual(t.restarts.map((r) => r.target), [25, 35, 35]);
  t.restarts[2].resolve("playlist-35");
  await t.settle();
  assert.deepEqual(t.attached, [35]);
  assert.equal(t.video.paused, false);
  assert.equal(t.failures.length, 0);
});

test("a source that never delivers is reported after bounded retries and keeps the target", async () => {
  const t = setup({ at: 5 });
  t.video.seekable = ranges();
  t.seeker.seekBy(10);
  await t.clock(RESTART_DEBOUNCE_MS);
  for (let attempt = 0; attempt <= RESTART_RETRY_DELAYS_MS.length; attempt += 1) {
    t.restarts[attempt].reject("Timed out preparing the compatibility stream");
    await t.clock(RESTART_RETRY_DELAYS_MS[attempt] ?? 10_000);
  }
  assert.equal(t.restarts.length, RESTART_RETRY_DELAYS_MS.length + 1, "bounded");
  assert.deepEqual(t.failures.map((f) => f.target), [15]);
  assert.equal(t.shown.buffering, false);
  assert.equal(t.shown.currentTime, 15);
  assert.equal(t.seeker.pendingTarget(), 15);
  t.timeupdate(); // the dead conversion's position must not replace it
  assert.equal(t.shown.currentTime, 15);

  assert.equal(t.seeker.toggle(), true, "play retries the same point");
  await t.clock(0);
  assert.equal(t.restarts.at(-1)?.target, 15);
  t.restarts.at(-1)!.resolve("playlist-15");
  await t.settle();
  assert.equal(t.video.paused, false);
  assert.deepEqual(t.attached, [15]);
});

test("a skip after a failed restart adds to the point the viewer asked for", async () => {
  const t = setup({ at: 5 });
  t.video.seekable = ranges();
  t.seeker.seekBy(10);
  await t.clock(RESTART_DEBOUNCE_MS);
  t.restarts[0].reject("Only the embedded local stream can be transcoded");
  await t.settle();
  assert.equal(t.restarts.length, 1, "a permanent failure is not retried");
  assert.equal(t.failures.length, 1);
  t.seeker.seekBy(10);
  await t.clock(RESTART_DEBOUNCE_MS);
  assert.equal(t.restarts.at(-1)?.target, 25);
});

test("direct streams: quick skips add up, and a finished seek hands back to the video's clock", () => {
  const t = setup({ at: 5, converted: false });
  t.seeker.seekBy(10);
  t.shown.currentTime = 5; // stale timeupdate while WebKit is still seeking
  t.seeker.seekBy(10);
  assert.equal(t.video.currentTime, 25);
  t.video.seeked();
  t.timeupdate();
  assert.equal(t.seeker.pendingTarget(), null);
  t.shown.currentTime = 31; // playback moved on
  t.seeker.seekBy(-10);
  assert.equal(t.video.currentTime, 21);
});

test("only not-yet failures of a converter restart are retried", () => {
  assert.equal(isTransientConverterFailure("Timed out preparing the compatibility stream"), true);
  assert.equal(isTransientConverterFailure("FFmpeg could not read this source yet"), true);
  assert.equal(isTransientConverterFailure("The compatibility stream was replaced"), true);
  assert.equal(isTransientConverterFailure("Only the embedded local stream can be transcoded"), false);
  assert.equal(isTransientConverterFailure("The bundled FFmpeg executable is missing from this Akflix build"), false);
});
