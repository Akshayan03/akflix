/**
 * Home — hero banner + rows:
 * Continue Watching, My List, then personal discovery rows ordered by
 * predicted interest (lib/discovery): new episodes of your shows, Top picks,
 * Because you watched/liked, What's New, More from, taste genres, Trending,
 * Hidden gems, Top rated, Watch it again. Popular rows and Jellyfin rows follow.
 */

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useAuth } from "@/stores/authStore";
import { useT } from "@/i18n";
import HeroBanner from "@/components/HeroBanner";
import DiscoverHero from "@/components/DiscoverHero";
import DiscoverRow from "@/components/DiscoverRow";
import PickThree, { pickThreeDismissed } from "@/components/PickThree";
import { savedTitlesFor, useMyList } from "@/stores/listStore";
import MediaRow from "@/components/MediaRow";
import { HomeSkeleton, RowSkeleton } from "@/components/Skeletons";
import type { BaseItem } from "@/types/jellyfin";
import type { StremioMeta } from "@/types/stremio";
import { useHistory, type WatchHistoryEntry } from "@/stores/historyStore";
import type { DiscoverCardState } from "@/components/DiscoverCard";
import { balancedCatalog } from "@/lib/catalogRanking";
import { planHome, type HomeRow } from "@/lib/discovery/rows";
import { FALLBACK_GENRES } from "@/lib/discovery/feeds";
import { useDiscoveryData, useDiscoverySignals } from "@/lib/discovery/useDiscovery";

const GENRE_ROWS = ["Action", "Comedy", "Drama", "Science Fiction", "Horror", "Animation"];

interface HomeData {
  hero: BaseItem | null;
  resume: BaseItem[];
  nextUp: BaseItem[];
  favorites: BaseItem[];
  watched: BaseItem[];
  latestByLibrary: { name: string; items: BaseItem[] }[];
  genreRows: { genre: string; items: BaseItem[] }[];
}

const emptyHome = (): HomeData => ({
  hero: null,
  resume: [],
  nextUp: [],
  favorites: [],
  watched: [],
  latestByLibrary: [],
  genreRows: [],
});

const cardKey = (item: { type: string; id: string }) => `${item.type}:${item.id}`;

export default function Home() {
  const t = useT();
  const client = useAuth((s) => s.client)();
  const profileId = useAuth((s) => s.activeProfileId);
  const historyEntries = useHistory((state) => state.entries);
  const personalRatings = useHistory((state) => state.ratings);
  const listItems = useMyList((state) => state.items);
  const [data, setData] = useState<HomeData | null>(null);
  const [startDismissed, setStartDismissed] = useState(() => pickThreeDismissed(profileId ?? "akflix-local"));

  useEffect(() => setStartDismissed(pickThreeDismissed(profileId ?? "akflix-local")), [profileId]);

  useEffect(() => {
    if (!client) {
      setData(emptyHome());
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        // Library views first (needed for the per-library "Latest" rows).
        const views = await client.views();
        const mediaViews = views.Items.filter((v) =>
          ["movies", "tvshows"].includes(v.CollectionType ?? "")
        );

        const [resume, nextUp, favorites, watched, latest, genres] = await Promise.all([
          client.resumeItems(),
          client.nextUp(),
          client.favorites(),
          client.watchedItems().catch(() => ({ Items: [], TotalRecordCount: 0 })),
          Promise.all(
            mediaViews.map(async (v) => ({
              name: v.Name,
              items: await client.latest(v.Id),
            }))
          ),
          Promise.all(
            GENRE_ROWS.map(async (genre) => ({
              genre,
              items: (await client.byGenre(genre)).Items,
            }))
          ),
        ]);

        // Hero: newest item with a backdrop, falling back to anything recent.
        const pool = latest.flatMap((l) => l.items);
        const hero =
          pool.find((i) => i.BackdropImageTags?.length) ?? pool[0] ?? null;

        if (!cancelled) {
          setData({
            hero,
            resume: resume.Items,
            nextUp: nextUp.Items,
            favorites: favorites.Items,
            watched: watched.Items,
            latestByLibrary: latest,
            genreRows: genres.filter((g) => g.items.length > 0),
          });
        }
      } catch {
        // Jellyfin is optional. An offline saved server must never hide the
        // standalone catalogue.
        if (!cancelled) setData(emptyHome());
      }
    })();

    return () => {
      cancelled = true;
    };
    // Re-fetch when the active profile changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId]);

  // Titles watched on Jellyfin shape the taste profile too (genres only).
  const jellyfinHistory = useMemo<WatchHistoryEntry[]>(
    () =>
      (data?.watched ?? []).map((item, index) => ({
        profileId: profileId ?? "akflix-local",
        media: {
          source: "jellyfin",
          id: item.Id,
          type: item.Type === "Series" ? "series" : "movie",
          name: item.Name,
          description: item.Overview,
          releaseInfo: item.ProductionYear?.toString(),
          year: item.ProductionYear?.toString(),
          imdbRating: item.CommunityRating?.toString(),
          genres: item.Genres,
        },
        position: 0,
        duration: 0,
        progress: 100,
        completed: true,
        updatedAt: Date.now() - index,
      })),
    [data?.watched, profileId]
  );
  const profileHistory = useMemo(
    () => historyEntries.filter((entry) => entry.profileId === profileId),
    [historyEntries, profileId]
  );
  const profileRatings = useMemo(
    () => personalRatings.filter((rating) => rating.profileId === profileId),
    [personalRatings, profileId]
  );

  const personalRows = useMemo(() => {
    const toMeta = (media: (typeof profileHistory)[number]["media"]): StremioMeta => ({
      id: media.id,
      type: media.type,
      name: media.name,
      poster: media.poster ?? undefined,
      background: media.background ?? undefined,
      description: media.description,
      releaseInfo: media.releaseInfo,
      year: media.year,
      imdbRating: media.imdbRating,
      genres: media.genres,
    });
    const catalogHistory = profileHistory.filter((entry) => entry.media.source === "discover");
    const continuing = catalogHistory
      .filter(
        (entry) =>
          !entry.completed &&
          (entry.progress > 0 ||
            (entry.media.type === "series" && !!entry.season && !!entry.episode))
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const cardState: Record<string, DiscoverCardState> = {};

    for (const entry of catalogHistory) {
      const key = `${entry.media.type}:${entry.media.id}`;
      cardState[key] = {
        ...cardState[key],
        progress: entry.progress,
        watched: entry.completed,
        resumeLabel:
          entry.media.type === "series" && entry.season && entry.episode
            ? `Season ${entry.season} Episode ${entry.episode}${entry.subtitle?.includes("·") ? ` · ${entry.subtitle.split("·").slice(1).join("·").trim()}` : ""}`
            : undefined,
      };
    }
    for (const rating of profileRatings) {
      if (rating.media.source !== "discover") continue;
      const key = `${rating.media.type}:${rating.media.id}`;
      cardState[key] = { ...cardState[key], rating: rating.value };
    }

    const myList = savedTitlesFor(listItems, profileId ?? "akflix-local")
      .filter((item) => item.media.source === "discover")
      .map((item) => toMeta(item.media));

    return {
      continuing: continuing.map((entry) => toMeta(entry.media)),
      myList,
      cardState,
    };
  }, [profileHistory, profileRatings, listItems, profileId]);

  const signals = useDiscoverySignals(jellyfinHistory);
  const discovery = useDiscoveryData(signals);
  const continuingKeys = useMemo(() => personalRows.continuing.map(cardKey), [personalRows.continuing]);
  const plan = useMemo(
    () => (discovery.data ? planHome(signals, discovery.data, { continuing: continuingKeys }) : null),
    [signals, discovery.data, continuingKeys]
  );


  const rows = useMemo(() => {
    if (!data || !plan || !discovery.data) return null;
    const feeds = discovery.data;
    // Discovery cards keep the progress/rating marks and add why and what's
    // new; a resume label would only repeat Continue Watching.
    const stateFor = (row: HomeRow) => {
      const state: Record<string, DiscoverCardState> = {};
      for (const item of row.items) {
        const key = cardKey(item);
        const own = personalRows.cardState[key];
        // On "your shows" cards the last episode's progress would read as the new one's.
        const yours = row.kind === "new-episodes" || row.kind === "finish-series";
        state[key] = { ...own, progress: yours ? undefined : own?.progress, resumeLabel: undefined, badge: row.badges[key], reason: row.reasons[key] };
      }
      return state;
    };
    const planRow = (row: HomeRow, index: number) => (
      <DiscoverRow
        key={row.id}
        id={`home-${row.kind}`}
        title={row.title}
        tagline={row.tagline}
        items={row.items}
        cardState={stateFor(row)}
        variant={row.variant}
        seeAll={row.seeAll}
        className={index >= 3 ? `ak-lazy-row ${row.variant === "landscape" ? "ak-lazy-row--landscape" : ""}` : ""}
      />
    );
    const popularMovies = balancedCatalog([...feeds.trendingMovies, ...feeds.catalog.filter((item) => item.type === "movie")]);
    const popularSeries = balancedCatalog([...feeds.trendingSeries, ...feeds.catalog.filter((item) => item.type === "series")]);
    const tasteGenreRows = plan.rows.some((row) => row.kind === "genre");
    const lead = plan.rows.slice(0, 2);
    const rest = plan.rows.slice(2);
    const showStart = plan.coldStart && !startDismissed && plan.onboarding.length >= 6;
    const continuingState: Record<string, DiscoverCardState> = { ...personalRows.cardState };
    for (const [key, badge] of Object.entries(plan.continueBadges)) {
      if (badge) continuingState[key] = { ...continuingState[key], badge };
    }
    return (
      <div className="relative z-10 -mt-8 md:-mt-20">
        <DiscoverRow
          title="Continue Watching"
          tagline="Pick up where you left off"
          items={personalRows.continuing}
          cardState={continuingState}
          variant="landscape"
        />
        {showStart && (
          <PickThree profileId={profileId ?? "akflix-local"} items={plan.onboarding} onDone={() => setStartDismissed(true)} />
        )}
        {lead.map(planRow)}
        <DiscoverRow
          id="my-list"
          title="My List"
          tagline="Saved on every screen you sign in to"
          items={personalRows.myList}
          cardState={personalRows.cardState}
        />
        <MediaRow title={t("row.continueWatching")} items={data.resume} variant="landscape" />
        {rest.map((row, index) => planRow(row, index + 2))}
        <DiscoverRow title="Popular Movies" items={popularMovies} cardState={personalRows.cardState} className="ak-lazy-row" />
        <DiscoverRow title="Popular Series" items={popularSeries} cardState={personalRows.cardState} className="ak-lazy-row" />
        {!tasteGenreRows &&
          FALLBACK_GENRES.map(({ type, genre, title }) => (
            <DiscoverRow
              key={title}
              title={title}
              items={balancedCatalog(feeds.byGenre[`${type}:${genre}`] ?? [])}
              cardState={personalRows.cardState}
              className="ak-lazy-row"
            />
          ))}
        <MediaRow title="Watched in Jellyfin" items={data.watched} />
        <MediaRow title={t("row.nextUp")} items={data.nextUp} variant="landscape" />
        <MediaRow title={personalRows.myList.length ? `${t("row.myList")} · Jellyfin` : t("row.myList")} items={data.favorites} />
        {data.latestByLibrary.map((l) => (
          <MediaRow
            key={l.name}
            title={`${t("row.recentlyAdded")} · ${l.name}`}
            items={l.items}
          />
        ))}
        {data.genreRows.map((g) => (
          <MediaRow key={g.genre} title={g.genre} items={g.items} />
        ))}
      </div>
    );
  }, [data, plan, discovery.data, personalRows, profileId, startDismissed, t]);

  if (!data || (!discovery.data && !discovery.failed)) return <HomeSkeleton />;

  return (
    <motion.main
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="pb-16"
    >
      {data.hero ? (
        <HeroBanner item={data.hero} />
      ) : plan?.hero ? (
        <DiscoverHero item={plan.hero.item} eyebrow={plan.hero.eyebrow} />
      ) : null}
      {discovery.failed && (
        <div className={`ak-gutter ${data.hero ? "mb-10" : "pb-6 pt-28"}`}>
          <div role="alert" className="ak-notice ak-notice--error max-w-2xl">
            <AlertTriangle size={18} aria-hidden="true" />
            <div className="min-w-0">
              <p><strong>The movie and series catalog didn't load.</strong> Check your internet connection, then try again.</p>
              <button onClick={discovery.retry} className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-full bg-black px-4 text-xs font-bold text-white">
                <RefreshCw size={14} aria-hidden="true" /> Try again
              </button>
            </div>
          </div>
        </div>
      )}
      {rows ?? (discovery.failed ? <FailedRows continuing={personalRows.continuing} myList={personalRows.myList} cardState={personalRows.cardState} /> : <RowSkeleton />)}
    </motion.main>
  );
}

/** With no catalogue at all, the rows from this device's own history still show. */
function FailedRows({
  continuing,
  myList,
  cardState,
}: {
  continuing: StremioMeta[];
  myList: StremioMeta[];
  cardState: Record<string, DiscoverCardState>;
}) {
  return (
    <div className="relative z-10">
      <DiscoverRow title="Continue Watching" tagline="Pick up where you left off" items={continuing} cardState={cardState} variant="landscape" />
      <DiscoverRow id="my-list" title="My List" tagline="Saved on every screen you sign in to" items={myList} cardState={cardState} />
    </div>
  );
}
