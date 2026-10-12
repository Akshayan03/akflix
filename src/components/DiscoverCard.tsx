import { motion } from "framer-motion";
import { Check, Play, Star } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { StremioMeta } from "@/types/stremio";
import Artwork from "@/components/Artwork";
import { isAppleMobile } from "@/lib/platform";

export interface DiscoverCardState {
  progress?: number;
  watched?: boolean;
  rating?: number;
  resumeLabel?: string;
}

export default function DiscoverCard({
  item,
  state,
  variant = "poster",
  fluid = false,
}: {
  item: StremioMeta;
  state?: DiscoverCardState;
  variant?: "poster" | "landscape";
  fluid?: boolean;
}) {
  const navigate = useNavigate();
  const mobileApple = isAppleMobile();
  const open = () => navigate(`/discover/${item.type}/${item.id}`);

  return (
    <motion.button
      whileHover={mobileApple ? undefined : { y: -4, zIndex: 10 }}
      whileTap={{ scale: 0.97 }}
      transition={{ type: "spring", stiffness: 380, damping: 28 }}
      onClick={open}
      aria-label={`View details for ${item.name}${state?.resumeLabel ? ` · Continue ${state.resumeLabel}` : ""}`}
      className={`group relative shrink-0 snap-start overflow-hidden rounded-[14px] border border-white/[0.08] bg-surface-raised text-left shadow-[0_14px_35px_rgba(0,0,0,.35)] md:rounded-2xl ${
        fluid
          ? variant === "landscape" ? "aspect-video w-full" : "aspect-[2/3] w-full"
          : variant === "landscape" ? "aspect-video w-[82vw] max-w-[340px] md:w-80" : "aspect-[2/3] w-[138px] md:w-48"
      }`}
    >
      <Artwork
        src={variant === "landscape" ? item.background ?? item.poster : item.poster}
        title={item.name}
        variant={variant}
        alt={item.name}
        loading="lazy"
        className="h-full w-full object-cover transition duration-700 ease-out group-hover:scale-[1.045]"
        draggable={false}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/5 to-transparent opacity-90" />
      {(state?.watched || state?.rating) && (
        <div className="absolute left-3 top-3 flex flex-wrap gap-1.5">
          {state.watched && (
            <span className="flex items-center gap-1 rounded-full bg-white px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-black shadow-lg">
              <Check size={10} strokeWidth={3} aria-hidden="true" /> Watched
            </span>
          )}
          {state.rating && (
            <span className="flex items-center gap-1 rounded-full border border-white/25 bg-black/75 px-2 py-1 text-[10px] font-bold text-white shadow-lg backdrop-blur-xl">
              <Star size={10} fill="currentColor" aria-hidden="true" /> {state.rating}/5
            </span>
          )}
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 p-4">
        <p className="truncate text-sm font-bold tracking-tight">{item.name}</p>
        {state?.resumeLabel ? (
          <p className="mt-1.5 truncate text-[10px] font-bold uppercase tracking-[0.1em] text-white">
            Continue {state.resumeLabel}
          </p>
        ) : (
          <div className="mt-1.5 flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-zinc-300">
            <span>{item.releaseInfo ?? item.year ?? item.type}</span>
            {item.imdbRating && <span className="flex items-center gap-1 font-bold text-white"><Star size={9} fill="currentColor" aria-hidden="true" /> {item.imdbRating}</span>}
          </div>
        )}
      </div>
      <span aria-hidden="true" className="absolute right-3 top-3 flex h-9 w-9 translate-y-1 items-center justify-center rounded-full bg-white text-black opacity-0 shadow-lg transition duration-200 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100">
        <Play size={14} fill="currentColor" />
      </span>
      <div className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-transparent transition duration-200 group-hover:ring-white/60" />
      {state?.progress !== undefined && state.progress > 0 && state.progress < 100 && (
        <div className="absolute inset-x-0 bottom-0 z-10 h-1 bg-white/25" role="progressbar" aria-label="Watched" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(state.progress)}>
          <div
            className="h-full bg-white"
            style={{ width: `${Math.max(2, Math.min(100, state.progress))}%` }}
          />
        </div>
      )}
    </motion.button>
  );
}
