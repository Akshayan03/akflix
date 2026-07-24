import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ChevronRight, Clock3, ListFilter, LoaderCircle, Play, Sparkles, Star } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { cinemeta } from "@/api/cinemeta";
import Spinner from "@/components/Spinner";
import TorrentModal from "@/components/TorrentModal";
import Artwork from "@/components/Artwork";
import DiscoverCard from "@/components/DiscoverCard";
import type { StremioMediaType, StremioMeta, StremioVideo } from "@/types/stremio";
import { useTorrents } from "@/stores/torrentStore";
import { usePlayback } from "@/stores/playbackStore";
import { isAppleMobile } from "@/lib/platform";
import { englishSafeSources } from "@/lib/sourceLanguage";
import RatingControl from "@/components/RatingControl";
import { useAuth } from "@/stores/authStore";
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
          <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.22em] text-accent">
            <Sparkles size={12} /> Discover next
          </p>
          <h2 className="mt-1 text-2xl font-black tracking-tight">More Like This</h2>
        </div>
        <p className="hidden max-w-sm text-right text-xs leading-5 text-zinc-500 sm:block">
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
  const openDirect = usePlayback((state) => state.openDirect);
  const profileId = useAuth((state) => state.activeProfileId) ?? "akflix-local";
  const historyEntries = useHistory((state) => state.entries);
  const ratings = useHistory((state) => state.ratings);
  const setRating = useHistory((state) => state.setRating);
  const { type, imdbId } = useParams<{ type: StremioMediaType; imdbId: string }>();
  const [meta, setMeta] = useState<StremioMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [selectedSeason, setSelectedSeason] = useState(1);
  const [selectedEpisode, setSelectedEpisode] = useState<StremioVideo | null>(null);
  const [starting, setStarting] = useState(false);
  const [related, setRelated] = useState<StremioMeta[]>([]);
  const mobileApple = isAppleMobile();

  useEffect(() => {
    if (!type || !imdbId) return;
    const ctrl = new AbortController();
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
  }, [type, imdbId]);

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

  if (error) return <p className="p-24 text-center text-sm text-red-400">{error}</p>;
  if (!meta || !type || !imdbId)
    return <div className="pt-40"><Spinner label="Loading title…" /></div>;

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
    if (starting) return;
    const targetLookup =
      type === "movie"
        ? { imdbId, type: "movie" as const }
        : episode
          ? { imdbId, type: "series" as const, season: episode.season, episode: episode.episode }
          : undefined;
    if (!targetLookup) return;
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
      ...catalogMetadata,
    };
    setStarting(true);
    try {
      const results = await searchSources(query, undefined, targetLookup);
      if (!results.length) throw new Error("No playable sources were found for this title.");
      const preferredResults = englishSafeSources(results);
      const hosted = preferredResults.find((result) => result.streamUrl);
      if (hosted?.streamUrl) {
        openDirect({ id: hosted.guid, url: hosted.streamUrl, ...media });
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
      await raceStreamSources(preferredResults, media);
      toast.success("Opening the fastest source", {
        description: "Akflix will switch sources automatically if this one stalls.",
      });
    } catch (reason) {
      toast.error("Couldn’t start playback", {
        description: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      setStarting(false);
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
          <div className="absolute inset-x-0 bottom-0 h-[62%] bg-[linear-gradient(0deg,#090806_3%,rgba(9,8,6,.82)_34%,transparent_100%)]" />
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
              <p className="mb-2 text-[9px] font-bold uppercase tracking-[0.22em] text-accent">
                {type === "series" ? "Series" : "Feature film"}
              </p>
              <h1 className="text-[31px] font-black leading-[0.94] tracking-[-0.055em]">
                {meta.name}
              </h1>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] font-semibold text-zinc-400">
                <span>{meta.releaseInfo ?? meta.year}</span>
                {meta.imdbRating && (
                  <span className="flex items-center gap-1 text-accent">
                    <Star size={11} fill="currentColor" /> {meta.imdbRating}
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
              disabled={!lookup || starting}
              className="flex h-[52px] items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-brand-light to-brand px-5 text-sm font-black text-[#090806] shadow-[0_14px_38px_rgba(152,117,47,.24)] disabled:opacity-40"
            >
              {starting ? <LoaderCircle size={18} className="animate-spin" /> : <Play size={18} fill="currentColor" />}
              {starting ? "Finding stream" : resumeActionLabel}
            </motion.button>
            <motion.button
              whileTap={{ scale: 0.9 }}
              onClick={() => setSourceOpen(true)}
              disabled={!lookup}
              aria-label="Choose hosted stream"
              className="flex h-[52px] items-center justify-center rounded-2xl border border-white/10 bg-white/[0.055] text-zinc-200 backdrop-blur-xl disabled:opacity-40"
            >
              <ListFilter size={20} />
            </motion.button>
          </div>
          <p className="mt-2.5 text-center text-[10px] font-medium text-zinc-600">
            Watch uses the best compatible hosted source. Tap the filter to choose.
          </p>

          <div className="mt-6 flex flex-wrap gap-2">
            {meta.genres?.slice(0, 4).map((genre) => (
              <span key={genre} className="rounded-full border border-white/[0.08] bg-white/[0.035] px-3 py-1.5 text-[10px] font-semibold text-zinc-400">
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
            <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">
              Your rating
            </p>
            <RatingControl value={personalRating} onChange={(value) => setRating(historyTitle, value)} />
          </div>
        </motion.section>

        {type === "series" && seasons.length > 0 && (
          <section className="mt-8">
            <div className="mb-4 flex items-center justify-between px-4">
              <div>
                <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-accent">Episodes</p>
                <h2 className="mt-1 text-[24px] font-black tracking-[-0.04em]">Season {selectedSeason}</h2>
              </div>
              <span className="text-xs text-zinc-600">{episodes.length} episodes</span>
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
                      ? "bg-brand text-[#090806]"
                      : "border border-white/10 bg-white/[0.04] text-zinc-400"
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
                      ? "border-brand/25 bg-brand/[0.055]"
                      : "border-white/[0.07] bg-white/[0.028]"
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
                        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-600">
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
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-black/20 text-zinc-400"
                    >
                      <ListFilter size={15} />
                    </motion.button>
                  </div>
                  {episode.overview && (
                    <p className="line-clamp-2 px-3 pb-3 text-[11px] leading-[1.5] text-zinc-500">
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
            ...catalogMetadata,
          }}
          open={sourceOpen}
          onClose={() => setSourceOpen(false)}
        />
      </motion.main>
    );
  }

  return (
    <motion.main initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="min-h-screen bg-surface pb-20">
      <section className="relative h-[82vh] min-h-[620px] overflow-hidden">
        <motion.div
            initial={{ scale: 1.04, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.8 }}
            className="absolute inset-0 h-full w-full object-cover"
        >
          <Artwork
            src={meta.background ?? meta.poster}
            title={meta.name}
            variant="backdrop"
            className="h-full w-full object-cover"
            draggable={false}
          />
        </motion.div>
        <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/20 to-black/25" />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(9,8,6,.97)_0%,rgba(9,8,6,.7)_44%,rgba(9,8,6,.08)_82%)]" />
        <div className="absolute left-[58%] top-[26%] h-80 w-80 rounded-full bg-brand/15 blur-[120px]" />
        <div className="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-black/70 to-transparent" />

        <div className="absolute bottom-12 left-6 right-6 flex max-w-6xl items-end gap-8 md:left-12">
          <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="hidden aspect-[2/3] w-44 shrink-0 overflow-hidden rounded-2xl shadow-[0_24px_70px_rgba(0,0,0,.65)] ring-1 ring-white/10 lg:block"
          >
            <Artwork
              src={meta.poster}
              title={meta.name}
              variant="poster"
              className="h-full w-full object-cover"
              draggable={false}
            />
          </motion.div>
          <div className="max-w-2xl pb-1">
            <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.26em] text-accent">
              Selected for tonight
            </p>
            <h1 className="hero-shadow text-5xl font-black tracking-[-0.04em] md:text-7xl">{meta.name}</h1>
            <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-zinc-300">
              <span className="rounded-full bg-white/10 px-3 py-1.5 ring-1 ring-white/10">
                {meta.releaseInfo ?? meta.year}
              </span>
              {meta.imdbRating && (
                <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-3 py-1.5 font-semibold text-emerald-400 ring-1 ring-emerald-500/15">
                  <Star size={12} fill="currentColor" /> {meta.imdbRating}
                </span>
              )}
              {meta.runtime && (
                <span className="flex items-center gap-1 rounded-full bg-white/10 px-3 py-1.5 ring-1 ring-white/10">
                  <Clock3 size={12} /> {meta.runtime}
                </span>
              )}
              {meta.genres?.slice(0, 3).map((genre) => (
                <span key={genre} className="text-zinc-400">{genre}</span>
              ))}
            </div>
            {meta.description && (
              <p className="mt-5 line-clamp-3 max-w-xl text-sm leading-6 text-zinc-300 md:text-base">
                {meta.description}
              </p>
            )}
            <div className="mt-5 max-w-md">
              <RatingControl
                value={personalRating}
                onChange={(value) => setRating(historyTitle, value)}
              />
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button
                onClick={() => void watchNow()}
                disabled={!lookup}
                className="prism-border flex items-center gap-2 rounded-2xl bg-gradient-to-r from-brand-light to-brand px-6 py-3.5 text-sm font-bold text-[#090806] shadow-[0_14px_40px_rgba(152,117,47,.24)] transition hover:-translate-y-0.5 hover:brightness-110 disabled:opacity-40"
              >
                {starting ? <LoaderCircle size={18} className="animate-spin" /> : <Play size={18} fill="currentColor" />}
                {starting ? "Opening…" : resumeActionLabel}
              </button>
              <button
                onClick={() => setSourceOpen(true)}
                disabled={!lookup}
                className="glass-panel flex items-center gap-2 rounded-2xl px-5 py-3.5 text-sm font-semibold transition hover:-translate-y-0.5 hover:bg-white/[0.10] disabled:opacity-40"
              >
                <ListFilter size={18} /> {mobileApple ? "Choose hosted stream" : "Choose stream"}
              </button>
              <span className="text-[11px] text-zinc-500">
                {mobileApple ? "Direct hosted playback with no local download" : "Auto pick or choose quality, language and size"}
              </span>
            </div>
          </div>
        </div>
      </section>

      {type === "series" && seasons.length > 0 && (
        <section className="mx-auto max-w-6xl px-6 pt-10 md:px-12">
          <div className="mb-4 flex items-center gap-4">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-accent">Browse</p>
              <h2 className="mt-1 text-2xl font-bold">Episodes</h2>
            </div>
            <select
              value={selectedSeason}
              onChange={(event) => {
                const season = Number(event.target.value);
                setSelectedSeason(season);
                setSelectedEpisode(meta.videos?.find((video) => video.season === season) ?? null);
              }}
              className="ml-auto rounded-xl border border-white/10 bg-white/[0.06] px-4 py-2.5 text-sm outline-none"
            >
              {seasons.map((season) => <option key={season} value={season}>Season {season}</option>)}
            </select>
          </div>
          <div className="grid gap-3">
            {episodes.map((episode) => (
              <div
                key={episode.id}
                className={`group flex w-full items-center rounded-2xl border text-left transition ${
                  selectedEpisode?.id === episode.id
                    ? "border-brand/30 bg-brand/[0.06]"
                    : "border-white/[0.07] bg-white/[0.03] hover:border-white/15 hover:bg-white/[0.05]"
                }`}
              >
                <button
                  onClick={() => {
                    setSelectedEpisode(episode);
                    void watchNow(episode);
                  }}
                  disabled={starting}
                  className="flex min-w-0 flex-1 items-center gap-3 p-3 text-left disabled:opacity-50 sm:gap-4"
                >
                  <span className="w-7 text-center text-zinc-500">{episode.episode}</span>
                  <Artwork
                    src={episode.thumbnail}
                    title={episode.name ?? episode.title ?? `Episode ${episode.episode}`}
                    variant="landscape"
                    className="aspect-video w-24 shrink-0 rounded-xl object-cover sm:w-40"
                    draggable={false}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {episode.name ?? episode.title ?? `Episode ${episode.episode}`}
                    </p>
                    {episode.overview && (
                      <p className="mt-1 line-clamp-2 text-xs text-zinc-400">{episode.overview}</p>
                    )}
                  </div>
                  <ChevronRight size={18} className="shrink-0 text-zinc-600 transition group-hover:translate-x-0.5 group-hover:text-white" />
                </button>
                <button
                  onClick={() => {
                    setSelectedEpisode(episode);
                    setSourceOpen(true);
                  }}
                  disabled={starting}
                  title={`Choose a stream for episode ${episode.episode}`}
                  className="mr-3 flex shrink-0 items-center gap-2 rounded-xl border border-white/10 bg-black/20 p-2 text-[11px] font-semibold text-zinc-400 transition hover:border-brand/30 hover:bg-brand/[0.08] hover:text-brand-light disabled:opacity-50 sm:px-3"
                >
                  <ListFilter size={14} /> <span className="hidden sm:inline">Sources</span>
                </button>
              </div>
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
          ...catalogMetadata,
        }}
        open={sourceOpen}
        onClose={() => setSourceOpen(false)}
      />
    </motion.main>
  );
}
