/**
 * Full-bleed hero banner: backdrop image, gradient wash, title/overview and
 * Play / More Info actions — the signature Netflix opening shot.
 */

import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { Play, Info } from "lucide-react";
import { useAuth } from "@/stores/authStore";
import { useT } from "@/i18n";
import { formatRuntime } from "@/lib/utils";
import type { BaseItem } from "@/types/jellyfin";
import Artwork from "@/components/Artwork";

export default function HeroBanner({ item }: { item: BaseItem }) {
  const t = useT();
  const navigate = useNavigate();
  const client = useAuth((s) => s.client)();
  if (!client) return null;

  const backdrop = client.imageUrl(item, "Backdrop", 1920);
  const primary = client.imageUrl(item, "Primary", 900);
  const inProgress = (item.UserData?.PlaybackPositionTicks ?? 0) > 0;

  return (
    <div className="relative h-[82vh] min-h-[610px] w-full overflow-hidden">
      {/* Backdrop */}
      <Artwork
        src={backdrop ?? primary}
        title={item.Name}
        variant="backdrop"
        className="absolute inset-0 h-full w-full scale-[1.015] object-cover"
        draggable={false}
      />
      {/* Cinematic gradients: bottom fade into the page, left wash for text */}
      <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/15 to-transparent" />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(9,8,6,.96)_0%,rgba(9,8,6,.6)_40%,rgba(9,8,6,.05)_76%)]" />

      {/* Copy */}
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="absolute bottom-[16%] left-6 max-w-2xl md:left-12 lg:left-16"
      >
        <p className="mb-5 text-[10px] font-bold uppercase tracking-[0.22em] text-accent">From your library</p>
        <h1 className="hero-shadow mb-4 text-5xl font-black leading-[.94] tracking-[-0.05em] md:text-7xl">
          {item.Name}
        </h1>

        <div className="mb-3 flex items-center gap-3 text-sm text-zinc-300">
          {item.ProductionYear && <span>{item.ProductionYear}</span>}
          {item.OfficialRating && (
            <span className="border border-zinc-500 px-1.5 py-0.5 text-xs">
              {item.OfficialRating}
            </span>
          )}
          {item.RunTimeTicks && <span>{formatRuntime(item.RunTimeTicks)}</span>}
          {item.CommunityRating && (
            <span className="text-green-400">★ {item.CommunityRating.toFixed(1)}</span>
          )}
        </div>

        {item.Overview && (
          <p className="hero-shadow mb-6 line-clamp-3 text-sm text-zinc-200 md:text-base">
            {item.Overview}
          </p>
        )}

        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(`/play/${item.Id}`)}
            className="prism-border flex items-center gap-2 rounded-2xl bg-gradient-to-r from-brand-light to-brand px-6 py-3.5 font-bold text-[#090806] shadow-[0_14px_40px_rgba(152,117,47,.24)] transition hover:-translate-y-0.5 hover:brightness-110"
          >
            <Play size={20} fill="currentColor" />
            {inProgress ? t("hero.resume") : t("hero.play")}
          </button>
          <button
            onClick={() => navigate(`/title/${item.Id}`)}
            className="glass-panel flex items-center gap-2 rounded-2xl px-6 py-3.5 font-semibold text-white transition hover:-translate-y-0.5 hover:bg-white/[0.10]"
          >
            <Info size={20} />
            {t("hero.moreInfo")}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
