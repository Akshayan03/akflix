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

export default function MiniPlayer() {
  const navigate = useNavigate();
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
          {session.posterUrl ? (
            <img
              src={session.posterUrl}
              alt=""
              className="h-14 w-10 shrink-0 rounded-lg object-cover shadow-lg ring-1 ring-white/10"
              draggable={false}
            />
          ) : (
            <div className="flex h-14 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-800 text-xs font-bold text-zinc-500">
              {session.title.slice(0, 1).toUpperCase()}
            </div>
          )}
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
