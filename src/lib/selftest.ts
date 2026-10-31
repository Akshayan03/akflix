/**
 * Hidden playback self-test, for proving playback on this Mac (the iPhone app
 * has the same one).
 *
 * Launched with `--akflix-selftest-play <imdb id>[:season:episode][+upnext][,<next>...]`
 * (e.g. `open -a Akflix --args --akflix-selftest-play tt0903747:2:2+upnext`
 * on a cold start), the app presses Watch itself for each title through the
 * same path as the title page — sources, race, engine, StreamController, the
 * player — and logs every stage with its time since Play as JSON lines
 * (<app data>/selftest/selftest.jsonl). Nothing it plays is saved to history.
 *
 * `+upnext` (an episode) then checks Skip Recap / Skip Intro / the credits
 * card on that first play: when each marker arrived (and from where), the
 * buttons at the recap and intro, the card at the credits (or the fallback),
 * and that its countdown starts the next episode; with screenshots
 * (selftest/<title>-<step>.png). A key press or click stops it at once.
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/http";
import { cinemeta } from "@/api/cinemeta";
import { useTorrents } from "@/stores/torrentStore";
import { usePlayback } from "@/stores/playbackStore";
import { useSettings } from "@/stores/settingsStore";
import { automaticSafeSources } from "@/lib/sourceLanguage";
import { setSelftestActive } from "@/lib/selftestFlag";
import type { SkipMarkers } from "@/lib/skip/markers";
import type { StremioVideo } from "@/types/stremio";

const TITLE_LIMIT_MS = 150_000;
/** Seconds of advancing playback that count as "it plays". */
const PLAYING_PROOF_S = 3;

interface Target {
  id: string;
  season?: number;
  episode?: number;
  upnext?: boolean;
}

export function parseSelftestTargets(value: string): Target[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => /^tt\d+(?::\d+:\d+)?(?:\+upnext)?$/.test(part))
    .map((part) => {
      const upnext = part.endsWith("+upnext");
      const [id, season, episode] = part.replace(/\+upnext$/, "").split(":");
      const target: Target = season ? { id, season: Number(season), episode: Number(episode) } : { id };
      return upnext ? { ...target, upnext } : target;
    });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Someone is using the Mac: the self-test stops driving the app at once. */
let userTookOver = false;
let onUserTookOver: (() => void) | null = null;
function takeOver(event: Event): void {
  if (!event.isTrusted || userTookOver) return;
  userTookOver = true;
  onUserTookOver?.();
}

async function emit(record: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ at: new Date().toISOString(), ...record });
  console.log(`AKFLIX-SELFTEST ${line}`);
  await invoke("selftest_log", { line }).catch(() => {});
}

const snapshot = (label: string, step: string) =>
  invoke("selftest_snapshot", { name: `${label.replace(/[^a-z0-9]/gi, "-")}-${step}` }).catch(() => {});

/** The episodes after `current`, in order (the title page's queue). */
function episodesAfter(videos: StremioVideo[] | undefined, current: { season: number; episode: number }) {
  const ordered = (videos ?? [])
    .filter((video) => video.season > 0 && video.episode > 0)
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
  const index = ordered.findIndex((video) => video.season === current.season && video.episode === current.episode);
  if (index < 0) return [];
  return ordered.slice(index + 1).map((video) => ({
    season: video.season,
    episode: video.episode,
    title: video.name ?? video.title ?? `Episode ${video.episode}`,
    thumbnail: video.thumbnail,
    overview: video.overview,
  }));
}

/** Waits for a player event the page announces (akflix-upnext), or gives up after `ms`. */
function nextUpNextEvent(types: string[], ms: number): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      window.removeEventListener("akflix-upnext", on);
      resolve(null);
    }, ms);
    const on = (raw: Event) => {
      const detail = (raw as CustomEvent<Record<string, unknown>>).detail;
      if (!detail || !types.includes(String(detail.type))) return;
      clearTimeout(timer);
      window.removeEventListener("akflix-upnext", on);
      resolve(detail);
    };
    window.addEventListener("akflix-upnext", on);
  });
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 250) {
    if (check()) return true;
    await sleep(250);
  }
  return check();
}

async function upNextScenario(
  label: string,
  log: (stage: string, extra?: Record<string, unknown>) => void,
  markers: () => SkipMarkers
): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const result: Record<string, unknown> = {};
  const seek = (to: number) => usePlayback.getState().controls?.seek(Math.max(0, to));
  await snapshot(label, "1-playing");
  for (let waited = 0; waited < 20_000 && !markers().credits && !markers().intro; waited += 500) await sleep(500);
  result.markersAtCheck = markers();
  for (const kind of ["recap", "intro"] as const) {
    const segment = markers()[kind];
    if (!segment || userTookOver) continue;
    seek(segment.start + 1);
    await waitFor(() => Math.abs(usePlayback.getState().currentTime - (segment.start + 1)) < 4 && usePlayback.getState().isPlaying, 30_000);
    await sleep(2_500);
    await snapshot(label, `2-${kind}-button`);
    log(`upnext:${kind}Button`, { segment, playhead: usePlayback.getState().currentTime });
  }
  if (userTookOver) return result;
  const duration = usePlayback.getState().duration;
  const credits = markers().credits;
  const cardAt = credits?.start ?? duration - 40;
  result.expectedCard = { at: cardAt, reason: credits ? `credits (${credits.source})` : "fallback" };
  const cardEvent = nextUpNextEvent(["card"], 120_000);
  seek(cardAt - 6);
  log("upnext:seekBeforeCard", { to: cardAt - 6, duration });
  const card = await cardEvent;
  result.card = card ? { ...card, ms: Date.now() - t0, playhead: usePlayback.getState().currentTime } : null;
  log("upnext:card", { card: result.card });
  if (!card || userTookOver) return result;
  await sleep(1_500);
  await snapshot(label, "3-card");
  await sleep(4_000);
  await snapshot(label, "4-countdown");
  const before = usePlayback.getState().session?.subtitle;
  const next = await nextUpNextEvent(["next"], 30_000);
  const nextAt = Date.now();
  result.playNext = next;
  log("upnext:playNext", { next });
  if (!next || userTookOver) return result;
  const started = await waitFor(() => {
    const state = usePlayback.getState();
    return !!state.session && state.session.subtitle !== before && state.isPlaying && state.currentTime > 1;
  }, 120_000);
  result.nextEpisodePlayingMs = started ? Date.now() - nextAt : null;
  result.nextSubtitle = usePlayback.getState().session?.subtitle;
  log("upnext:nextEpisode", { playingMs: result.nextEpisodePlayingMs, subtitle: result.nextSubtitle });
  if (started) {
    await sleep(3_000);
    await snapshot(label, "5-next-episode");
  }
  return result;
}

async function runOne(target: Target, index: number): Promise<Record<string, unknown>> {
  const label = target.season ? `${target.id}:${target.season}:${target.episode}` : target.id;
  const t0 = Date.now();
  const log = (stage: string, extra: Record<string, unknown> = {}) =>
    void emit({ title: label, index, stage, ms: Date.now() - t0, ...extra });
  const type = target.season ? "series" : "movie";
  const meta = await cinemeta.meta(type, target.id).catch(() => null);
  const name = meta?.name ?? label;
  const media = {
    title: name,
    subtitle: target.season ? `S${target.season} E${target.episode}` : meta?.releaseInfo,
    catalogId: target.id,
    mediaType: type as "movie" | "series",
    season: target.season,
    episode: target.episode,
    isEpisode: !!target.season,
    posterUrl: meta?.poster,
    episodeQueue: target.season ? episodesAfter(meta?.videos, { season: target.season, episode: target.episode! }) : undefined,
  };
  log("play", { name, next: media.episodeQueue?.[0] ?? null });

  let outcome: Record<string, unknown> = { outcome: "timeout" };
  let markers: SkipMarkers = {};
  const unsubscribers: Array<() => void> = [];
  const onMarkers = (raw: Event) => {
    markers = (raw as CustomEvent<SkipMarkers>).detail ?? {};
    log("markers", { markers, playhead: usePlayback.getState().currentTime });
  };
  window.addEventListener("akflix-skip-markers", onMarkers);
  unsubscribers.push(() => window.removeEventListener("akflix-skip-markers", onMarkers));
  const done = new Promise<void>((resolve) => {
    const finish = (result: Record<string, unknown>) => {
      outcome = result;
      resolve();
    };
    onUserTookOver = () => finish({ outcome: "userTookOver" });
    let firstPosition: number | null = null;
    unsubscribers.push(
      usePlayback.subscribe((state) => {
        if (!state.session || !state.isPlaying) return;
        firstPosition ??= state.currentTime;
        if (state.currentTime - firstPosition >= PLAYING_PROOF_S) {
          finish({ outcome: "playing", playingMs: Date.now() - t0, position: state.currentTime });
        }
      })
    );
    let last = "";
    unsubscribers.push(
      useTorrents.subscribe((state) => {
        const snapshotKey = JSON.stringify([state.streamLaunchPhase, state.pendingStreamHash?.slice(0, 8), state.activeStreamHash?.slice(0, 8)]);
        if (snapshotKey === last) return;
        last = snapshotKey;
        log("engine", {
          phase: state.streamLaunchPhase,
          hash: state.pendingStreamHash?.slice(0, 8) ?? null,
          active: state.activeStreamHash?.slice(0, 8) ?? null,
        });
      })
    );
    setTimeout(() => finish({ outcome: "timeout" }), TITLE_LIMIT_MS);
  });

  try {
    const torrents = useTorrents.getState();
    usePlayback.getState().stop();
    const requestId = await torrents.beginStreamRequest(media);
    const lookup = target.season
      ? { imdbId: target.id, type: "series" as const, season: target.season, episode: target.episode }
      : { imdbId: target.id, type: "movie" as const };
    const results = await torrents.search(name, undefined, lookup);
    const eligible = automaticSafeSources(results, useSettings.getState().audioLanguage);
    log("sources", { all: results.length, eligible: eligible.length });
    if (!eligible.length) throw new Error("no eligible sources");
    await useTorrents.getState().raceStreamSources(eligible, media, requestId);
    await done;
    if (target.upnext && outcome.outcome === "playing" && !userTookOver) {
      outcome = { ...outcome, upnext: await upNextScenario(label, log, () => markers) };
    }
  } catch (error) {
    outcome = { outcome: "error", error: error instanceof Error ? error.message : String(error) };
  } finally {
    unsubscribers.forEach((stop) => stop());
    onUserTookOver = null;
  }
  log("result", outcome);
  if (!userTookOver) {
    usePlayback.getState().stop();
    await useTorrents.getState().finishActiveStream().catch(() => {});
  }
  return { title: label, name, totalMs: Date.now() - t0, ...outcome };
}

let started = false;

/** Runs once per app process when the launch argument is present. */
export async function runPlaybackSelftestIfRequested(navigate: (path: string) => void): Promise<void> {
  if (started || !isTauri()) return;
  started = true;
  const request = await invoke<string | null>("selftest_request").catch(() => null);
  if (!request) return;
  const targets = parseSelftestTargets(request);
  setSelftestActive(true);
  await emit({ stage: "selftest", targets: targets.length, request, cold: performance.now() });
  const engineWait = Date.now();
  while (!useTorrents.getState().qbtOnline && Date.now() - engineWait < 60_000) await sleep(250);
  await emit({ stage: "engine", online: useTorrents.getState().qbtOnline, ms: Date.now() - engineWait });
  window.addEventListener("pointerdown", takeOver, { capture: true });
  window.addEventListener("keydown", takeOver, { capture: true });
  navigate("/");
  const results = [];
  for (const [index, target] of targets.entries()) {
    if (userTookOver) break;
    results.push(await runOne(target, index));
    if (!userTookOver) await sleep(3_000);
  }
  window.removeEventListener("pointerdown", takeOver, { capture: true });
  window.removeEventListener("keydown", takeOver, { capture: true });
  await emit({ stage: "summary", results, ...(userTookOver ? { stopped: "userTookOver" } : {}) });
  setSelftestActive(false);
}
