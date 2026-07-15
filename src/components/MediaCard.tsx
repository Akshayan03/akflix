/**
 * A single poster card with Netflix-style hover zoom + info reveal.
 */

import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { Play } from "lucide-react";
import { useAuth } from "@/stores/authStore";
import { formatRuntime } from "@/lib/utils";
import type { BaseItem } from "@/types/jellyfin";

interface Props {
  item: BaseItem;
  /** "poster" for vertical cards, "landscape" for Continue Watching thumbs. */
  variant?: "poster" | "landscape";
}

export default function MediaCard({ item, variant = "poster" }: Props) {
  const navigate = useNavigate();
  const client = useAuth((s) => s.client)();
  if (!client) return null;

  const isEpisode = item.Type === "Episode";
  const img =
    variant === "landscape"
      ? client.imageUrl(item, "Backdrop", 500) ?? client.imageUrl(item, "Primary", 500)
      : client.imageUrl(item, "Primary", 300);

  const progress = item.UserData?.PlayedPercentage ?? 0;
  const title = isEpisode ? item.SeriesName ?? item.Name : item.Name;
  const subtitle = isEpisode
    ? `S${item.ParentIndexNumber ?? 1}:E${item.IndexNumber ?? 1} · ${item.Name}`
    : [item.ProductionYear, formatRuntime(item.RunTimeTicks)].filter(Boolean).join(" · ");

  const goDetails = () =>
    navigate(`/title/${isEpisode ? item.SeriesId ?? item.Id : item.Id}`);
  const goPlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigate(`/play/${item.Id}`);
  };

  return (
    <motion.div
      whileHover={{ y: -7, scale: 1.018, zIndex: 10 }}
      transition={{ type: "spring", stiffness: 350, damping: 25 }}
      onClick={goDetails}
      className={`group relative shrink-0 cursor-pointer overflow-hidden rounded-[20px] border border-white/[0.08] bg-surface-raised shadow-[0_14px_35px_rgba(0,0,0,.18)] ${
        variant === "landscape" ? "aspect-video w-72" : "aspect-[2/3] w-40 md:w-48"
      }`}
    >
      {img ? (
        <img
          src={img}
          alt={title}
          loading="lazy"
          className="h-full w-full object-cover transition duration-700 group-hover:scale-[1.045]"
          draggable={false}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center p-3 text-center text-sm text-zinc-400">
          {title}
        </div>
      )}

      {/* Hover overlay */}
      <div className="absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/90 via-black/30 to-transparent p-3 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
        <button
          onClick={goPlay}
          aria-label="Play"
        className="mb-2 flex h-9 w-9 items-center justify-center rounded-xl bg-white text-black shadow-xl transition hover:scale-105"
        >
          <Play size={16} fill="currentColor" />
        </button>
        <p className="truncate text-sm font-semibold">{title}</p>
        {subtitle && <p className="truncate text-xs text-zinc-400">{subtitle}</p>}
      </div>

      {/* Continue-watching progress bar */}
      {progress > 0 && progress < 98 && (
        <div className="absolute inset-x-0 bottom-0 h-1 bg-zinc-700/80">
          <div className="h-full bg-gradient-to-r from-brand to-accent" style={{ width: `${progress}%` }} />
        </div>
      )}
    </motion.div>
  );
}
