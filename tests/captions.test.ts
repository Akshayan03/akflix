/**
 * Captions: one track rendered at a time, framed to the picture, offsets that
 * keep each cue's lines, and generated captions without doubled lines.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { captionFrame, showOnlyCaptionTrack } from "../src/lib/captionDisplay";
import { cuesToVtt, offsetSubtitle, parseVttCues, sequentialCues, subtitleToVtt } from "../src/lib/manualCaptions";

const track = (mode: TextTrackMode, kind = "subtitles") => ({ mode, kind });

test("only the selected caption track shows, whatever WebKit turned on", () => {
  // Akflix tracks, then the file's in-band subtitle and forced tracks that
  // WebKit's automatic selection may have shown on its own, a chapter track
  // and hls.js's ID3 metadata track (left as their owners set them).
  const english = track("disabled");
  const english2 = track("showing");
  const inband = track("showing", "captions");
  const forced = track("hidden", "forced");
  const chapters = track("hidden", "chapters");
  const id3 = track("hidden", "metadata");
  const tracks = [english, english2, inband, forced, chapters, id3];
  showOnlyCaptionTrack(tracks, english);
  assert.deepEqual(tracks.map((t) => t.mode), ["showing", "disabled", "disabled", "disabled", "hidden", "hidden"]);
  showOnlyCaptionTrack(tracks, null);
  assert.deepEqual(tracks.map((t) => t.mode), ["disabled", "disabled", "disabled", "disabled", "hidden", "hidden"]);
});

test("captions are framed to a letterboxed picture, not the window edge", () => {
  // The reported window: 16:9 video in a slightly taller window.
  const frame = captionFrame({ width: 1218, height: 725 }, { width: 640, height: 360 })!;
  assert.equal(Math.round(frame.top), 20);
  assert.equal(Math.round(frame.left), 0);
  assert.equal(Math.round(frame.width), 1218);
  const pictureBottom = frame.top + 685;
  const captionBottom = frame.top + frame.height;
  assert.ok(captionBottom < pictureBottom - 30, "last line clearly above the picture's bottom edge");
  assert.ok(captionBottom > frame.top + 685 * 0.85, "but still in the lower part of the picture");
});

test("a pillarboxed picture keeps captions within its width", () => {
  const frame = captionFrame({ width: 1600, height: 600 }, { width: 640, height: 360 })!;
  assert.equal(Math.round(frame.top), 0);
  assert.equal(Math.round(frame.width), 1067);
  assert.equal(Math.round(frame.left), 267);
});

test("visible controls lift captions above them, never into the top half", () => {
  const hidden = captionFrame({ width: 1280, height: 720 }, { width: 1920, height: 1080 })!;
  const shown = captionFrame({ width: 1280, height: 720 }, { width: 1920, height: 1080 }, 110)!;
  assert.ok(hidden.height > 720 - 64 - 1 && hidden.height < 720 - 30);
  assert.equal(shown.height, 720 - 110 - 12);
  // Controls taller than half a small picture cannot push captions to its top.
  const tiny = captionFrame({ width: 400, height: 225 }, { width: 1920, height: 1080 }, 180)!;
  assert.ok(tiny.height >= 225 * 0.55 - 0.01);
  // Letterbox bars below the picture already clear the controls: no extra lift.
  const tall = captionFrame({ width: 900, height: 900 }, { width: 1920, height: 1080 }, 110)!;
  const tallHidden = captionFrame({ width: 900, height: 900 }, { width: 1920, height: 1080 })!;
  assert.equal(tall.height, tallHidden.height);
});

test("caption text scales with the picture within limits", () => {
  assert.equal(captionFrame({ width: 256, height: 144 }, { width: 640, height: 360 })!.fontSize, 12);
  const window = captionFrame({ width: 1218, height: 725 }, { width: 640, height: 360 })!.fontSize;
  assert.ok(window >= 16 && window <= 19, `ordinary window ${window}`);
  assert.equal(captionFrame({ width: 3840, height: 2160 }, { width: 1920, height: 1080 })!.fontSize, 40);
  assert.equal(captionFrame({ width: 1218, height: 725 }, { width: 0, height: 0 }), null);
});

const srt = [
  "1",
  "00:00:01,000 --> 00:00:03,500",
  "- Who left the gate open?",
  "- Not me, I just got here.",
  "",
  "2",
  "00:00:04,000 --> 00:00:06,000 line:10%",
  "<i>The bus is late again.</i>",
  "",
  "3",
  "00:01:10,250 --> 00:01:12,000",
  "Later line",
  "",
].join("\r\n");

test("an offset moves cues but keeps their lines, styling and settings", () => {
  const vtt = subtitleToVtt(srt);
  const earlier = offsetSubtitle(vtt, -2);
  // The first cue starts before zero and is clamped; both speakers keep their own line.
  assert.match(earlier, /00:00:00\.000 --> 00:00:01\.500\n- Who left the gate open\?\n- Not me, I just got here\./);
  assert.match(earlier, /00:00:02\.000 --> 00:00:04\.000 line:10%\n<i>The bus is late again\.<\/i>/);
  assert.match(earlier, /00:01:08\.250 --> 00:01:10\.000\nLater line/);
  assert.ok(earlier.startsWith("WEBVTT"));
  // Cues that end before the start are gone.
  const muchEarlier = offsetSubtitle(vtt, -5);
  assert.equal(parseVttCues(muchEarlier).length, 2);
  assert.doesNotMatch(muchEarlier, /Who left/);
  const later = offsetSubtitle(vtt, 1.2);
  assert.match(later, /00:00:02\.200 --> 00:00:04\.700\n- Who left the gate open\?\n- Not me/);
  assert.match(later, /01:11\.450 --> 00:01:13\.200\nLater line/);
  assert.equal(offsetSubtitle(vtt, 0), vtt);
});

test("generated captions never show two lines for the same speech", () => {
  // Two recognition windows overlapping by two seconds: the second repeats
  // the end of the first with other timing, then moves on.
  const cues = sequentialCues([
    { start: 996.17, end: 1005.85, text: "We never meant to stay so long, the snow kept falling and the lamp post was gone" },
    { start: 1004.29, end: 1013.21, text: "the snow kept falling and the lamp post was gone" },
    { start: 1013.5, end: 1016, text: "Where are we?" },
    { start: 1015.2, end: 1018, text: "Somewhere very cold." },
  ]);
  assert.equal(cues.length, 3);
  for (let i = 1; i < cues.length; i += 1) {
    assert.ok(cues[i].start >= cues[i - 1].end, `cue ${i} overlaps the previous one`);
  }
  assert.equal(cues[0].end, 1013.21);
  assert.match(cues[0].text, /^We never meant/);
  assert.equal(cues[1].end, 1015.2);
  // Generated captions stored before this fix are shown without the overlap too.
  const stored = cuesToVtt([
    { start: 1, end: 4, text: "Close the door." },
    { start: 3, end: 6, text: "It is freezing out there." },
    { start: 5.5, end: 7, text: "It is freezing out there." },
  ]);
  const shown = sequentialCues(parseVttCues(stored));
  assert.deepEqual(shown.map((cue) => [cue.start, cue.end]), [[1, 3], [3, 7]]);
});

test("an SSA/ASS file does not turn into captions or break the track", () => {
  const ass = "[Script Info]\nTitle: x\n\n[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello";
  assert.equal(parseVttCues(ass).length, 0);
  assert.ok(subtitleToVtt(ass).startsWith("WEBVTT"));
});
