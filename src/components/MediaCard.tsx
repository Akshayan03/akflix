/**
 * A Jellyfin poster card: artwork first, name and play control on hover/focus.
 */

import { useNavigate } from "react-router-dom";
import { Play } from "lucide-react";
import { useAuth } from "@/stores/authStore";
import { formatRuntime } from "@/lib/utils";
import type { BaseItem } from "@/types/jellyfin";
import Artwork from "@/components/Artwork";
import { CARD_SIZES } from "@/lib/artwork";
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
    <div
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
      data-meta={mobileApple || variant === "landscape" ? "always" : undefined}
      className={`ak-card group cursor-pointer ${
        variant === "landscape" ? "aspect-video w-[82vw] max-w-[340px] md:w-[300px] xl:w-[340px]" : "aspect-[2/3] w-[138px] md:w-[164px] xl:w-[184px] 2xl:w-[204px]"
      }`}
    >
      <Artwork
        src={img}
        title={title}
        variant={variant}
        sizes={CARD_SIZES[variant]}
        alt=""
        loading="lazy"
        className="ak-card-art"
        draggable={false}
      />
      <div className="ak-card-scrim" aria-hidden="true" />

      <div className="ak-card-meta">
        <p className="truncate text-[13px] font-semibold leading-tight tracking-tight text-white">{title}</p>
        {subtitle && <p className="mt-1 truncate text-[11px] font-medium text-zinc-300">{subtitle}</p>}
      </div>
      {!mobileApple && (
        <button
          type="button"
          onClick={goPlay}
          aria-label={`Play ${title}`}
          className="ak-card-play transition-transform hover:scale-105 group-focus-within:opacity-100"
        >
          <Play size={13} fill="currentColor" />
        </button>
      )}

      {/* Continue-watching progress bar */}
      {progress > 0 && progress < 98 && (
        <div className="absolute inset-x-0 bottom-0 z-10 h-1 bg-white/25" role="progressbar" aria-label="Watched" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}>
          <div className="h-full bg-white" style={{ width: `${progress}%` }} />
        </div>
      )}
    </div>
  );
}
