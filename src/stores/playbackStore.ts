/**
 * Global playback state — the engine behind the persistent player.
 *
 * The single <video> element lives in <PlayerHost/> (mounted once in App),
 * so playback survives navigation. Two view modes:
 *   - "expanded": immersive full-screen player (the /play/:id route)
 *   - "mini":     Spotify/Netflix-style bottom bar + floating PiP video
 *
 * Pages never touch the video element directly — they call `open(itemId)`
 * and PlayerHost reacts. PlayerHost registers an imperative `controls`
 * handle here that the MiniPlayer / keyboard shortcuts drive.
 */

import { create } from "zustand";

export interface PlaybackSession {
  itemId: string;
  title: string;
  subtitle?: string; // "S1:E4 Episode Name" for episodes
  posterUrl: string | null;
  isEpisode: boolean;
  direct?: boolean;
}

export interface DirectEpisodeTarget {
  season: number;
  episode: number;
  title: string;
}

export interface DirectPlaybackMetadata {
  /** Clean catalog title, never the torrent release filename. */
  title: string;
  /** Year for movies or S/E + episode title for series. */
  subtitle?: string;
  posterUrl?: string | null;
  isEpisode?: boolean;
  /** Structured episode identity used to select the right file in season packs. */
  season?: number;
  episode?: number;
  /** Catalog identity and metadata used for persistent progress and recommendations. */
  catalogId?: string;
  mediaType?: "movie" | "series";
  backgroundUrl?: string | null;
  description?: string;
  releaseInfo?: string;
  year?: string;
  genres?: string[];
  catalogRating?: string;
  /** Catalog runtime used to keep the scrubber seekable during rolling conversion. */
  durationSeconds?: number;
  /** Ordered episodes after the current one, used for seamless auto advance. */
  episodeQueue?: DirectEpisodeTarget[];
}

export interface CompatibilityPlaybackSource {
  streamId: string;
  audioLanguage: string;
  inputUrl?: string;
  filename?: string;
  startSeconds: number;
}

export interface DirectPlaybackRequest extends DirectPlaybackMetadata {
  id: string;
  url: string;
  /** Source details required to restart a rolling HLS conversion after a seek. */
  compatibility?: CompatibilityPlaybackSource;
}

/** Imperative surface registered by PlayerHost. */
export interface PlayerControls {
  toggle: () => void;
  seek: (seconds: number) => void;
  seekBy: (delta: number) => void;
  setMuted: (muted: boolean) => void;
  setPlaybackRate: (rate: number) => void;
  /** Play the next episode (episodes only). Resolves false if none. */
  next: () => Promise<boolean>;
}

interface PlaybackState {
  /** Item PlayerHost should be playing (set via open()). */
  requestedItemId: string | null;
  requestedDirect: DirectPlaybackRequest | null;
  session: PlaybackSession | null;
  mode: "expanded" | "mini";

  // Live state mirrored from the video element (for UI binding).
  isPlaying: boolean;
  muted: boolean;
  currentTime: number;
  duration: number;
  buffering: boolean;
  hasNext: boolean;
  playbackRate: number;

  controls: PlayerControls | null;

  open: (itemId: string) => void;
  openDirect: (request: DirectPlaybackRequest) => void;
  expand: () => void;
  minimize: () => void;
  stop: () => void;

  // Internal — called by PlayerHost only.
  _setSession: (s: PlaybackSession | null) => void;
  _setControls: (c: PlayerControls | null) => void;
  _sync: (patch: Partial<Pick<PlaybackState,
    "isPlaying" | "muted" | "currentTime" | "duration" | "buffering" | "hasNext" | "playbackRate">>) => void;
}

export const usePlayback = create<PlaybackState>()((set): PlaybackState => ({
  requestedItemId: null,
  requestedDirect: null,
  session: null,
  mode: "mini",

  isPlaying: false,
  muted: false,
  currentTime: 0,
  duration: 0,
  buffering: false,
  hasNext: false,
  playbackRate: 1,

  controls: null,

  open: (itemId) => set({ requestedItemId: itemId, requestedDirect: null, mode: "expanded" }),
  openDirect: (requestedDirect) =>
    set({ requestedDirect, requestedItemId: null, mode: "expanded" }),
  expand: () => set({ mode: "expanded" }),
  minimize: () => set({ mode: "mini" }),
  stop: () =>
    set({
      requestedItemId: null,
      requestedDirect: null,
      session: null,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      hasNext: false,
    }),

  _setSession: (session) => set({ session }),
  _setControls: (controls) => set({ controls }),
  _sync: (patch) => set(patch),
}));

// Dev-only escape hatch for debugging playback state from the console.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__playback = usePlayback;
}
