import { ArrowRight, Info, Play, Sparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { StremioMeta } from "@/types/stremio";

export default function DiscoverHero({ item }: { item: StremioMeta }) {
  const navigate = useNavigate();
  return (
    <section className="relative h-[82vh] min-h-[610px] overflow-hidden">
      {item.background && (
        <img src={item.background} alt="" className="absolute inset-0 h-full w-full scale-[1.015] object-cover" />
      )}
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
