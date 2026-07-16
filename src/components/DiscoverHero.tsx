import { ArrowRight, Info, Play, Sparkles } from "lucide-react";
import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import type { StremioMeta } from "@/types/stremio";
import Artwork from "@/components/Artwork";
import { isAppleMobile } from "@/lib/platform";

export default function DiscoverHero({ item }: { item: StremioMeta }) {
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
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(9,8,6,.36),transparent_74%)]" />
        <div className="absolute inset-x-0 bottom-0 h-[72%] bg-[linear-gradient(0deg,#090806_2%,rgba(9,8,6,.84)_28%,transparent_82%)]" />

        <motion.div
          initial={{ opacity: 0, y: 28 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.18, type: "spring", stiffness: 220, damping: 25 }}
          className="absolute inset-x-0 bottom-11 px-4"
        >
          <div className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/35 px-3 py-1.5 text-[9px] font-bold uppercase tracking-[0.19em] text-zinc-100 backdrop-blur-xl">
            <Sparkles size={11} className="text-accent" /> Featured tonight
          </div>
          <h1 className="hero-shadow max-w-[92%] text-[43px] font-black leading-[0.9] tracking-[-0.06em]">
            {item.name}
          </h1>
          <div className="mt-4 flex items-center gap-2.5 text-[12px] font-semibold text-zinc-300">
            {item.imdbRating && <span className="text-accent">★ {item.imdbRating}</span>}
            <span>{item.releaseInfo ?? item.year}</span>
            <span className="rounded-full border border-white/15 px-2 py-0.5 text-[9px] uppercase tracking-wider">
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
              className="flex h-[50px] items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-brand-light to-brand px-5 py-3.5 text-sm font-black text-[#090806] shadow-[0_14px_38px_rgba(152,117,47,.28)]"
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

  return (
    <section className="relative h-[82vh] min-h-[610px] overflow-hidden">
      <Artwork
        src={item.background ?? item.poster}
        title={item.name}
        variant="backdrop"
        className="absolute inset-0 h-full w-full scale-[1.015] object-cover"
        draggable={false}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/15 to-black/10" />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(9,8,6,.96)_0%,rgba(9,8,6,.66)_38%,rgba(9,8,6,.08)_75%)]" />
      <div className="absolute inset-x-0 bottom-0 h-56 bg-gradient-to-t from-surface to-transparent" />
      <div className="absolute left-[54%] top-[22%] h-72 w-72 rounded-full bg-brand/15 blur-[110px]" />

      <div className="absolute bottom-32 left-6 max-w-2xl md:left-12 lg:left-16">
        <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-200 backdrop-blur-xl">
          <Sparkles size={12} className="text-accent" /> Tonight's spotlight
        </div>
        <h1 className="hero-shadow max-w-2xl text-5xl font-black leading-[0.92] tracking-[-0.055em] md:text-7xl lg:text-[84px]">{item.name}</h1>
        <div className="mt-5 flex items-center gap-3 text-xs font-semibold text-zinc-300">
          {item.imdbRating && <span className="text-accent">★ {item.imdbRating}</span>}
          <span>{item.releaseInfo ?? item.year}</span>
          <span className="rounded-full border border-white/15 px-2 py-0.5 uppercase">{item.type}</span>
        </div>
        <p className="mt-5 line-clamp-3 max-w-xl text-sm leading-6 text-zinc-300 md:text-base">
          {item.description}
        </p>
        <div className="mt-7 flex flex-wrap gap-3">
          <button
            onClick={() => navigate(`/discover/${item.type}/${item.id}`)}
            className="prism-border flex items-center gap-2 rounded-2xl bg-gradient-to-r from-brand-light to-brand px-6 py-3.5 text-sm font-bold text-[#090806] shadow-[0_14px_40px_rgba(152,117,47,.24)] transition hover:-translate-y-0.5 hover:brightness-110"
          >
            <Play size={17} fill="currentColor" /> Watch now
          </button>
          <button
            onClick={() => navigate(`/discover/${item.type}/${item.id}`)}
            className="glass-panel flex items-center gap-2 rounded-2xl px-5 py-3.5 text-sm font-semibold text-zinc-100 transition hover:-translate-y-0.5 hover:bg-white/[0.10]"
          >
            <Info size={17} /> Details <ArrowRight size={14} className="text-zinc-500" />
          </button>
        </div>
      </div>
    </section>
  );
}
