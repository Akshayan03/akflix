/**
 * React side of discovery: this profile's synced history as `Signals`, and
 * the catalogue feeds, cache first. A refresh that arrives while someone is
 * scrolling the rows waits for the next visit instead of moving them.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/stores/authStore";
import { useHistory, type WatchHistoryEntry } from "@/stores/historyStore";
import { useMyList } from "@/stores/listStore";
import { useEngagement } from "@/stores/engagementStore";
import { loadDiscovery } from "@/lib/discovery/feeds";
import type { DiscoveryData } from "@/lib/discovery/rows";
import { collectSeeds, type Signals } from "@/lib/discovery/taste";

const HOUR = 3_600_000;
const LOCAL_PROFILE = "akflix-local";

/**
 * Signals for the active profile. The result only changes when something a
 * recommendation could notice changes (not every few seconds of playback).
 */
export function useDiscoverySignals(extraHistory: WatchHistoryEntry[] = []): Signals {
  const profileId = useAuth((state) => state.activeProfileId) ?? LOCAL_PROFILE;
  const entries = useHistory((state) => state.entries);
  const ratings = useHistory((state) => state.ratings);
  const list = useMyList((state) => state.items);
  const engagement = useEngagement((state) => state.rows);
  const hour = Math.floor(Date.now() / HOUR);
  const mine = <T extends { profileId: string }>(rows: T[]) => rows.filter((row) => row.profileId === profileId);
  const history = [...mine(entries), ...extraHistory];
  const key = JSON.stringify([
    profileId,
    hour,
    history.map((e) => [e.media.source, e.media.type, e.media.id, e.completed ? 1 : 0, e.season ?? 0, e.episode ?? 0, Math.round(e.progress / 10), Math.floor(e.updatedAt / HOUR)]),
    mine(ratings).map((r) => [r.media.type, r.media.id, r.value]),
    mine(list).map((l) => [l.media.type, l.media.id, l.saved ? 1 : 0]),
    mine(engagement).map((e) => [e.media.type, e.media.id, e.plays, e.rewatches, e.binges]),
  ]);
  return useMemo(
    () => ({ now: Date.now(), history, ratings: mine(ratings), list: mine(list), engagement: mine(engagement) }),
    // Rebuilt only when the coarse key changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key]
  );
}

/** What the feeds depend on: shows watched, favourite genres, strongest titles. */
function needsKey(signals: Signals) {
  const seeds = collectSeeds(signals).filter((seed) => seed.catalog);
  return [
    seeds.filter((seed) => seed.type === "series").map((seed) => seed.id).sort().join(","),
    seeds.slice(0, 12).map((seed) => seed.key).join(","),
  ].join("|");
}

const hasCatalog = (data: DiscoveryData) => data.trendingMovies.length + data.trendingSeries.length + data.newMovies.length + data.newSeries.length > 0;

let remembered: { profileId: string; data: DiscoveryData } | null = null;

export interface DiscoveryState {
  data: DiscoveryData | null;
  /** Nothing could be loaded and nothing was cached. */
  failed: boolean;
  retry: () => void;
}

export function useDiscoveryData(signals: Signals): DiscoveryState {
  const profileId = useAuth((state) => state.activeProfileId) ?? LOCAL_PROFILE;
  const [data, setData] = useState<DiscoveryData | null>(() => (remembered?.profileId === profileId ? remembered.data : null));
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const shown = useRef<{ profileId: string; data: DiscoveryData } | null>(data ? { profileId, data } : null);
  const latestSignals = useRef(signals);
  latestSignals.current = signals;
  const needs = useMemo(() => needsKey(signals), [signals]);

  useEffect(() => {
    const controller = new AbortController();
    const show = (next: DiscoveryData) => {
      shown.current = { profileId, data: next };
      remembered = { profileId, data: next };
      setData(next);
      setFailed(false);
    };
    (async () => {
      const current = latestSignals.current;
      const cached = await loadDiscovery(current, { network: false });
      if (controller.signal.aborted) return;
      // A copy this session already showed is at least as new as the disk cache.
      if (hasCatalog(cached.data) && shown.current?.profileId !== profileId) show(cached.data);
      if (cached.complete && hasCatalog(cached.data)) return;
      const fresh = await loadDiscovery(current, { signal: controller.signal }).catch(() => null);
      if (controller.signal.aborted || !fresh) return;
      if (!hasCatalog(fresh.data)) {
        if (shown.current?.profileId !== profileId) setFailed(true);
        return;
      }
      // Near the top the rows are mostly below the fold; further down, keep
      // what is on screen and use the refresh next time.
      if (shown.current?.profileId !== profileId || typeof window === "undefined" || window.scrollY < 120) show(fresh.data);
      else remembered = { profileId, data: fresh.data };
    })().catch(() => {
      if (!controller.signal.aborted && shown.current?.profileId !== profileId) setFailed(true);
    });
    return () => controller.abort();
  }, [profileId, needs, attempt]);

  return {
    data,
    failed,
    retry: () => {
      setFailed(false);
      setAttempt((value) => value + 1);
    },
  };
}
