/**
 * A single poster card with Netflix-style hover zoom + info reveal.
 */

import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { Play } from "lucide-react";
import { useAuth } from "@/stores/authStore";
import { formatRuntime } from "@/lib/utils";
import type { BaseItem } from "@/types/jellyfin";
import Artwork from "@/components/Artwork";
import { isAppleMobile } from "@/lib/platform";

interface Props {
  item: BaseItem;
  /** "poster" for vertical cards, "landscape" for Continue Watching thumbs. */
  variant?: "poster" | "landscape";
}

export default function MediaCard({ item, variant = "poster" }: Props) {
  const navigate = useNavigate();
  const client = useAuth((s) => s.client)();
  const mobileApple = isAppleMobile();
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
      whileHover={mobileApple ? undefined : { y: -7, scale: 1.018, zIndex: 10 }}
      whileTap={{ scale: 0.965 }}
      transition={{ type: "spring", stiffness: 350, damping: 25 }}
      onClick={goDetails}
      role="button"
      tabIndex={0}
      aria-label={subtitle ? `${title}, ${subtitle}` : title}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          goDetails();
        }
      }}
      className={`group relative shrink-0 cursor-pointer overflow-hidden rounded-2xl border border-white/[0.08] bg-surface-raised shadow-[0_14px_35px_rgba(0,0,0,.35)] ${
        variant === "landscape" ? "aspect-video w-[82vw] max-w-[340px] md:w-72" : "aspect-[2/3] w-[138px] md:w-48"
      }`}
    >
      <Artwork
        src={img}
        title={title}
        variant={variant}
        alt={title}
        loading="lazy"
        className="h-full w-full object-cover transition duration-700 group-hover:scale-[1.045]"
        draggable={false}
      />

      {/* Hover overlay */}
      <div className={`absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/90 via-black/20 to-transparent p-3 transition-opacity duration-200 ${mobileApple ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 group-focus-within:opacity-100"}`}>
        <button
          onClick={goPlay}
          aria-label="Play"
          className={`${mobileApple ? "hidden" : "flex"} mb-2 h-9 w-9 items-center justify-center rounded-xl bg-white text-black shadow-xl transition hover:scale-105`}
        >
          <Play size={16} fill="currentColor" />
        </button>
        <p className="truncate text-sm font-semibold">{title}</p>
        {subtitle && <p className="truncate text-xs text-zinc-300">{subtitle}</p>}
      </div>

      {/* Continue-watching progress bar */}
      {progress > 0 && progress < 98 && (
        <div className="absolute inset-x-0 bottom-0 h-1 bg-white/25" role="progressbar" aria-label="Watched" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}>
          <div className="h-full bg-white" style={{ width: `${progress}%` }} />
        </div>
      )}
    </motion.div>
  );
}
