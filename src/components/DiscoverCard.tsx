import { Check, Star } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { StremioMeta } from "@/types/stremio";
import Artwork from "@/components/Artwork";
import { isAppleMobile } from "@/lib/platform";

export interface DiscoverCardState {
  progress?: number;
  watched?: boolean;
  rating?: number;
  resumeLabel?: string;
  /** A short fact from the catalogue: "S6 E5 · Oct 14", "New season". */
  badge?: string;
  /** Why it is recommended: "Because you watched Entourage". */
  reason?: string;
}

export default function DiscoverCard({
  item,
  state,
  variant = "poster",
  fluid = false,
  caption = false,
}: {
  item: StremioMeta;
  state?: DiscoverCardState;
  variant?: "poster" | "landscape";
  fluid?: boolean;
  /** Name and year under the artwork (search grids) instead of on hover. */
  caption?: boolean;
}) {
  const navigate = useNavigate();
  const mobileApple = isAppleMobile();
  const open = () => navigate(`/discover/${item.type}/${item.id}`);
  const landscape = variant === "landscape";
  const size = fluid
    ? landscape ? "aspect-video w-full" : "aspect-[2/3] w-full"
    : landscape
      ? "aspect-video w-[82vw] max-w-[340px] md:w-[300px] xl:w-[340px]"
      : "aspect-[2/3] w-[138px] md:w-[164px] xl:w-[184px] 2xl:w-[204px]";
  // Posters already show the title, so the name waits for hover/focus. A
  // backdrop (Continue Watching) or a resume point always shows its label.
  const alwaysShowMeta = mobileApple || landscape || !!state?.resumeLabel;
  const year = item.releaseInfo ?? item.year;
  // On a backdrop the fact reads as the card's subtitle; on a poster it is a pill.
  const badgeLine = landscape && !state?.resumeLabel ? state?.badge : undefined;
  const badgePill = !badgeLine ? state?.badge : undefined;
  const spoken = [state?.resumeLabel ? `Continue ${state.resumeLabel}` : state?.badge, state?.reason].filter(Boolean).join(" · ");

  if (caption && !mobileApple) {
    return (
      <div className="min-w-0">
        <button
          type="button"
          onClick={open}
          aria-label={`View details for ${item.name}${year ? `, ${year}` : ""}${spoken ? ` · ${spoken}` : ""}`}
          className={`ak-card group ${size}`}
        >
          <Artwork
            src={item.poster}
            title={item.name}
            variant={variant}
            alt=""
            loading="lazy"
            className="ak-card-art"
            draggable={false}
          />
          {state?.badge && (
            <span className="ak-card-badge" aria-hidden="true">{state.badge}</span>
          )}
        </button>
        <div className="mt-2 px-0.5" aria-hidden="true">
          <p className="truncate text-[13px] font-medium text-zinc-100">{item.name}</p>
          <p className="mt-0.5 flex items-center gap-2 text-xs text-zinc-400">
            <span>{year ?? (item.type === "series" ? "Series" : "Movie")}</span>
            {item.type === "series" && year && <span>Series</span>}
            {item.imdbRating && (
              <span className="flex items-center gap-1 text-zinc-300">
                <Star size={9} fill="currentColor" aria-hidden="true" /> {item.imdbRating}
              </span>
            )}
          </p>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={open}
      aria-label={`View details for ${item.name}${spoken ? ` · ${spoken}` : ""}`}
      data-meta={alwaysShowMeta ? "always" : undefined}
      className={`ak-card group ${size}`}
    >
      <Artwork
        src={landscape ? item.background ?? item.poster : item.poster}
        title={item.name}
        variant={variant}
        alt=""
        loading="lazy"
        className="ak-card-art"
        draggable={false}
      />
      <div className="ak-card-scrim" aria-hidden="true" />
      {(state?.watched || state?.rating || badgePill) && (
        <div className="absolute left-2.5 right-2.5 top-2.5 flex flex-wrap gap-1.5">
          {badgePill && <span className="ak-card-badge !static">{badgePill}</span>}
          {state?.watched && (
            <span className="flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-black shadow-lg">
              <Check size={10} strokeWidth={3} aria-hidden="true" /> Watched
            </span>
          )}
          {state?.rating && (
            <span className="flex items-center gap-1 rounded-full border border-white/25 bg-black/75 px-2 py-0.5 text-[10px] font-bold text-white shadow-lg backdrop-blur-xl">
              <Star size={10} fill="currentColor" aria-hidden="true" /> {state?.rating}/5
            </span>
          )}
        </div>
      )}
      <div className="ak-card-meta" aria-hidden="true">
        <p className="truncate text-[13px] font-semibold leading-tight tracking-tight text-white">{item.name}</p>
        {state?.resumeLabel || badgeLine ? (
          <p className="mt-1 truncate text-[11px] font-semibold text-zinc-200">{state?.resumeLabel ? `Continue ${state.resumeLabel}` : badgeLine}</p>
        ) : (
          <p className="mt-1 flex items-center gap-2 text-[11px] font-medium text-zinc-300">
            <span>{item.releaseInfo ?? item.year ?? (item.type === "series" ? "Series" : "Movie")}</span>
            {item.imdbRating && (
              <span className="flex items-center gap-1 font-semibold text-white">
                <Star size={9} fill="currentColor" aria-hidden="true" /> {item.imdbRating}
              </span>
            )}
          </p>
        )}
        {state?.reason && <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-zinc-300">{state.reason}</p>}
      </div>
      {state?.progress !== undefined && state.progress > 0 && state.progress < 100 && (
        <div className="absolute inset-x-0 bottom-0 z-10 h-1 bg-white/25" role="progressbar" aria-label="Watched" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(state.progress)}>
          <div
            className="h-full bg-white"
            style={{ width: `${Math.max(2, Math.min(100, state.progress))}%` }}
          />
        </div>
      )}
    </button>
  );
}
