/**
 * MiniPlayer — persistent Now Playing bar (Spotify/Netflix style).
 * Rendered by PlayerHost when playback is minimized. Shows the current
 * title + live progress, play/pause, skip ±10s, next episode, mute and
 * close. Clicking the title area expands back into the full player.
 */

import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import {
  ChevronUp,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SkipForward,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { usePlayback } from "@/stores/playbackStore";
import { formatClock } from "@/lib/utils";
import { isAppleMobile } from "@/lib/platform";
import Artwork from "@/components/Artwork";

export default function MiniPlayer() {
  const navigate = useNavigate();
  const mobileApple = isAppleMobile();
  const {
    session,
    isPlaying,
    muted,
    currentTime,
    duration,
    hasNext,
    controls,
    expand,
    stop,
  } = usePlayback();

  if (!session) return null;

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  const openFull = () => {
    expand();
    navigate(session.direct ? "/stream" : `/play/${session.itemId}`);
  };

  if (mobileApple) {
    return (
      <motion.div
        initial={{ y: 36, opacity: 0, scale: 0.97 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        exit={{ y: 24, opacity: 0, scale: 0.98 }}
        transition={{ type: "spring", stiffness: 360, damping: 32 }}
        className="fixed inset-x-3 z-[45] overflow-hidden rounded-[20px] border border-white/10 bg-[#17140f]/95 shadow-[0_18px_55px_rgba(0,0,0,.58)] backdrop-blur-2xl"
        style={{ bottom: "calc(5.25rem + env(safe-area-inset-bottom, 0px))" }}
      >
        <div className="h-[3px] bg-white/10">
          <motion.div
            className="h-full bg-brand-light"
            animate={{ width: `${progress}%` }}
            transition={{ ease: "linear", duration: 0.2 }}
          />
        </div>
        <div className="flex h-[65px] items-center gap-3 px-2.5">
          <motion.button
            whileTap={{ scale: 0.97 }}
            onClick={openFull}
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
          >
            <Artwork
              src={session.posterUrl}
              title={session.title}
              variant="compact"
              className="h-12 w-9 shrink-0 rounded-[9px] object-cover shadow-lg ring-1 ring-white/10"
              draggable={false}
            />
            <div className="min-w-0">
              <p className="truncate text-[13px] font-bold">{session.title}</p>
              <p className="mt-0.5 truncate text-[11px] text-zinc-400">
                {session.subtitle ?? `${formatClock(currentTime)} of ${formatClock(duration)}`}
              </p>
            </div>
          </motion.button>
          <motion.button
            whileTap={{ scale: 0.86 }}
            onClick={() => controls?.toggle()}
            aria-label={isPlaying ? "Pause" : "Play"}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-light text-[#090806]"
          >
            {isPlaying ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" className="ml-0.5" />}
          </motion.button>
          <motion.button
            whileTap={{ scale: 0.86 }}
            onClick={stop}
            aria-label="Close player"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-zinc-400"
          >
            <X size={17} />
          </motion.button>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ y: 90, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ type: "spring", stiffness: 320, damping: 32 }}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-zinc-800 bg-surface-raised/95 backdrop-blur"
    >
      {/* Seek bar along the top edge of the bar */}
      <div
        className="group/seek relative h-1 w-full cursor-pointer bg-zinc-800"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const frac = (e.clientX - rect.left) / rect.width;
          controls?.seek(frac * duration);
        }}
      >
        <div className="h-full bg-brand transition-[width]" style={{ width: `${progress}%` }} />
        <div
          className="absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-brand opacity-0 transition group-hover/seek:opacity-100"
          style={{ left: `calc(${progress}% - 6px)` }}
        />
      </div>

      <div className="flex h-[72px] items-center gap-4 px-4 md:px-6">
        {/* Title block — click to expand */}
        <button
          onClick={openFull}
          className="flex min-w-0 flex-1 items-center gap-3 text-left md:flex-initial md:basis-1/3"
        >
          <Artwork
            src={session.posterUrl}
            title={session.title}
            variant="compact"
            className="h-14 w-10 shrink-0 rounded-lg object-cover shadow-lg ring-1 ring-white/10"
            draggable={false}
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{session.title}</p>
            <p className="truncate text-xs text-zinc-400">
              {session.subtitle ?? `${formatClock(currentTime)} / ${formatClock(duration)}`}
            </p>
          </div>
          <ChevronUp size={16} className="ml-1 shrink-0 text-zinc-500" />
        </button>

        {/* Transport controls */}
        <div className="flex items-center justify-center gap-3 md:flex-1">
          <button
            onClick={() => controls?.seekBy(-10)}
            aria-label="Back 10s"
            className="hidden text-zinc-400 transition hover:text-white sm:block"
          >
            <RotateCcw size={18} />
          </button>
          <button
            onClick={() => controls?.toggle()}
            aria-label="Play/Pause"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-black transition hover:scale-105 hover:bg-zinc-200"
          >
            {isPlaying ? <Pause size={18} /> : <Play size={18} fill="currentColor" />}
          </button>
          <button
            onClick={() => controls?.seekBy(10)}
            aria-label="Forward 10s"
            className="hidden text-zinc-400 transition hover:text-white sm:block"
          >
            <RotateCw size={18} />
          </button>
          {hasNext && (
            <button
              onClick={() => controls?.next()}
              aria-label="Next episode"
              className="text-zinc-400 transition hover:text-white"
            >
              <SkipForward size={20} />
            </button>
          )}
        </div>

        {/* Right side: time, mute, close */}
        <div className="flex items-center gap-4 md:basis-1/3 md:justify-end">
          <span className="hidden text-xs tabular-nums text-zinc-500 lg:block">
            {formatClock(currentTime)} / {formatClock(duration)}
          </span>
          <button
            onClick={() => controls?.setMuted(!muted)}
            aria-label="Mute"
            className="text-zinc-400 transition hover:text-white"
          >
            {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          <button
            onClick={stop}
            aria-label="Close player"
            className="text-zinc-400 transition hover:text-white"
          >
            <X size={20} />
          </button>
        </div>
      </div>
    </motion.div>
  );
}
