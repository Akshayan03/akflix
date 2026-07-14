/**
 * Home — hero banner + Netflix-style rows:
 * Continue Watching, Next Up, My List, Recently Added per library, genre rows.
 */

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useAuth } from "@/stores/authStore";
import { useT } from "@/i18n";
import HeroBanner from "@/components/HeroBanner";
import MediaRow from "@/components/MediaRow";
import { HomeSkeleton } from "@/components/Skeletons";
import type { BaseItem } from "@/types/jellyfin";

const GENRE_ROWS = ["Action", "Comedy", "Drama", "Science Fiction", "Horror", "Animation"];

interface HomeData {
  hero: BaseItem | null;
  resume: BaseItem[];
  nextUp: BaseItem[];
  favorites: BaseItem[];
  latestByLibrary: { name: string; items: BaseItem[] }[];
  genreRows: { genre: string; items: BaseItem[] }[];
}

export default function Home() {
  const t = useT();
  const client = useAuth((s) => s.client)();
  const profileId = useAuth((s) => s.activeProfileId);
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;

    (async () => {
      try {
        // Library views first (needed for the per-library "Latest" rows).
        const views = await client.views();
        const mediaViews = views.Items.filter((v) =>
          ["movies", "tvshows"].includes(v.CollectionType ?? "")
        );

        const [resume, nextUp, favorites, latest, genres] = await Promise.all([
          client.resumeItems(),
          client.nextUp(),
          client.favorites(),
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
            latestByLibrary: latest,
            genreRows: genres.filter((g) => g.items.length > 0),
          });
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
    // Re-fetch when the active profile changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId]);

  const rows = useMemo(() => {
    if (!data) return null;
    return (
      <div className="relative z-10 -mt-24">
        <MediaRow title={t("row.continueWatching")} items={data.resume} variant="landscape" />
        <MediaRow title={t("row.nextUp")} items={data.nextUp} variant="landscape" />
        <MediaRow title={t("row.myList")} items={data.favorites} />
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
  }, [data, t]);

  if (error)
    return (
      <div className="flex min-h-screen items-center justify-center p-8">
        <p className="max-w-lg whitespace-pre-wrap text-center text-sm text-red-400">
          {t("common.error")}: {error}
        </p>
      </div>
    );

  if (!data) return <HomeSkeleton />;

  return (
    <motion.main
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="pb-16"
    >
      {data.hero && <HeroBanner item={data.hero} />}
      {rows}
    </motion.main>
  );
}
