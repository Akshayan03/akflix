import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { cinemeta } from "@/api/cinemeta";
import DiscoverHero from "@/components/DiscoverHero";
import DiscoverRow from "@/components/DiscoverRow";
import Spinner from "@/components/Spinner";
import type { StremioMediaType, StremioMeta } from "@/types/stremio";
import { isAppleMobile } from "@/lib/platform";

interface BrowseData {
  hero: StremioMeta | null;
  rows: Array<{ title: string; items: StremioMeta[] }>;
}

const GENRES = ["Action", "Comedy", "Drama", "Thriller"];

/** Dedicated catalog so movies and episodic series are equally easy to find. */
export default function Browse({ type }: { type: StremioMediaType }) {
  const [data, setData] = useState<BrowseData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isSeries = type === "series";
  const mobileApple = isAppleMobile();

  useEffect(() => {
    const ctrl = new AbortController();
    setData(null);
    setError(null);
    Promise.all([
      cinemeta.catalog(type, "top", undefined, ctrl.signal),
      ...GENRES.map((genre) =>
        cinemeta.catalog(type, "top", { genre }, ctrl.signal)
      ),
    ])
      .then(([top, ...genres]) => {
        const label = isSeries ? "Shows" : "Movies";
        setData({
          hero: top.find((item) => item.background) ?? top[0] ?? null,
          rows: [
            { title: `Popular ${label}`, items: top },
            ...GENRES.map((genre, index) => ({
              title: `${genre} ${label}`,
              items: genres[index] ?? [],
            })),
          ],
        });
      })
      .catch((reason) => {
        if (!ctrl.signal.aborted) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => ctrl.abort();
  }, [isSeries, type]);

  if (error) {
    return <p className="p-24 text-center text-sm text-red-400">{error}</p>;
  }
  if (!data) {
    return <div className="pt-40"><Spinner label={`Loading ${isSeries ? "shows" : "movies"}…`} /></div>;
  }

  return (
    <motion.main initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="min-h-screen pb-16">
      {data.hero && <DiscoverHero item={data.hero} />}
      <div className="relative z-10 -mt-7 md:-mt-20">
        {mobileApple && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            className="no-scrollbar mb-7 flex gap-2 overflow-x-auto px-4 pb-1"
          >
            {data.rows.map((row, index) => (
              <motion.button
                key={row.title}
                whileTap={{ scale: 0.94 }}
                onClick={() => document.getElementById(`browse-row-${index}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                className={`shrink-0 rounded-full border px-4 py-2 text-xs font-bold ${
                  index === 0
                    ? "border-brand/30 bg-brand/15 text-brand-light"
                    : "border-white/10 bg-white/[0.045] text-zinc-300"
                }`}
              >
                {index === 0 ? "Popular" : GENRES[index - 1]}
              </motion.button>
            ))}
          </motion.div>
        )}
        <div className={`mb-8 px-6 md:px-12 lg:px-16 ${mobileApple ? "sr-only" : ""}`}>
          <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-accent">
            {isSeries ? "Every season. Every episode." : "Your movie night starts here."}
          </p>
          <h1 className="mt-2 text-3xl font-black tracking-[-0.04em]">
            {isSeries ? "TV Shows" : "Movies"}
          </h1>
        </div>
        {data.rows.map((row, index) => (
          <DiscoverRow id={`browse-row-${index}`} key={row.title} title={row.title} items={row.items} />
        ))}
      </div>
    </motion.main>
  );
}
