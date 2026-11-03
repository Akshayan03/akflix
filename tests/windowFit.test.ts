// Windowed playback takes the picture's shape (lib/windowFit.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PLAYER_MIN_SIZE, fittedWindowSize } from "../src/lib/windowFit";

const screen = { width: 1512, height: 944 };

test("the owner's window keeps its width and loses the black bands", () => {
  // Screenshot of Oct 30: a 1110 x 600 window around a 2.39:1 picture.
  assert.deepEqual(fittedWindowSize({ width: 1110, height: 600 }, { width: 1920, height: 804 }, screen), { width: 1110, height: 465 });
  // A 16:9 episode in the default 1440 x 860 window.
  assert.deepEqual(fittedWindowSize({ width: 1440, height: 860 }, { width: 1920, height: 1080 }, screen), { width: 1440, height: 810 });
});

test("a window that already fits is left alone", () => {
  assert.equal(fittedWindowSize({ width: 1280, height: 720 }, { width: 1920, height: 1080 }, screen), null);
  assert.equal(fittedWindowSize({ width: 1281, height: 721 }, { width: 1920, height: 1080 }, screen), null);
});

test("too tall for the screen: the window shrinks in both directions, keeping the shape", () => {
  const fit = fittedWindowSize({ width: 1400, height: 800 }, { width: 1440, height: 1080 }, screen)!;
  assert.equal(fit.height, screen.height - 48);
  assert.equal(fit.width, Math.round(fit.height * (4 / 3)));
});

test("never below the player's minimum size, never for unknown sizes", () => {
  const fit = fittedWindowSize({ width: 700, height: 400 }, { width: 2400, height: 1000 }, screen)!;
  assert.ok(fit.height >= PLAYER_MIN_SIZE.height && fit.width >= PLAYER_MIN_SIZE.width);
  assert.equal(fit.width, Math.round(PLAYER_MIN_SIZE.height * 2.4));
  assert.equal(fittedWindowSize({ width: 1200, height: 700 }, { width: 0, height: 0 }, screen), null);
});

test("the player never resizes the window to the picture (owner, 1.0.39)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("src/lib/windowFit.ts", "utf8");
  assert.doesNotMatch(src, /setSize\(new LogicalSize\(target\.width, target\.height\)\)/);
});
