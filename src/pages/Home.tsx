/**
 * Home — hero banner + Netflix-style rows:
 * Continue Watching, Next Up, My List, Recently Added per library, genre rows.
 */

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useAuth } from "@/stores/authStore";
import { useT } from "@/i18n";
import HeroBanner from "@/components/HeroBanner";
import DiscoverHero from "@/components/DiscoverHero";
import DiscoverRow from "@/components/DiscoverRow";
import MediaRow from "@/components/MediaRow";
import { HomeSkeleton } from "@/components/Skeletons";
import { cinemeta } from "@/api/cinemeta";
import type { BaseItem } from "@/types/jellyfin";
import type { StremioMeta } from "@/types/stremio";
import { useHistory, type WatchHistoryEntry } from "@/stores/historyStore";
import { recommendedTitles } from "@/lib/recommendations";
import type { DiscoverCardState } from "@/components/DiscoverCard";

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

interface DiscoverData {
  hero: StremioMeta | null;
  rows: { title: string; items: StremioMeta[] }[];
}

export default function Home() {
  const t = useT();
  const client = useAuth((s) => s.client)();
  const profileId = useAuth((s) => s.activeProfileId);
  const historyEntries = useHistory((state) => state.entries);
  const personalRatings = useHistory((state) => state.ratings);
  const [data, setData] = useState<HomeData | null>(null);
  const [discover, setDiscover] = useState<DiscoverData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) {
      setError(null);
      setData({
        hero: null,
        resume: [],
        nextUp: [],
        favorites: [],
        watched: [],
        latestByLibrary: [],
        genreRows: [],
      });
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
        // standalone Cinemeta catalog.
        if (!cancelled) {
          setError(null);
          setData({
            hero: null,
            resume: [],
            nextUp: [],
            favorites: [],
            watched: [],
            latestByLibrary: [],
            genreRows: [],
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // Re-fetch when the active profile changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId]);

  // Cinemeta supplies the browseable Stremio catalog; Torrentio supplies
  // sources after a title is selected. This keeps an empty Jellyfin server
  // from producing an empty Akflix home screen.
  useEffect(() => {
    const ctrl = new AbortController();
    Promise.all([
      cinemeta.catalog("movie", "top", undefined, ctrl.signal),
      cinemeta.catalog("series", "top", undefined, ctrl.signal),
      cinemeta.catalog("movie", "top", { genre: "Action" }, ctrl.signal),
      cinemeta.catalog("series", "top", { genre: "Drama" }, ctrl.signal),
      cinemeta.catalog("movie", "top", { genre: "Comedy" }, ctrl.signal),
    ])
      .then(([movies, series, action, drama, comedy]) =>
        setDiscover({
          hero: movies.find((item) => item.background) ?? movies[0] ?? null,
          rows: [
            { title: "Popular Movies", items: movies },
            { title: "Popular Series", items: series },
            { title: "Action Movies", items: action },
            { title: "Drama Series", items: drama },
            { title: "Comedy Movies", items: comedy },
          ],
        })
      )
      .catch(() => {
        if (!ctrl.signal.aborted) setDiscover({ hero: null, rows: [] });
      });
    return () => ctrl.abort();
  }, []);

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
      .filter((entry) => !entry.completed && entry.progress > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const watched = catalogHistory
      .filter((entry) => entry.completed)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const cardState: Record<string, DiscoverCardState> = {};

    for (const entry of catalogHistory) {
      const key = `${entry.media.type}:${entry.media.id}`;
      cardState[key] = {
        ...cardState[key],
        progress: entry.progress,
        watched: entry.completed,
      };
    }
    for (const rating of profileRatings) {
      if (rating.media.source !== "discover") continue;
      const key = `${rating.media.type}:${rating.media.id}`;
      cardState[key] = { ...cardState[key], rating: rating.value };
    }

    return {
      continuing: continuing.map((entry) => toMeta(entry.media)),
      watched: watched.map((entry) => toMeta(entry.media)),
      cardState,
    };
  }, [profileHistory, profileRatings]);

  const rows = useMemo(() => {
    if (!data || !discover) return null;
    const jellyfinHistory: WatchHistoryEntry[] = data.watched.map((item, index) => ({
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
    }));
    const allHistory = [...profileHistory, ...jellyfinHistory];
    const recommendations = recommendedTitles(
      discover.rows.flatMap((row) => row.items),
      allHistory,
      profileRatings
    );
    const personalized = allHistory.length > 0 || profileRatings.length > 0;
    return (
      <div className="relative z-10 -mt-8 md:-mt-20">
        <DiscoverRow
          title="Continue Watching"
          tagline="Pick up where you left off"
          items={personalRows.continuing}
          cardState={personalRows.cardState}
          variant="landscape"
        />
        <MediaRow title={t("row.continueWatching")} items={data.resume} variant="landscape" />
        <DiscoverRow
          title="Recommended for You"
          tagline={personalized ? "Based on your watches and ratings" : "Rate titles to personalize this row"}
          items={recommendations}
          cardState={personalRows.cardState}
        />
        <DiscoverRow
          title="Watched"
          tagline="Finished on Akflix"
          items={personalRows.watched}
          cardState={personalRows.cardState}
        />
        <MediaRow title="Watched in Jellyfin" items={data.watched} />
        <MediaRow title={t("row.nextUp")} items={data.nextUp} variant="landscape" />
        <MediaRow title={t("row.myList")} items={data.favorites} />
        {discover.rows.map((row) => (
          <DiscoverRow
            key={row.title}
            title={row.title}
            items={row.items}
            cardState={personalRows.cardState}
          />
        ))}
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
  }, [data, discover, personalRows, profileHistory, profileId, profileRatings, t]);

  if (error)
    return (
      <div className="flex min-h-screen items-center justify-center p-8">
        <p className="max-w-lg whitespace-pre-wrap text-center text-sm text-red-400">
          {t("common.error")}: {error}
        </p>
      </div>
    );

  if (!data || !discover) return <HomeSkeleton />;

  return (
    <motion.main
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="pb-16"
    >
      {data.hero ? (
        <HeroBanner item={data.hero} />
      ) : discover.hero ? (
        <DiscoverHero item={discover.hero} />
      ) : null}
      {rows}
    </motion.main>
  );
}
