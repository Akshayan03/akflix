import { test } from "node:test";
import assert from "node:assert/strict";
import { installOutsideDismiss, pressIsInPanel, type DismissTarget } from "../src/lib/outsideDismiss";

/** A window stand-in: capture listeners in order, events with their own target. */
function fakeWindow() {
  const listeners = new Map<string, Array<(event: Event) => void>>();
  const target: DismissTarget = {
    addEventListener: (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    removeEventListener: (type, listener) => listeners.set(type, (listeners.get(type) ?? []).filter((l) => l !== listener)),
  };
  /** Sends one event; returns whether the page (the video, the play button…) would still see it. */
  const send = (type: string, node: unknown) => {
    let stopped = false;
    let prevented = false;
    const event = {
      type,
      target: node,
      preventDefault: () => { prevented = true; },
      stopPropagation: () => { stopped = true; },
      stopImmediatePropagation: () => { stopped = true; },
    } as unknown as Event;
    for (const listener of listeners.get(type) ?? []) {
      listener(event);
      if (stopped) break;
    }
    return { reachesPage: !stopped, prevented };
  };
  const count = () => [...listeners.values()].reduce((n, list) => n + list.length, 0);
  return { target, send, count };
}

/** An element whose ancestors match the given selectors. */
const node = (...matches: string[]) => ({
  closest: (selector: string) => (selector.split(",").some((s) => matches.includes(s.trim())) ? {} : null),
});

const press = (win: ReturnType<typeof fakeWindow>, at: unknown) =>
  ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].map((type) => win.send(type, at).reachesPage);

test("a click on the video closes the captions panel and does nothing else", () => {
  const win = fakeWindow();
  let closed = 0;
  installOutsideDismiss(win.target, pressIsInPanel, () => { closed += 1; });
  assert.deepEqual(press(win, node("#player-surface")), [false, false, false, false, false]);
  assert.equal(closed, 1);
  assert.equal(win.send("pointerdown", node()).prevented, true);
});

test("clicks inside the panel and on the panel buttons go through", () => {
  const win = fakeWindow();
  let closed = 0;
  installOutsideDismiss(win.target, pressIsInPanel, () => { closed += 1; });
  assert.deepEqual(press(win, node(".ak-pop")), [true, true, true, true, true]);
  assert.deepEqual(press(win, node("[data-panel-toggle]")), [true, true, true, true, true]);
  assert.deepEqual(press(win, node(".ak-episodes--open")), [true, true, true, true, true]);
  assert.equal(closed, 0);
});

test("the closing click is swallowed even after the panel is gone, then clicks work again", () => {
  const win = fakeWindow();
  let cleanup = () => {};
  cleanup = installOutsideDismiss(win.target, pressIsInPanel, () => cleanup());
  // The play button: pointerdown closes (React removes the listeners), its click still must not toggle playback.
  assert.equal(win.send("pointerdown", node(".ak-chrome__play")).reachesPage, false);
  assert.equal(win.send("click", node(".ak-chrome__play")).reachesPage, false);
  assert.equal(win.send("click", node(".ak-chrome__play")).reachesPage, true);
  assert.equal(win.send("pointerdown", node(".ak-chrome__play")).reachesPage, true);
});

test("a press that never clicks stops being swallowed", () => {
  const win = fakeWindow();
  let clock = 0;
  installOutsideDismiss(win.target, pressIsInPanel, () => {}, () => clock);
  win.send("pointerdown", node());
  clock = 5000;
  assert.equal(win.send("click", node()).reachesPage, true);
});

test("closing with nothing pending removes every listener", () => {
  const win = fakeWindow();
  const cleanup = installOutsideDismiss(win.target, pressIsInPanel, () => {});
  assert.ok(win.count() > 0);
  cleanup();
  assert.equal(win.count(), 0);
});
