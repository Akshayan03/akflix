import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  Clock3,
  ListFilter,
  LoaderCircle,
  Play,
  RefreshCw,
  Sparkles,
  Star,
} from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { cinemeta } from "@/api/cinemeta";
import { TitleSkeleton } from "@/components/Skeletons";
import TorrentModal from "@/components/TorrentModal";
import Artwork from "@/components/Artwork";
import DiscoverCard from "@/components/DiscoverCard";
import DiscoverRow from "@/components/DiscoverRow";
import type { StremioMediaType, StremioMeta, StremioVideo } from "@/types/stremio";
import { useTorrents } from "@/stores/torrentStore";
import { usePlayback } from "@/stores/playbackStore";
import { isAppleMobile } from "@/lib/platform";
import { automaticSafeSources } from "@/lib/sourceLanguage";
import RatingControl from "@/components/RatingControl";
import { useAuth } from "@/stores/authStore";
import { useSettings } from "@/stores/settingsStore";
import {
  historyMediaKey,
  useHistory,
  type HistoryTitle,
} from "@/stores/historyStore";
import { parseRuntimeSeconds } from "@/lib/utils";

function discoverHistoryTitle(meta: StremioMeta): HistoryTitle {
  return {
    source: "discover",
    id: meta.id,
    type: meta.type,
    name: meta.name,
    poster: meta.poster,
    background: meta.background,
    description: meta.description,
    releaseInfo: meta.releaseInfo,
    year: meta.year,
    imdbRating: meta.imdbRating,
    genres: meta.genres,
  };
}

function episodesAfter(
  videos: StremioVideo[] | undefined,
  current: StremioVideo | null | undefined
) {
  if (!videos || !current) return [];
  const ordered = videos
    .filter((video) => video.season > 0 && video.episode > 0)
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
  const currentIndex = ordered.findIndex(
    (video) =>
      video.id === current.id ||
      (video.season === current.season && video.episode === current.episode)
  );
  if (currentIndex < 0) return [];
  return ordered.slice(currentIndex + 1).map((video) => ({
    season: video.season,
    episode: video.episode,
    title: video.name ?? video.title ?? `Episode ${video.episode}`,
  }));
}

function titleFamily(value: string): string {
  return value.split(/[:|-]/)[0]?.trim().toLowerCase() ?? value.toLowerCase();
}

function rankRelated(current: StremioMeta, candidates: StremioMeta[]): StremioMeta[] {
  const currentGenres = new Set((current.genres ?? []).map((genre) => genre.toLowerCase()));
  const currentYear = Number(current.year?.match(/\d{4}/)?.[0] ?? 0);
  const family = titleFamily(current.name);
  const unique = new Map<string, StremioMeta>();
  for (const candidate of candidates) {
    if (candidate.id === current.id && candidate.type === current.type) continue;
    unique.set(`${candidate.type}:${candidate.id}`, candidate);
  }
  return [...unique.values()]
    .map((candidate) => {
      const sharedGenres = (candidate.genres ?? []).filter((genre) =>
        currentGenres.has(genre.toLowerCase())
      ).length;
      const candidateYear = Number(candidate.year?.match(/\d{4}/)?.[0] ?? 0);
      const yearDistance =
        currentYear && candidateYear ? Math.abs(currentYear - candidateYear) : 20;
      const familyMatch =
        family.length >= 4 && titleFamily(candidate.name).includes(family) ? 320 : 0;
      const score =
        familyMatch +
        sharedGenres * 110 +
        (candidate.type === current.type ? 70 : 0) +
        Math.max(0, 50 - yearDistance * 3) +
        Number(candidate.imdbRating ?? 0) * 4;
      return { candidate, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 14)
    .map(({ candidate }) => candidate);
}

function RelatedShelf({ title, items }: { title: string; items: StremioMeta[] }) {
  if (!items.length) return null;
  return (
    <section className="mx-auto max-w-6xl px-4 pt-12 sm:px-6 md:px-12">
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <p className="ak-eyebrow flex items-center gap-1.5">
            <Sparkles size={12} aria-hidden="true" /> Discover next
          </p>
          <h2 className="mt-1 font-display text-3xl tracking-[-0.02em]">More Like This</h2>
        </div>
        <p className="hidden max-w-sm text-right text-xs leading-5 text-zinc-400 sm:block">
          Related to {title} by genre, collection, release period and rating
        </p>
      </div>
      <div className="hide-scrollbar -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-5 sm:-mx-6 sm:px-6 md:-mx-12 md:gap-4 md:px-12">
        {items.map((item) => (
          <DiscoverCard key={`${item.type}:${item.id}`} item={item} />
        ))}
      </div>
    </section>
  );
}

export default function DiscoverDetails() {
  const navigate = useNavigate();
  const searchSources = useTorrents((state) => state.search);
  const raceStreamSources = useTorrents((state) => state.raceStreamSources);
  const beginStreamRequest = useTorrents((state) => state.beginStreamRequest);
  const setStreamLaunchPhase = useTorrents((state) => state.setStreamLaunchPhase);
  const openDirect = usePlayback((state) => state.openDirect);
  const profileId = useAuth((state) => state.activeProfileId) ?? "akflix-local";
  const historyEntries = useHistory((state) => state.entries);
  const ratings = useHistory((state) => state.ratings);
  const setRating = useHistory((state) => state.setRating);
  const preferredAudioLanguage = useSettings((state) => state.audioLanguage);
  const { type, imdbId } = useParams<{ type: StremioMediaType; imdbId: string }>();
  const [meta, setMeta] = useState<StremioMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [selectedSeason, setSelectedSeason] = useState(1);
  const [selectedEpisode, setSelectedEpisode] = useState<StremioVideo | null>(null);
  const [starting, setStarting] = useState(false);
  const [startPhase, setStartPhase] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [related, setRelated] = useState<StremioMeta[]>([]);
  const watchAbortRef = useRef<AbortController | null>(null);
  const mobileApple = isAppleMobile();

  useEffect(() => {
    if (!type || !imdbId) return;
    const ctrl = new AbortController();
    setMeta(null);
    setError(null);
    cinemeta
      .meta(type, imdbId, ctrl.signal)
      .then((value) => {
        setMeta(value);
        const saved = useHistory.getState().entries.find(
          (entry) =>
            entry.profileId === (useAuth.getState().activeProfileId ?? "akflix-local") &&
            entry.media.source === "discover" &&
            entry.media.type === value.type &&
            entry.media.id === value.id
        );
        const first =
          value.videos?.find(
            (video) => video.season === saved?.season && video.episode === saved?.episode
          ) ?? value.videos?.find((video) => video.season > 0) ?? value.videos?.[0];
        if (first) {
          setSelectedSeason(first.season);
          setSelectedEpisode(first);
        }
      })
      .catch((reason) => {
        if (!ctrl.signal.aborted)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => ctrl.abort();
  }, [type, imdbId, loadAttempt]);

  useEffect(() => () => watchAbortRef.current?.abort(), []);

  useEffect(() => {
    if (!meta) {
      setRelated([]);
      return;
    }
    const ctrl = new AbortController();
    const genres = (meta.genres ?? []).slice(0, 3);
    Promise.allSettled([
      cinemeta.search(titleFamily(meta.name), ctrl.signal),
      ...genres.map((genre) =>
        cinemeta.catalog(meta.type, "top", { genre }, ctrl.signal)
      ),
      cinemeta.catalog(meta.type, "top", undefined, ctrl.signal),
    ]).then((results) => {
      if (ctrl.signal.aborted) return;
      const candidates = results.flatMap((result) =>
        result.status === "fulfilled" ? result.value : []
      );
      setRelated(rankRelated(meta, candidates));
    });
    return () => ctrl.abort();
  }, [meta]);

  const seasons = useMemo(
    () => [...new Set(meta?.videos?.map((video) => video.season).filter((n) => n > 0) ?? [])],
    [meta]
  );
  const episodes = meta?.videos?.filter((video) => video.season === selectedSeason) ?? [];

  if (error)
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface px-6 text-center">
        <div role="alert" className="max-w-md rounded-3xl bg-white p-8 text-black">
          <AlertTriangle size={28} className="mx-auto mb-3" aria-hidden="true" />
          <h1 className="text-xl font-bold">This title could not load</h1>
          <p className="mt-3 text-sm leading-6 text-black/70">Check your connection and try again. Your saved progress is safe.</p>
          <button
            onClick={() => {
              setError(null);
              setMeta(null);
              setLoadAttempt((value) => value + 1);
            }}
            className="mt-6 inline-flex items-center gap-2 rounded-full bg-black px-5 py-3 text-sm font-black text-white"
          >
            <RefreshCw size={15} aria-hidden="true" /> Try again
          </button>
        </div>
      </div>
    );
  if (!meta || !type || !imdbId) return <TitleSkeleton />;

  const lookup =
    type === "movie"
      ? { imdbId, type: "movie" as const }
      : selectedEpisode
        ? {
            imdbId,
            type: "series" as const,
            season: selectedEpisode.season,
            episode: selectedEpisode.episode,
          }
        : undefined;
  const query = [meta.name, meta.releaseInfo ?? meta.year].filter(Boolean).join(" ");
  const historyTitle = discoverHistoryTitle(meta);
  const historyKey = historyMediaKey(historyTitle);
  const personalRating = ratings.find(
    (rating) => rating.profileId === profileId && historyMediaKey(rating.media) === historyKey
  )?.value;
  const savedProgress = historyEntries.find(
    (entry) => entry.profileId === profileId && historyMediaKey(entry.media) === historyKey
  );
  const canResume =
    !!savedProgress &&
    !savedProgress.completed &&
    (type === "movie" ||
      (savedProgress.season === selectedEpisode?.season &&
        savedProgress.episode === selectedEpisode?.episode));
  const resumeActionLabel =
    canResume && type === "series" && savedProgress?.season && savedProgress.episode
      ? `Continue S${savedProgress.season} E${savedProgress.episode}`
      : canResume
        ? "Resume"
        : type === "series" && selectedEpisode
          ? `Watch S${selectedEpisode.season} E${selectedEpisode.episode}`
          : "Watch now";
  const catalogMetadata = {
    catalogId: meta.id,
    mediaType: type,
    backgroundUrl: meta.background,
    description: meta.description,
    releaseInfo: meta.releaseInfo,
    year: meta.year,
    genres: meta.genres,
    catalogRating: meta.imdbRating,
    durationSeconds: parseRuntimeSeconds(meta.runtime),
  };

  const watchNow = async (episode = selectedEpisode) => {
    if (starting) {
      watchAbortRef.current?.abort();
      usePlayback.getState().stop();
      const streamState = useTorrents.getState();
      if (streamState.sourceRaceActive) await streamState.cancelSourceRace().catch(() => {});
      else await streamState.cancelPendingStream(streamState.streamRequestId).catch(() => {});
      setStarting(false);
      setStartPhase(null);
      return;
    }
    const targetLookup =
      type === "movie"
        ? { imdbId, type: "movie" as const }
        : episode
          ? { imdbId, type: "series" as const, season: episode.season, episode: episode.episode }
          : undefined;
    if (!targetLookup) return;
    const matchesSavedEpisode =
      type === "movie" ||
      (!!episode &&
        savedProgress?.season === episode.season &&
        savedProgress?.episode === episode.episode);
    const resumeSeconds =
      savedProgress && !savedProgress.completed && matchesSavedEpisode && savedProgress.position > 10
        ? savedProgress.position
        : undefined;
    const media = {
      title: meta.name,
      subtitle:
        type === "series" && episode
          ? `S${episode.season} E${episode.episode} · ${episode.name ?? episode.title ?? `Episode ${episode.episode}`}`
          : meta.releaseInfo ?? meta.year,
      posterUrl: meta.poster,
      isEpisode: type === "series",
      season: type === "series" ? episode?.season : undefined,
      episode: type === "series" ? episode?.episode : undefined,
      episodeQueue: type === "series" ? episodesAfter(meta.videos, episode) : undefined,
      resumeSeconds,
      ...catalogMetadata,
    };
    const controller = new AbortController();
    watchAbortRef.current?.abort();
    watchAbortRef.current = controller;
    let timedOut = false;
    let timeout: number | null = null;
    let requestId: number | null = null;
    setStarting(true);
    setStartPhase("Finding available sources");
    usePlayback.getState().stop();
    try {
      requestId = await beginStreamRequest(media);
      timeout = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 12_000);
      const results = await searchSources(query, controller.signal, targetLookup);
      if (useTorrents.getState().streamRequestId !== requestId) return;
      if (timeout !== null) window.clearTimeout(timeout);
      if (!results.length) throw new Error("No playable sources were found for this title.");
      setStartPhase("Choosing the quickest option");
      setStreamLaunchPhase(requestId, "Choosing the quickest option");
      const preferredResults = automaticSafeSources(results, preferredAudioLanguage);
      const hosted = preferredResults.find((result) => result.streamUrl);
      if (hosted?.streamUrl) {
        setStartPhase("Opening player");
        setStreamLaunchPhase(requestId, "Opening player");
        openDirect({ id: hosted.guid, url: hosted.streamUrl, ...media });
        setStreamLaunchPhase(requestId, null);
        navigate("/stream");
        toast.success("Playing now", { description: "Using an instant hosted source." });
        return;
      }
      if (mobileApple) {
        if (episode) {
          setSelectedSeason(episode.season);
          setSelectedEpisode(episode);
        }
        setSourceOpen(true);
        toast.info("Instant streaming is not configured", {
          description: "Set up a hosted Torrentio source to play directly without Jellyfin or downloading.",
        });
        return;
      }
      setStartPhase("Testing the fastest sources");
      setStreamLaunchPhase(requestId, "Testing the fastest sources");
      await raceStreamSources(preferredResults, media, requestId);
      toast.success("Opening the fastest source", {
        description: "Audio preference applied. The selected source stays locked during playback.",
      });
    } catch (reason) {
      if (
        !timedOut && ((reason instanceof DOMException && reason.name === "AbortError") ||
        (reason instanceof Error && /cancelled/i.test(reason.message)))
      ) {
        return;
      }
      toast.error("Couldn’t start playback", {
        description: timedOut
          ? "Source lookup took too long. Try again or choose a stream manually."
          : reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      if (timeout !== null) window.clearTimeout(timeout);
      if (requestId !== null) setStreamLaunchPhase(requestId, null);
      if (watchAbortRef.current === controller) watchAbortRef.current = null;
      setStarting(false);
      setStartPhase(null);
    }
  };

  if (mobileApple) {
    return (
      <motion.main
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="min-h-[100svh] bg-surface pb-32"
      >
        <section className="relative h-[49svh] min-h-[390px] overflow-hidden">
          <motion.div
            initial={{ scale: 1.12, opacity: 0.65 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 1.15, ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-0"
          >
            <Artwork
              src={meta.background ?? meta.poster}
              title={meta.name}
              variant="backdrop"
              className="h-full w-full object-cover"
              draggable={false}
            />
          </motion.div>
          <div className="absolute inset-0 bg-gradient-to-b from-black/25 via-transparent to-surface" />
          <div className="absolute inset-x-0 bottom-0 h-[62%] bg-[linear-gradient(0deg,#000_3%,rgba(0,0,0,.82)_34%,transparent_100%)]" />
        </section>

        <motion.section
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.12, type: "spring", stiffness: 230, damping: 26 }}
          className="relative z-10 -mt-28 px-4"
        >
          <div className="flex items-end gap-4">
            <motion.div
              layoutId={`poster-${meta.id}`}
              className="aspect-[2/3] w-[104px] shrink-0 overflow-hidden rounded-[20px] shadow-[0_22px_55px_rgba(0,0,0,.7)] ring-1 ring-white/10"
            >
              <Artwork
                src={meta.poster}
                title={meta.name}
                variant="poster"
                className="h-full w-full object-cover"
                draggable={false}
              />
            </motion.div>
            <div className="min-w-0 flex-1 pb-1">
              <p className="ak-eyebrow mb-2 !text-[9px]">
                {type === "series" ? "Series" : "Feature film"}
              </p>
              <h1 className="text-[31px] font-black leading-[0.94] tracking-[-0.055em]">
                {meta.name}
              </h1>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] font-semibold text-zinc-400">
                <span>{meta.releaseInfo ?? meta.year}</span>
                {meta.imdbRating && (
                  <span className="flex items-center gap-1 font-bold text-white">
                    <Star size={11} fill="currentColor" aria-hidden="true" /> {meta.imdbRating}
                  </span>
                )}
                {meta.runtime && <span>{meta.runtime}</span>}
              </div>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-[1fr_52px] gap-2.5">
            <motion.button
              whileTap={{ scale: 0.965 }}
              onClick={() => void watchNow()}
              disabled={!lookup}
              className="flex h-[52px] items-center justify-center gap-2 rounded-2xl bg-white px-5 text-sm font-black text-black disabled:opacity-40"
            >
              {starting ? <LoaderCircle size={18} className="animate-spin" /> : <Play size={18} fill="currentColor" />}
              {starting ? "Cancel" : resumeActionLabel}
            </motion.button>
            <motion.button
              whileTap={{ scale: 0.9 }}
              onClick={() => setSourceOpen(true)}
              disabled={!lookup}
              aria-label="Choose hosted stream"
              className="flex h-[52px] items-center justify-center rounded-2xl border border-white/20 bg-white/[0.055] text-zinc-100 backdrop-blur-xl disabled:opacity-40"
            >
              <ListFilter size={20} />
            </motion.button>
          </div>
          <p role="status" className="mt-2.5 text-center text-[10px] font-medium text-zinc-400">
            {starting ? startPhase : "Watch uses the best compatible hosted source. Tap the filter to choose."}
          </p>

          <div className="mt-6 flex flex-wrap gap-2">
            {meta.genres?.slice(0, 4).map((genre) => (
              <span key={genre} className="rounded-full border border-white/15 px-3 py-1.5 text-[10px] font-semibold text-zinc-300">
                {genre}
              </span>
            ))}
          </div>

          {meta.description && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              className="mt-5 rounded-3xl border border-white/[0.07] bg-white/[0.03] p-4"
            >
              <p className="text-[13px] leading-[1.65] text-zinc-300">{meta.description}</p>
            </motion.div>
          )}

          <div className="mt-4 rounded-3xl border border-white/[0.07] bg-white/[0.03] p-4">
            <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-400">
              Your rating
            </p>
            <RatingControl value={personalRating} onChange={(value) => setRating(historyTitle, value)} />
          </div>
        </motion.section>

        {type === "series" && seasons.length > 0 && (
          <section className="mt-8">
            <div className="mb-4 flex items-center justify-between px-4">
              <div>
                <p className="ak-eyebrow !text-[9px]">Episodes</p>
                <h2 className="mt-1 text-[24px] font-black tracking-[-0.04em]">Season {selectedSeason}</h2>
              </div>
              <span className="text-xs text-zinc-400">{episodes.length} episodes</span>
            </div>

            <div className="no-scrollbar mb-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1">
              {seasons.map((season) => (
                <motion.button
                  key={season}
                  whileTap={{ scale: 0.92 }}
                  onClick={() => {
                    setSelectedSeason(season);
                    setSelectedEpisode(meta.videos?.find((video) => video.season === season) ?? null);
                  }}
                  className={`shrink-0 rounded-full px-4 py-2 text-xs font-bold transition ${
                    selectedSeason === season
                      ? "bg-white text-black"
                      : "border border-white/15 bg-white/[0.04] text-zinc-300"
                  }`}
                >
                  Season {season}
                </motion.button>
              ))}
            </div>

            <div className="space-y-3 px-4">
              {episodes.map((episode, index) => (
                <motion.article
                  key={episode.id}
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: "-40px" }}
                  transition={{ delay: Math.min(index * 0.025, 0.16) }}
                  className={`overflow-hidden rounded-[22px] border ${
                    selectedEpisode?.id === episode.id
                      ? "border-white/45 bg-white/[0.06]"
                      : "border-white/[0.08] bg-white/[0.028]"
                  }`}
                >
                  <div className="flex items-center gap-3 p-3">
                    <motion.button
                      whileTap={{ scale: 0.97 }}
                      onClick={() => {
                        setSelectedEpisode(episode);
                        void watchNow(episode);
                      }}
                      disabled={starting}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:opacity-50"
                    >
                      <div className="relative aspect-video w-[122px] shrink-0 overflow-hidden rounded-2xl">
                        <Artwork
                          src={episode.thumbnail}
                          title={episode.name ?? episode.title ?? `Episode ${episode.episode}`}
                          variant="landscape"
                          className="h-full w-full object-cover"
                          draggable={false}
                        />
                        <span className="absolute inset-0 flex items-center justify-center bg-black/20">
                          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-black shadow-lg">
                            <Play size={13} fill="currentColor" />
                          </span>
                        </span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-400">
                          Episode {episode.episode}
                        </p>
                        <p className="mt-1 line-clamp-2 text-[13px] font-bold leading-4">
                          {episode.name ?? episode.title ?? `Episode ${episode.episode}`}
                        </p>
                      </div>
                    </motion.button>
                    <motion.button
                      whileTap={{ scale: 0.88 }}
                      onClick={() => {
                        setSelectedEpisode(episode);
                        setSourceOpen(true);
                      }}
                      aria-label={`Choose stream for episode ${episode.episode}`}
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/15 bg-black/20 text-zinc-300"
                    >
                      <ListFilter size={15} />
                    </motion.button>
                  </div>
                  {episode.overview && (
                    <p className="line-clamp-2 px-3 pb-3 text-[11px] leading-[1.5] text-zinc-400">
                      {episode.overview}
                    </p>
                  )}
                </motion.article>
              ))}
            </div>
          </section>
        )}

        <RelatedShelf title={meta.name} items={related} />

        <TorrentModal
          initialQuery={query}
          lookup={lookup}
          media={{
            title: meta.name,
            subtitle:
              type === "series" && selectedEpisode
                ? `S${selectedEpisode.season} E${selectedEpisode.episode} · ${selectedEpisode.name ?? selectedEpisode.title ?? `Episode ${selectedEpisode.episode}`}`
                : meta.releaseInfo ?? meta.year,
            posterUrl: meta.poster,
            isEpisode: type === "series",
            season: type === "series" ? selectedEpisode?.season : undefined,
            episode: type === "series" ? selectedEpisode?.episode : undefined,
            episodeQueue:
              type === "series" ? episodesAfter(meta.videos, selectedEpisode) : undefined,
            resumeSeconds: canResume ? savedProgress?.position : undefined,
            ...catalogMetadata,
          }}
          open={sourceOpen}
          onClose={() => setSourceOpen(false)}
        />
      </motion.main>
    );
  }

  const episodeTitle = (episode: StremioVideo) => episode.name ?? episode.title ?? `Episode ${episode.episode}`;
  const selectSeason = (season: number) => {
    setSelectedSeason(season);
    setSelectedEpisode(meta.videos?.find((video) => video.season === season) ?? null);
  };

  return (
    <motion.main
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="editorial-title min-h-screen bg-surface pb-20"
    >
      <section className="relative h-[min(86vh,880px)] min-h-[580px] overflow-hidden">
        <div className="ak-backdrop-in absolute inset-0">
          <Artwork
            src={meta.background ?? meta.poster}
            title={meta.name}
            variant="backdrop"
            className="h-full w-full object-cover object-[center_20%]"
            draggable={false}
          />
        </div>
        <div className="absolute inset-x-0 top-0 h-36 bg-gradient-to-b from-black/65 to-transparent" />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(0,0,0,.9)_0%,rgba(0,0,0,.58)_38%,rgba(0,0,0,0)_72%)]" />
        <div className="absolute inset-x-0 bottom-0 h-[62%] bg-gradient-to-t from-surface via-surface/70 to-transparent" />

        <div className="ak-gutter absolute inset-x-0 bottom-0 flex items-end gap-8 pb-[clamp(36px,6vh,64px)]">
          {/* A poster only when there is no backdrop; otherwise the artwork leads. */}
          {!meta.background && (
            <div className="ak-rise-in hidden aspect-[2/3] w-40 shrink-0 overflow-hidden rounded-xl shadow-[0_24px_70px_rgba(0,0,0,.65)] ring-1 ring-white/15 lg:block">
              <Artwork src={meta.poster} title={meta.name} variant="poster" className="h-full w-full object-cover" draggable={false} />
            </div>
          )}
          <div className="ak-rise-in min-w-0 max-w-[700px]">
            <p className="ak-eyebrow mb-3 !text-zinc-200">{type === "series" ? "Series" : "Film"}</p>
            <h1 className="hero-shadow">{meta.name}</h1>
            <div className="ak-meta mt-4">
              {meta.imdbRating && (
                <span className="flex items-center gap-1 font-semibold text-white" aria-label={`IMDb rating ${meta.imdbRating}`}>
                  <Star size={13} fill="currentColor" aria-hidden="true" /> {meta.imdbRating}
                </span>
              )}
              {(meta.releaseInfo ?? meta.year) && <span>{meta.releaseInfo ?? meta.year}</span>}
              {meta.runtime && (
                <span className="inline-flex items-center gap-1">
                  <Clock3 size={13} aria-hidden="true" /> {meta.runtime}
                </span>
              )}
              {!!meta.genres?.length && <span>{meta.genres.slice(0, 3).join(", ")}</span>}
            </div>
            {meta.description && (
              <p className="mt-4 line-clamp-3 max-w-[600px] text-[15px] leading-[1.6] text-zinc-300">
                {meta.description}
              </p>
            )}
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void watchNow()}
                disabled={!lookup}
                className="desktop-control desktop-primary min-w-[148px]"
              >
                {starting ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Play size={18} fill="currentColor" aria-hidden="true" />}
                {starting ? "Cancel" : resumeActionLabel}
              </button>
              <button
                type="button"
                onClick={() => setSourceOpen(true)}
                disabled={!lookup}
                className="desktop-control desktop-secondary"
              >
                <ListFilter size={17} aria-hidden="true" /> Choose stream
              </button>
              <div className="ml-1">
                <RatingControl compact value={personalRating} onChange={(value) => setRating(historyTitle, value)} />
              </div>
            </div>
            <div className="mt-3 min-h-[22px] max-w-[560px]" role="status" aria-live="polite">
              {starting ? (
                <div className="max-w-sm">
                  <p className="mb-2 text-xs font-semibold text-white">{startPhase ?? "Starting playback"}…</p>
                  <div className="ak-progress-indeterminate" />
                </div>
              ) : (
                <p className="text-xs text-zinc-400">Watch picks the fastest source. Choose stream to pick quality, audio and size.</p>
              )}
            </div>
          </div>
        </div>
      </section>

      {type === "series" && seasons.length > 0 && (
        <section aria-labelledby="episodes-heading" className="ak-gutter pt-6">
          <div className="max-w-[1120px]">
            <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-3">
              <h2 id="episodes-heading" className="ak-section-title !text-[22px]">Episodes</h2>
              {seasons.length <= 8 ? (
                <div role="group" aria-label="Season" className="no-scrollbar flex gap-1.5 overflow-x-auto">
                  {seasons.map((season) => (
                    <button
                      key={season}
                      type="button"
                      onClick={() => selectSeason(season)}
                      aria-pressed={selectedSeason === season}
                      className="ak-chip"
                    >
                      Season {season}
                    </button>
                  ))}
                </div>
              ) : (
                <select
                  value={selectedSeason}
                  onChange={(event) => selectSeason(Number(event.target.value))}
                  aria-label="Season"
                  className="ak-field !rounded-full !px-4 !text-[13px]"
                >
                  {seasons.map((season) => <option key={season} value={season}>Season {season}</option>)}
                </select>
              )}
              <span className="ml-auto text-xs text-zinc-400">
                {episodes.length} episode{episodes.length === 1 ? "" : "s"}
              </span>
            </div>
            <ol key={selectedSeason} className="ak-page-in divide-y divide-white/[0.06] border-y border-white/[0.06]">
              {episodes.map((episode) => {
                const selected = selectedEpisode?.id === episode.id;
                return (
                  <li
                    key={episode.id}
                    aria-current={selected ? "true" : undefined}
                    className={`group relative flex items-center gap-2 transition-colors duration-150 ${
                      selected ? "bg-white/[0.05]" : "hover:bg-white/[0.035]"
                    }`}
                  >
                    {selected && <span aria-hidden="true" className="absolute inset-y-3 left-0 w-0.5 rounded-full bg-white" />}
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedEpisode(episode);
                        void watchNow(episode);
                      }}
                      disabled={starting}
                      aria-label={`Play episode ${episode.episode}: ${episodeTitle(episode)}`}
                      className="flex min-w-0 flex-1 items-center gap-4 rounded-lg py-3 pl-4 pr-2 text-left disabled:opacity-50 lg:gap-5"
                    >
                      <span className="relative aspect-video w-36 shrink-0 overflow-hidden rounded-lg bg-surface-raised lg:w-48">
                        <Artwork
                          src={episode.thumbnail}
                          title={episodeTitle(episode)}
                          variant="landscape"
                          className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.04]"
                          draggable={false}
                        />
                        <span className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-black">
                            <Play size={14} fill="currentColor" aria-hidden="true" />
                          </span>
                        </span>
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-400">
                          Episode {episode.episode}
                          {selected && <span className="ml-2 normal-case tracking-normal text-white">· Selected</span>}
                        </span>
                        <span className="mt-1 block truncate text-[15px] font-semibold text-zinc-100">{episodeTitle(episode)}</span>
                        {episode.overview && (
                          <span className="mt-1 line-clamp-2 block max-w-[640px] text-[13px] leading-5 text-zinc-400">{episode.overview}</span>
                        )}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedEpisode(episode);
                        setSourceOpen(true);
                      }}
                      disabled={starting}
                      title={`Choose a stream for episode ${episode.episode}`}
                      aria-label={`Choose a stream for episode ${episode.episode}`}
                      className="desktop-control desktop-ghost desktop-control--sm mr-3 shrink-0 opacity-70 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                    >
                      <ListFilter size={15} aria-hidden="true" /> Sources
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        </section>
      )}

      {related.length > 0 && (
        <div className="pt-12">
          <DiscoverRow title="More like this" tagline="Related by genre, era and rating" items={related} />
        </div>
      )}

      <TorrentModal
        initialQuery={query}
        lookup={lookup}
        media={{
          title: meta.name,
          subtitle:
            type === "series" && selectedEpisode
              ? `S${selectedEpisode.season} E${selectedEpisode.episode} · ${selectedEpisode.name ?? selectedEpisode.title ?? `Episode ${selectedEpisode.episode}`}`
              : meta.releaseInfo ?? meta.year,
          posterUrl: meta.poster,
          isEpisode: type === "series",
          season: type === "series" ? selectedEpisode?.season : undefined,
          episode: type === "series" ? selectedEpisode?.episode : undefined,
          episodeQueue:
            type === "series" ? episodesAfter(meta.videos, selectedEpisode) : undefined,
          resumeSeconds: canResume ? savedProgress?.position : undefined,
          ...catalogMetadata,
        }}
        open={sourceOpen}
        onClose={() => setSourceOpen(false)}
      />
    </motion.main>
  );
}
