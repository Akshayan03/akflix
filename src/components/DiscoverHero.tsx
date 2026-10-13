import { Info, Play, Sparkles, Star } from "lucide-react";
import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import type { StremioMeta } from "@/types/stremio";
import Artwork from "@/components/Artwork";
import { isAppleMobile } from "@/lib/platform";

export default function DiscoverHero({ item, eyebrow }: { item: StremioMeta; eyebrow?: string }) {
  const navigate = useNavigate();
  const mobileApple = isAppleMobile();

  if (mobileApple) {
    return (
      <motion.section
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="relative h-[76svh] min-h-[610px] overflow-hidden"
      >
        <motion.div
          initial={{ scale: 1.1 }}
          animate={{ scale: 1 }}
          transition={{ duration: 1.25, ease: [0.22, 1, 0.36, 1] }}
          className="absolute inset-0"
        >
          <Artwork
            src={item.background ?? item.poster}
            title={item.name}
            variant="backdrop"
            className="h-full w-full object-cover"
            draggable={false}
          />
        </motion.div>
        <div className="absolute inset-0 bg-gradient-to-b from-black/25 via-black/10 to-surface" />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(0,0,0,.36),transparent_74%)]" />
        <div className="absolute inset-x-0 bottom-0 h-[72%] bg-[linear-gradient(0deg,#000_2%,rgba(0,0,0,.84)_28%,transparent_82%)]" />

        <motion.div
          initial={{ opacity: 0, y: 28 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.18, type: "spring", stiffness: 220, damping: 25 }}
          className="absolute inset-x-0 bottom-11 px-4"
        >
          <div className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/35 px-3 py-1.5 text-[9px] font-bold uppercase tracking-[0.19em] text-zinc-100 backdrop-blur-xl">
            <Sparkles size={11} aria-hidden="true" /> Featured tonight
          </div>
          <h1 className="hero-shadow max-w-[92%] text-[43px] font-black leading-[0.9] tracking-[-0.06em]">
            {item.name}
          </h1>
          <div className="mt-4 flex items-center gap-2.5 text-[12px] font-semibold text-zinc-300">
            {item.imdbRating && <span className="font-bold text-white" aria-label={`IMDb rating ${item.imdbRating}`}>★ {item.imdbRating}</span>}
            <span>{item.releaseInfo ?? item.year}</span>
            <span className="rounded-full border border-white/25 px-2 py-0.5 text-[9px] uppercase tracking-wider">
              {item.type === "series" ? "Series" : "Movie"}
            </span>
          </div>
          {item.description && (
            <p className="mt-3 line-clamp-2 max-w-[95%] text-[13px] leading-5 text-zinc-300">
              {item.description}
            </p>
          )}
          <div className="mt-5 grid grid-cols-[1fr_auto] gap-2.5">
            <motion.button
              whileTap={{ scale: 0.96 }}
              onClick={() => navigate(`/discover/${item.type}/${item.id}`)}
              className="flex h-[50px] items-center justify-center gap-2 rounded-2xl bg-white px-5 py-3.5 text-sm font-black text-black"
            >
              <Play size={17} fill="currentColor" /> Watch now
            </motion.button>
            <motion.button
              whileTap={{ scale: 0.92 }}
              onClick={() => navigate(`/discover/${item.type}/${item.id}`)}
              aria-label={`View details for ${item.name}`}
              className="ios-circle-button !h-[50px] !w-[50px]"
            >
              <Info size={19} />
            </motion.button>
          </div>
        </motion.div>
      </motion.section>
    );
  }

  const kind = item.type === "series" ? "Series" : "Movie";
  const open = () => navigate(`/discover/${item.type}/${item.id}`);

  return (
    <section aria-label={`Featured: ${item.name}`} className="editorial-hero relative h-[min(80vh,860px)] min-h-[540px] overflow-hidden">
      <div key={item.id} className="ak-backdrop-in absolute inset-0">
        <Artwork
          src={item.background ?? item.poster}
          title={item.name}
          variant="backdrop"
          className="h-full w-full object-cover object-[center_22%]"
          draggable={false}
        />
      </div>
      <div className="absolute inset-x-0 top-0 h-36 bg-gradient-to-b from-black/60 to-transparent" />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(0,0,0,.86)_0%,rgba(0,0,0,.5)_34%,rgba(0,0,0,0)_66%)]" />
      <div className="absolute inset-x-0 bottom-0 h-[58%] bg-gradient-to-t from-surface via-surface/60 to-transparent" />

      <div className="ak-gutter absolute inset-x-0 bottom-[clamp(104px,15vh,156px)]">
        <div key={`${item.id}-copy`} className="ak-rise-in max-w-[660px]">
          <p className="ak-eyebrow mb-4 !text-zinc-200">{eyebrow ?? `Featured ${kind.toLowerCase()}`}</p>
          <h1 className="hero-shadow">{item.name}</h1>
          <div className="ak-meta mt-4">
            {item.imdbRating && (
              <span className="flex items-center gap-1 font-semibold text-white" aria-label={`IMDb rating ${item.imdbRating}`}>
                <Star size={13} fill="currentColor" aria-hidden="true" /> {item.imdbRating}
              </span>
            )}
            {(item.releaseInfo ?? item.year) && <span>{item.releaseInfo ?? item.year}</span>}
            <span>{kind}</span>
            {!!item.genres?.length && <span>{item.genres.slice(0, 2).join(", ")}</span>}
          </div>
          {item.description && (
            <p className="mt-4 line-clamp-3 max-w-[580px] text-[15px] leading-[1.6] text-zinc-300">
              {item.description}
            </p>
          )}
          <div className="mt-6 flex flex-wrap gap-3">
            <button type="button" onClick={open} className="desktop-control desktop-primary">
              <Info size={17} aria-hidden="true" /> More info
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
