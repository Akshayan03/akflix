/**
 * Runs skip-marker detection in the background for whatever is playing and
 * returns the markers found so far. Detection waits until playback is under
 * way, never blocks it, and stops when the episode changes or the player
 * closes.
 */

import { useEffect, useState } from "react";
import { analyzeSkipMarkers, type SkipSourceAdapter } from "./detector";
import { SkipMemory, type SkipStorage } from "./cache";
import type { SkipIdentity, SkipMarkers } from "./markers";
import { abortableSleep } from "./streamReader";

export interface SkipSubject {
  /** Changes whenever a different file starts playing. */
  key: string;
  identity: SkipIdentity;
  adapter: SkipSourceAdapter;
  duration: () => number;
  playhead: () => number;
  /** Checked before reading the opening (see SkipAnalysis.wantIntro). */
  wantIntro?: () => boolean;
}

let sharedMemory: SkipMemory | null = null;

/** Storage that never throws (private mode, quota, no window). */
function browserStorage(): SkipStorage {
  return {
    getItem: (key) => {
      try {
        return globalThis.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    setItem: (key, value) => globalThis.localStorage?.setItem(key, value),
    removeItem: (key) => {
      try {
        globalThis.localStorage?.removeItem(key);
      } catch {
        // Nothing to clean up when storage is unavailable.
      }
    },
  };
}

export function skipMemory(): SkipMemory {
  sharedMemory ??= new SkipMemory(browserStorage());
  return sharedMemory;
}

/** Playback is under way: the playhead moved a little, or enough time passed. */
async function playbackStarted(subject: SkipSubject, signal: AbortSignal) {
  const from = subject.playhead();
  for (let waited = 0; waited < 12_000; waited += 500) {
    if (Math.abs(subject.playhead() - from) >= 2) return;
    await abortableSleep(500, signal);
  }
}

const SKIP_DEBUG = (() => {
  try {
    return globalThis.localStorage?.getItem("akflix.skip.debug") === "1";
  } catch {
    return false;
  }
})();

const NO_MARKERS: SkipMarkers = Object.freeze({});

export function useSkipMarkers(subject: SkipSubject | null): SkipMarkers {
  const [state, setState] = useState<{ key: string | null; markers: SkipMarkers }>({ key: null, markers: {} });

  useEffect(() => {
    if (!subject) return;
    const controller = new AbortController();
    const { key } = subject;
    setState({ key, markers: {} });
    const log = (message: string) => {
      if (SKIP_DEBUG) console.info(`[skip ${subject.identity.show} S${subject.identity.season}E${subject.identity.episode}] ${message}`);
    };
    void (async () => {
      try {
        await playbackStarted(subject, controller.signal);
        await analyzeSkipMarkers({
          identity: subject.identity,
          duration: subject.duration,
          memory: skipMemory(),
          adapter: subject.adapter,
          onMarkers: (markers) => {
            if (!controller.signal.aborted) setState({ key, markers });
          },
          signal: controller.signal,
          log,
          wantIntro: subject.wantIntro,
        });
      } catch (reason) {
        if ((reason as Error)?.name !== "AbortError") log(`stopped: ${reason instanceof Error ? reason.message : String(reason)}`);
      }
    })();
    return () => controller.abort();
    // The key identifies the subject; its functions read live state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject?.key]);

  return subject && state.key === subject.key ? state.markers : NO_MARKERS;
}
