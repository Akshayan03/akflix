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

export default function HeroBanner({ item }: { item: BaseItem }) {
  const t = useT();
  const navigate = useNavigate();
  const client = useAuth((s) => s.client)();
  if (!client) return null;

  const backdrop = client.imageUrl(item, "Backdrop", 1920);
  const inProgress = (item.UserData?.PlaybackPositionTicks ?? 0) > 0;

  return (
    <div className="relative h-[72vh] min-h-[420px] w-full">
      {/* Backdrop */}
      {backdrop && (
        <img
          src={backdrop}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          draggable={false}
        />
      )}
      {/* Cinematic gradients: bottom fade into the page, left wash for text */}
      <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/20 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-black/70 via-black/20 to-transparent" />

      {/* Copy */}
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="absolute bottom-[12%] left-6 max-w-xl md:left-12"
      >
        <h1 className="hero-shadow mb-3 text-4xl font-extrabold leading-tight md:text-6xl">
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
            className="flex items-center gap-2 rounded bg-white px-6 py-2.5 font-semibold text-black transition hover:bg-zinc-200"
          >
            <Play size={20} fill="currentColor" />
            {inProgress ? t("hero.resume") : t("hero.play")}
          </button>
          <button
            onClick={() => navigate(`/title/${item.Id}`)}
            className="flex items-center gap-2 rounded bg-zinc-600/70 px-6 py-2.5 font-semibold text-white transition hover:bg-zinc-600"
          >
            <Info size={20} />
            {t("hero.moreInfo")}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
