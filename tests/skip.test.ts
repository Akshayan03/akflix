// Skip intro / recap / credits: fingerprints, matching, chapter markers, the
// player's button and auto-skip decisions, and what is remembered. Fast unit
// tests with synthetic 8 kHz audio; the generated-episode accuracy run is
// scripts/test-skip-fixtures.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FP_SAMPLE_RATE,
  FP_SECONDS_PER_HASH,
  Fingerprinter,
  bitDifference,
  fingerprintPcm,
} from "../src/lib/skip/fingerprint";
import { bestCommonSegment, findSignature, signatureFrom } from "../src/lib/skip/match";
import {
  SKIP_LANDING_LEAD,
  chapterKind,
  markersFromChapters,
  parseFfmetadataChapters,
  plausibleSegment,
  skipView,
  sourceKey,
  type SkipInput,
  type SkipMarkers,
} from "../src/lib/skip/markers";
import { SkipMemory, decodePrint, encodePrint, type SkipStorage } from "../src/lib/skip/cache";
import { analyzeSkipMarkers, openingWindow, closingWindow } from "../src/lib/skip/detector";

// ── Deterministic synthetic audio (the same generator is in the Roku bridge tests) ──

/** Numerical Recipes LCG, exact in 32-bit integer arithmetic. */
function lcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** A melody (new note every 0.3 s) with two harmonics: music-like, pitched. */
export function melody(seconds: number, seed: number): Float64Array {
  const random = lcg(seed);
  const out = new Float64Array(Math.round(seconds * FP_SAMPLE_RATE));
  const noteLength = Math.round(0.3 * FP_SAMPLE_RATE);
  let freq = 0;
  for (let n = 0; n < out.length; n += 1) {
    if (n % noteLength === 0) freq = 196 * Math.pow(2, Math.floor(random() * 24) / 12);
    const t = (n % noteLength) / FP_SAMPLE_RATE;
    const envelope = Math.exp(-4 * t);
    out[n] = envelope * (0.4 * Math.sin(2 * Math.PI * freq * t) + 0.15 * Math.sin(4 * Math.PI * freq * t));
  }
  return out;
}

/** Seeded noise bursts: "dialogue" that never repeats between seeds. */
function chatter(seconds: number, seed: number): Float64Array {
  const random = lcg(seed);
  const out = new Float64Array(Math.round(seconds * FP_SAMPLE_RATE));
  let level = 0;
  for (let n = 0; n < out.length; n += 1) {
    if (n % 1200 === 0) level = random() < 0.3 ? 0.02 : 0.1 + random() * 0.3;
    out[n] = level * (random() * 2 - 1);
  }
  return out;
}

function join(...parts: Float64Array[]): Float64Array {
  const out = new Float64Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function tone(seconds: number, freq: number): Float64Array {
  const out = new Float64Array(Math.round(seconds * FP_SAMPLE_RATE));
  for (let n = 0; n < out.length; n += 1) out[n] = 0.3 * Math.sin((2 * Math.PI * freq * n) / FP_SAMPLE_RATE);
  return out;
}

const silence = (seconds: number) => new Float64Array(Math.round(seconds * FP_SAMPLE_RATE));

/** Re-encoding stand-in: slight gain change plus low noise. */
function degrade(signal: Float64Array, gain: number, seed: number): Float64Array {
  const random = lcg(seed);
  return signal.map((value) => value * gain + (random() * 2 - 1) * 0.004);
}

const INTRO = melody(40, 7);

// ── Fingerprint ───────────────────────────────────────────────────────────

test("bit difference counts differing bits", () => {
  assert.equal(bitDifference(0, 0), 0);
  assert.equal(bitDifference(0xffffffff, 0), 32);
  assert.equal(bitDifference(0b1011, 0b0010), 2);
  assert.equal(bitDifference(0x80000000, 0), 1);
});

test("fingerprints are the same however the audio is pushed", () => {
  const audio = join(chatter(5, 1), INTRO.subarray(0, 10 * FP_SAMPLE_RATE));
  const whole = fingerprintPcm(audio);
  const chunked = new Fingerprinter();
  const random = lcg(99);
  for (let at = 0; at < audio.length; ) {
    const size = 1 + Math.floor(random() * 5000);
    chunked.push(audio.subarray(at, at + size));
    at += size;
  }
  assert.deepEqual(Array.from(chunked.print().hashes), Array.from(whole.hashes));
  // One hash every 0.125 s, after the first 20 frames.
  const expected = Math.floor((audio.length - 2048) / 1000) + 1 - 19;
  assert.equal(whole.hashes.length, expected);
  assert.equal(FP_SECONDS_PER_HASH, 0.125);
});

test("Int16 PCM and float PCM give the same fingerprint", () => {
  const audio = INTRO.subarray(0, 8 * FP_SAMPLE_RATE);
  const ints = Int16Array.from(audio, (value) => Math.round(value * 32767));
  const fromInts = fingerprintPcm(ints).hashes;
  const fromFloats = fingerprintPcm(audio).hashes;
  const close = fromInts.filter((hash, i) => bitDifference(hash, fromFloats[i]) <= 2).length;
  assert.ok(close / fromInts.length > 0.97);
});

test("fingerprint bits are informative (not stuck) on music", () => {
  const print = fingerprintPcm(INTRO);
  for (let bit = 0; bit < 32; bit += 2) {
    const ones = print.hashes.filter((hash) => (hash >>> bit) & 1).length / print.hashes.length;
    // Most 2-bit classifier outputs vary; a few may be lopsided, none may be fixed for every hash.
    assert.ok(ones > 0 || print.hashes.some((hash) => (hash >>> (bit + 1)) & 1), `bit pair ${bit} never set`);
  }
  assert.ok(new Set(print.hashes).size > print.hashes.length * 0.5);
});

test("silence is flagged quiet, music is not", () => {
  const print = fingerprintPcm(join(silence(10), INTRO.subarray(0, 10 * FP_SAMPLE_RATE)));
  const firstQuiet = print.quiet.slice(0, 50).every((flag) => flag === 1);
  const laterLoud = print.quiet.slice(-30).every((flag) => flag === 0);
  assert.ok(firstQuiet && laterLoud);
});

// ── Matching ──────────────────────────────────────────────────────────────

const episode = (cold: number, seed: number, intro = INTRO, gain = 1) =>
  degrade(join(chatter(cold, seed), intro, chatter(60, seed + 1)), gain, seed + 2);

test("the shared intro is found at each episode's own offset", () => {
  // 37.0613 s: not on the 0.125 s hash grid, like real cold opens.
  const a = fingerprintPcm(episode(37.0613, 10));
  const b = fingerprintPcm(episode(91.3, 20, INTRO, 0.7));
  const match = bestCommonSegment(a, b, { minSeconds: 15, maxSeconds: 180 });
  assert.ok(match, "no match");
  assert.ok(Math.abs(match.a.start - 37.0613) < 1.0, `a start ${match.a.start}`);
  assert.ok(match.a.end <= 37.0613 + 40 + 0.3 && match.a.end > 37.0613 + 40 - 2, `a end ${match.a.end}`);
  assert.ok(Math.abs(match.b.start - 91.3) < 1.0, `b start ${match.b.start}`);
  assert.ok(match.b.end <= 91.3 + 40 + 0.3, `b end ${match.b.end}`);
  assert.ok(match.ratio > 0.8);
});

test("unrelated episodes share nothing", () => {
  const a = fingerprintPcm(join(chatter(60, 1), melody(40, 3), chatter(60, 2)));
  const b = fingerprintPcm(join(chatter(50, 4), melody(40, 5), chatter(60, 6)));
  assert.equal(bestCommonSegment(a, b, { minSeconds: 15, maxSeconds: 180 }), null);
});

test("shared silence, a shared steady tone and a short shared sting are not intros", () => {
  const sting = melody(5, 77);
  const a = fingerprintPcm(join(chatter(20, 1), silence(30), tone(30, 1000), sting, chatter(40, 2)));
  const b = fingerprintPcm(join(chatter(35, 3), silence(30), tone(30, 1000), sting, chatter(40, 4)));
  assert.equal(bestCommonSegment(a, b, { minSeconds: 15, maxSeconds: 180 }), null);
});

test("a season's intro signature is found in a later episode", () => {
  const a = fingerprintPcm(episode(12, 30));
  const b = fingerprintPcm(episode(70, 40));
  const match = bestCommonSegment(a, b, { minSeconds: 15, maxSeconds: 180 })!;
  const signature = signatureFrom(a, match.a);
  const c = fingerprintPcm(episode(140.37, 50, INTRO, 1.3));
  const hit = findSignature(signature, c, { range: [0, 600] });
  assert.ok(hit, "signature not found");
  assert.ok(Math.abs(hit.start - 140.37) < 1.2, `start ${hit.start}`);
  assert.ok(hit.end <= 140.37 + 40 + 0.3 && hit.end > 140.37 + 38, `end ${hit.end}`);
  // An episode without that intro has no hit.
  assert.equal(findSignature(signature, fingerprintPcm(episode(30, 60, melody(40, 8)))), null);
});

test("most of a shortened intro still matches; a fragment does not", () => {
  const a = fingerprintPcm(episode(20, 70));
  const b = fingerprintPcm(episode(45, 80));
  const signature = signatureFrom(a, bestCommonSegment(a, b, { minSeconds: 15, maxSeconds: 180 })!.a);
  const shortened = fingerprintPcm(episode(33, 90, INTRO.subarray(0, 34 * FP_SAMPLE_RATE)));
  assert.ok(findSignature(signature, shortened), "85% of the intro should match");
  const fragment = fingerprintPcm(episode(33, 91, INTRO.subarray(0, 12 * FP_SAMPLE_RATE)));
  assert.equal(findSignature(signature, fragment), null);
});

// ── Chapter markers ───────────────────────────────────────────────────────

test("chapter titles name intros, recaps and credits", () => {
  for (const title of ["Intro", "Opening", "Opening Credits", "OP", "NC OP 2", "Main Titles", "Theme Song"]) {
    assert.equal(chapterKind(title), "intro", title);
  }
  for (const title of ["Recap", "Previously On", "Previously", "Story so far"]) assert.equal(chapterKind(title), "recap", title);
  for (const title of ["Credits", "End Credits", "Ending", "Outro", "ED", "Closing Credits", "End Titles"]) {
    assert.equal(chapterKind(title), "credits", title);
  }
  for (const title of ["Chapter 1", "Introduction", "Episode", "12", "Ed's story", "Opera", "", "Prologue"]) {
    assert.equal(chapterKind(title), null, title);
  }
});

test("chapters become markers only where they make sense", () => {
  const markers = markersFromChapters(
    [
      { title: "Previously On", start: 0, end: 40 },
      { title: "Opening", start: 40, end: 70 },
      { title: "Episode", start: 70, end: 1400 },
      { title: "End Credits", start: 1400 },
    ],
    1460
  );
  assert.deepEqual(markers, {
    recap: { start: 0, end: 40, source: "chapter" },
    intro: { start: 40, end: 70, source: "chapter" },
    credits: { start: 1400, end: 1460, source: "chapter" },
  });
  // "Credits" in the first half are opening credits of an unnamed kind: never end credits.
  assert.deepEqual(markersFromChapters([{ title: "Credits", start: 10, end: 60 }, { title: "Story", start: 60 }], 1500), {});
  // A whole-episode "Intro" chapter is not skippable.
  assert.deepEqual(markersFromChapters([{ title: "Intro", start: 0, end: 1200 }], 1300), {});
});

test("ffmpeg chapter metadata is parsed with escapes and time bases", () => {
  const text = [
    ";FFMETADATA1",
    "title=Show \\= Name",
    "[CHAPTER]",
    "TIMEBASE=1/1000",
    "START=0",
    "END=40000",
    "title=Previously On",
    "[CHAPTER]",
    "TIMEBASE=1/1000000000",
    "START=40000000000",
    "END=70500000000",
    "title=Opening \\; Theme",
    "[STREAM]",
    "title=ignored",
  ].join("\n");
  assert.deepEqual(parseFfmetadataChapters(text), [
    { title: "Previously On", start: 0, end: 40 },
    { title: "Opening ; Theme", start: 40, end: 70.5 },
  ]);
});

test("implausible markers are refused", () => {
  assert.equal(plausibleSegment("intro", { start: 30, end: 80 }, 1500), true);
  assert.equal(plausibleSegment("intro", { start: 30, end: 33 }, 1500), false);
  assert.equal(plausibleSegment("intro", { start: 1000, end: 1060 }, 1500), false);
  assert.equal(plausibleSegment("intro", { start: 0, end: 400 }, 1500), false);
  assert.equal(plausibleSegment("credits", { start: 1400, end: 1500 }, 1500), true);
  assert.equal(plausibleSegment("credits", { start: 300, end: 360 }, 1500), false);
  assert.equal(plausibleSegment("credits", { start: 1400, end: 1500 }, 0), false);
  assert.equal(plausibleSegment("intro", { start: 50, end: Number.NaN }, 1500), false);
});

// ── The player's decisions ────────────────────────────────────────────────

const markers: SkipMarkers = {
  recap: { start: 0, end: 45, source: "chapter" },
  intro: { start: 60, end: 112, source: "fingerprint" },
  credits: { start: 1300, end: 1380, source: "fingerprint" },
};

function view(time: number, previousTime: number | null, overrides: Partial<SkipInput> = {}) {
  return skipView({
    markers,
    time,
    previousTime,
    duration: 1380,
    autoSkip: false,
    autoSkipped: new Set(),
    dismissed: new Set(),
    hasNext: true,
    creditsDismissed: false,
    ...overrides,
  });
}

test("Skip Intro shows during the intro and lands just before its end", () => {
  assert.equal(view(59.9, 59.6).button, null);
  const during = view(61, 60.7).button!;
  assert.equal(during.kind, "intro");
  assert.equal(during.label, "Skip Intro");
  assert.equal(during.target, 112 - SKIP_LANDING_LEAD);
  assert.ok(during.progress > 0 && during.progress < 0.05);
  assert.equal(view(111, 110.7).button, null, "not in the last 1.5 s");
  assert.equal(view(130, 129.7).button, null);
});

test("Skip Recap shows during a recap", () => {
  const button = view(5, 4.7).button!;
  assert.equal(button.kind, "recap");
  assert.equal(button.label, "Skip Recap");
});

test("auto-skip only when playback runs into the segment, and only once", () => {
  assert.deepEqual(view(60.2, 59.9, { autoSkip: true }).autoSkip, { kind: "intro", target: 112 - SKIP_LANDING_LEAD });
  // Seeking (or resuming) into the middle of the intro shows the button instead.
  const sought = view(80, 20, { autoSkip: true });
  assert.equal(sought.autoSkip, null);
  assert.equal(sought.button?.kind, "intro");
  assert.equal(view(80, null, { autoSkip: true }).autoSkip, null);
  // Already skipped once (the viewer came back to watch it): button only.
  const again = view(60.2, 59.9, { autoSkip: true, autoSkipped: new Set(["intro"]) });
  assert.equal(again.autoSkip, null);
  assert.equal(again.button?.kind, "intro");
  // Off: never.
  assert.equal(view(60.2, 59.9).autoSkip, null);
  // Not with less than 3 s left.
  assert.equal(view(109.5, 109.2, { autoSkip: true }).autoSkip, null);
});

test("a dismissed button stays hidden for that segment", () => {
  assert.equal(view(70, 69.7, { dismissed: new Set(["intro"]) }).button, null);
  assert.equal(view(5, 4.7, { dismissed: new Set(["intro"]) }).button?.kind, "recap");
});

test("Next episode appears from the credits, only with a next episode", () => {
  assert.equal(view(1299, 1298.7).nextEpisode, null);
  assert.deepEqual(view(1300.1, 1299.8).nextEpisode, { at: 1300 });
  assert.equal(view(1310, 1309.7, { hasNext: false }).nextEpisode, null);
  assert.equal(view(1310, 1309.7, { creditsDismissed: true }).nextEpisode, null);
  assert.equal(view(1379.8, 1379.5).nextEpisode, null, "not in the final half second");
});

test("source keys never contain the URL", () => {
  const key = sourceKey("https://host/file.mp4?token=secret");
  assert.equal(key, sourceKey("https://host/file.mp4?token=other"));
  assert.ok(!key.includes("secret") && !key.includes("host"));
  assert.notEqual(key, sourceKey("https://host/other.mp4"));
});

// ── Memory ────────────────────────────────────────────────────────────────

class MapStorage implements SkipStorage {
  map = new Map<string, string>();
  full = false;
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.full && value.length > 2000) throw new Error("QuotaExceededError");
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

test("prints survive storage exactly", () => {
  const print = fingerprintPcm(episode(3, 5));
  const back = decodePrint(JSON.parse(JSON.stringify(encodePrint({ ...print, seconds: 12.5 }))));
  assert.deepEqual(Array.from(back.hashes), Array.from(print.hashes));
  assert.deepEqual(Array.from(back.quiet), Array.from(print.quiet));
  assert.equal(back.offset, print.offset);
  assert.equal(back.seconds, 12.5);
});

test("remembered files are bounded and evicted oldest first", () => {
  const storage = new MapStorage();
  let clock = 0;
  const memory = new SkipMemory(storage, () => (clock += 1));
  for (let episodeNumber = 1; episodeNumber <= 310; episodeNumber += 1) {
    memory.saveMarkers({ show: "tt1", season: 1, episode: episodeNumber, source: "s" }, { intro: { start: 1, end: 40, source: "fingerprint" } });
  }
  assert.equal(memory.markers({ show: "tt1", season: 1, episode: 1, source: "s" }), null);
  assert.ok(memory.markers({ show: "tt1", season: 1, episode: 310, source: "s" }));
  assert.equal([...storage.map.keys()].filter((key) => key.includes(".file:")).length, 300);
});

test("a full storage keeps the season's signatures and drops bulky prints", () => {
  const storage = new MapStorage();
  const memory = new SkipMemory(storage);
  const print = fingerprintPcm(episode(3, 5));
  const signature = { ...print, seconds: 30 };
  storage.full = true;
  memory.saveSeason({ show: "tt2", season: 3 }, {
    intro: [signature],
    credits: [],
    openings: [{ episode: 1, print, duration: 100 }, { episode: 2, print, duration: 100 }],
    closings: [],
  });
  // Even the compact form is too big for this fake quota: nothing is written, nothing throws.
  assert.equal(memory.season({ show: "tt2", season: 3 }).intro.length, 0);
  storage.full = false;
  memory.saveSeason({ show: "tt2", season: 3 }, { intro: [signature], credits: [], openings: [], closings: [] });
  assert.equal(memory.season({ show: "tt2", season: 3 }).intro.length, 1);
});

// ── The detector, with fake sources ───────────────────────────────────────

function pcmSource(audio: Float64Array) {
  const calls: Array<[number, number]> = [];
  return {
    calls,
    pcm: async (start: number, seconds: number) => {
      calls.push([start, seconds]);
      const from = Math.round(start * FP_SAMPLE_RATE);
      const slice = audio.subarray(from, Math.min(audio.length, from + Math.round(seconds * FP_SAMPLE_RATE)));
      return Int16Array.from(slice, (value) => Math.round(Math.max(-1, Math.min(1, value)) * 32767));
    },
  };
}

test("chapters are used without reading any audio for what they name", async () => {
  const memory = new SkipMemory(new MapStorage());
  const source = pcmSource(new Float64Array(0));
  const published: SkipMarkers[] = [];
  await analyzeSkipMarkers({
    identity: { show: "tt3", season: 1, episode: 1, source: "x" },
    duration: () => 1500,
    memory,
    adapter: {
      chapters: async () => [
        { title: "Intro", start: 30, end: 90 },
        { title: "Episode", start: 90, end: 1400 },
        { title: "Credits", start: 1400, end: 1500 },
      ],
      pcm: source.pcm,
    },
    onMarkers: (found) => published.push(found),
    signal: new AbortController().signal,
  });
  assert.equal(source.calls.length, 0);
  assert.equal(published.at(-1)?.intro?.source, "chapter");
  assert.equal(published.at(-1)?.credits?.start, 1400);
});

test("the second episode of a season finds the intro while its opening is still being read", async () => {
  const memory = new SkipMemory(new MapStorage());
  const run = async (audio: Float64Array, episodeNumber: number) => {
    const source = pcmSource(audio);
    let firstIntroAfterCalls = -1;
    const result = await analyzeSkipMarkers({
      identity: { show: "tt4", season: 2, episode: episodeNumber, source: `s${episodeNumber}` },
      duration: () => audio.length / FP_SAMPLE_RATE,
      memory,
      adapter: { pcm: source.pcm },
      onMarkers: (found) => {
        if (found.intro && firstIntroAfterCalls < 0) firstIntroAfterCalls = source.calls.length;
      },
      signal: new AbortController().signal,
    });
    return { result, firstIntroAfterCalls, calls: source.calls.length };
  };
  const long = (cold: number, seed: number) => degrade(join(chatter(cold, seed), INTRO, chatter(400, seed + 1)), 1, seed + 2);
  const first = await run(long(20, 100), 1);
  assert.equal(first.result.intro, undefined, "nothing to compare the first episode with");
  const second = await run(long(75.5, 200), 2);
  assert.ok(second.result.intro, "intro not found in episode 2");
  assert.ok(Math.abs(second.result.intro!.start - 75.5) < 1.2);
  // Found after reading 2 one-minute chunks (the intro ends at 115.5 s), not at the end of the window.
  assert.equal(second.firstIntroAfterCalls, 2);
  const third = await run(long(5.25, 300), 3);
  assert.ok(Math.abs(third.result.intro!.start - 5.25) < 1.2);
  assert.equal(third.firstIntroAfterCalls, 1);
  // A rewatch of the first episode now knows its intro without any comparison.
  const again = await run(long(20, 100), 1);
  assert.ok(Math.abs(again.result.intro!.start - 20) < 1.2);
});

test("stopping playback stops the analysis", async () => {
  const controller = new AbortController();
  const source = pcmSource(chatter(700, 5));
  const memory = new SkipMemory(new MapStorage());
  const running = analyzeSkipMarkers({
    identity: { show: "tt5", season: 1, episode: 1, source: "x" },
    duration: () => 700,
    memory,
    adapter: {
      pcm: async (start, seconds, signal) => {
        if (source.calls.length === 1) controller.abort();
        if (signal.aborted) throw new DOMException("stopped", "AbortError");
        return source.pcm(start, seconds);
      },
    },
    onMarkers: () => {},
    signal: controller.signal,
  });
  await assert.rejects(running, { name: "AbortError" });
  assert.ok(source.calls.length <= 2);
});

test("analysis windows follow the episode length", () => {
  assert.equal(openingWindow(0), 600);
  assert.equal(openingWindow(1320), 594);
  assert.equal(openingWindow(2700), 600);
  assert.equal(openingWindow(240), 180);
  assert.equal(closingWindow(2700), 360);
  assert.equal(closingWindow(480), 150);
});
