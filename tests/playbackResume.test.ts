// The desktop player after a pause of any length (lib/playbackResume.ts) and
// the seeker's reconnect (lib/playerSeek.ts), with a fake clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FROZEN_CLOCK_MS,
  LONG_PAUSE_MS,
  MAX_FROZEN_RECONNECTS,
  RECONNECT_GRACE_MS,
  createFrozenClockWatch,
  resumeAction,
  type ClockSample,
} from "../src/lib/playbackResume";
import { createPlayerSeek, type SeekVideo } from "../src/lib/playerSeek";
import type { DirectPlaybackRequest } from "../src/stores/playbackStore";

test("a converted stream resumes on a fresh conversion after any long pause, a short pause just plays", () => {
  assert.equal(resumeAction("converted", 3_000), "play");
  assert.equal(resumeAction("converted", LONG_PAUSE_MS - 1), "play");
  for (const minutes of [0.25, 2.25, 5, 15, 30, 60, 8 * 60]) {
    assert.equal(resumeAction("converted", minutes * 60_000), "reconnect", `${minutes} min`);
  }
  // Direct streams and Jellyfin keep their own recovery; the first play has no pause.
  assert.equal(resumeAction("direct", 60 * 60_000), "play");
  assert.equal(resumeAction("other", 60 * 60_000), "play");
  assert.equal(resumeAction("converted", null), "play");
});

const playing = (now: number, time: number, extra: Partial<ClockSample> = {}): ClockSample => ({
  now, time, paused: false, seeking: false, ended: false, readyState: 4, busy: false, ...extra,
});

test("a playing clock that stops with frames ready is frozen; a moving or buffering one is not", () => {
  const watch = createFrozenClockWatch();
  let now = 0;
  let time = 10;
  // Moving normally for a minute.
  for (; now < 60_000; now += 500, time += 0.5) assert.equal(watch.sample(playing(now, time)), false);
  // The owner's freeze: "playing", HAVE_ENOUGH_DATA, clock stuck.
  const stuckAt = now;
  let fired = -1;
  for (; now < stuckAt + 10_000; now += 500) {
    if (watch.sample(playing(now, time))) { fired = now; break; }
  }
  assert.ok(fired >= stuckAt + FROZEN_CLOCK_MS && fired <= stuckAt + FROZEN_CLOCK_MS + 500, `fired at ${fired - stuckAt}`);

  // Real buffering (no future frames) is the stall handler's job.
  const buffering = createFrozenClockWatch();
  for (let t = 0; t < 30_000; t += 500) assert.equal(buffering.sample(playing(t, 5, { readyState: 2 })), false);
  // Paused, seeking or a restart in progress never count.
  for (const extra of [{ paused: true }, { seeking: true }, { busy: true }, { ended: true }]) {
    const w = createFrozenClockWatch();
    for (let t = 0; t < 30_000; t += 500) assert.equal(w.sample(playing(t, 5, extra)), false, JSON.stringify(extra));
  }
});

test("after a reconnect the new source gets a grace period, and repeated failures stop retrying", () => {
  const watch = createFrozenClockWatch();
  let now = 0;
  const fires: number[] = [];
  for (; now < 120_000; now += 500) {
    if (watch.sample(playing(now, 42))) {
      fires.push(now);
      watch.reconnected(now);
    }
  }
  assert.equal(fires.length, MAX_FROZEN_RECONNECTS);
  for (let i = 1; i < fires.length; i += 1) assert.ok(fires[i] - fires[i - 1] >= RECONNECT_GRACE_MS);
  // Once the clock moves again the watch is armed again.
  for (let t = 42; now < 130_000; now += 500, t += 0.5) watch.sample(playing(now, t));
  let again = false;
  for (const end = now + 10_000; now < end; now += 500) again ||= watch.sample(playing(now, 99));
  assert.equal(again, true);
});

class Video implements SeekVideo {
  currentTime = 0;
  duration = Number.NaN;
  paused = false;
  seeking = false;
  readyState = 4;
  seekable = { length: 1, start: () => 0, end: () => 60 };
  src = "playlist-0";
  plays = 0;
  pause() { this.paused = true; }
  async play() { this.paused = false; this.plays += 1; }
  load() { this.currentTime = 0; }
}

function seekerAt(position: number, converted = true) {
  const video = new Video();
  video.currentTime = position - 100;
  const request: DirectPlaybackRequest = {
    id: "torrent:abc:1", url: "playlist-0", title: "Fixture", playbackRequestId: 1, durationSeconds: 3_120,
    ...(converted ? { compatibility: { streamId: "abc", audioLanguage: "eng", inputUrl: "http://engine/stream", startSeconds: 100 } } : {}),
  };
  const shown = { currentTime: position, buffering: false, isPlaying: false };
  const starts: number[] = [];
  const timers: (() => void)[] = [];
  const seeker = createPlayerSeek({
    video: () => video,
    request: () => request,
    shownPosition: () => shown.currentTime,
    shownDuration: () => 3_120,
    startConverter: async (_r, target) => { starts.push(target); return `playlist-${target}`; },
    sync: (patch) => Object.assign(shown, patch),
    attached: () => {},
    failed: () => {},
    setTimeout: (run) => { timers.push(run); return 0 as unknown as ReturnType<typeof setTimeout>; },
    clearTimeout: () => {},
  });
  const flush = async () => { while (timers.length) { timers.shift()!(); await new Promise((r) => setImmediate(r)); } };
  return { video, request, shown, starts, seeker, flush };
}

test("reconnect restarts the conversion where the viewer paused, inside the converted part, and plays", async () => {
  // VisionQuest S1E6: paused at 16:04 (964.6 s), 887.9 s into a conversion started at 76.7 s.
  const t = seekerAt(964.6);
  assert.equal(t.seeker.reconnect(true), true);
  assert.equal(t.shown.buffering, true);
  assert.equal(t.shown.isPlaying, true);
  assert.equal(t.seeker.replacing(), true); // its pause is not the viewer's
  await t.flush();
  assert.deepEqual(t.starts, [964.6]);
  assert.equal(t.request.compatibility?.startSeconds, 964.6);
  assert.match(t.video.src, /^playlist-964.6\?seek=/);
  assert.equal(t.video.plays, 1);
  assert.equal(t.seeker.replacing(), false);
});

test("reconnect does nothing for a direct stream or while a restart is already on its way", async () => {
  assert.equal(seekerAt(300, false).seeker.reconnect(true), false);
  const t = seekerAt(300);
  t.seeker.seek(900); // outside the converted part: restart pending
  assert.equal(t.seeker.reconnect(true), false);
  await t.flush();
  assert.deepEqual(t.starts, [900]);
});
