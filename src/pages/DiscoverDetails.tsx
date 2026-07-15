import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ChevronRight, Clock3, DownloadCloud, LoaderCircle, Play, Star } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { cinemeta } from "@/api/cinemeta";
import Spinner from "@/components/Spinner";
import TorrentModal from "@/components/TorrentModal";
import type { StremioMediaType, StremioMeta, StremioVideo } from "@/types/stremio";
import { useTorrents } from "@/stores/torrentStore";
import { usePlayback } from "@/stores/playbackStore";
import { isAppleMobile } from "@/lib/platform";
import { englishSafeSources } from "@/lib/sourceLanguage";

export default function DiscoverDetails() {
  const navigate = useNavigate();
  const searchSources = useTorrents((state) => state.search);
  const raceStreamSources = useTorrents((state) => state.raceStreamSources);
  const openDirect = usePlayback((state) => state.openDirect);
  const { type, imdbId } = useParams<{ type: StremioMediaType; imdbId: string }>();
  const [meta, setMeta] = useState<StremioMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [selectedSeason, setSelectedSeason] = useState(1);
  const [selectedEpisode, setSelectedEpisode] = useState<StremioVideo | null>(null);
  const [starting, setStarting] = useState(false);
  const mobileApple = isAppleMobile();

  useEffect(() => {
    if (!type || !imdbId) return;
    const ctrl = new AbortController();
    cinemeta
      .meta(type, imdbId, ctrl.signal)
      .then((value) => {
        setMeta(value);
        const first = value.videos?.find((video) => video.season > 0) ?? value.videos?.[0];
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
        throw new Error(
          "iPhone and iPad playback needs a hosted/debrid source or a connected Jellyfin library. Peer streaming is available in the desktop app."
        );
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

  return (
    <motion.main initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="min-h-screen bg-surface pb-20">
      <section className="relative h-[82vh] min-h-[620px] overflow-hidden">
        {meta.background && (
          <motion.img
            initial={{ scale: 1.04, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.8 }}
            src={meta.background}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/20 to-black/25" />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(9,8,6,.97)_0%,rgba(9,8,6,.7)_44%,rgba(9,8,6,.08)_82%)]" />
        <div className="absolute left-[58%] top-[26%] h-80 w-80 rounded-full bg-brand/15 blur-[120px]" />
        <div className="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-black/70 to-transparent" />

        <div className="absolute bottom-12 left-6 right-6 flex max-w-6xl items-end gap-8 md:left-12">
          {meta.poster && (
            <motion.img
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              src={meta.poster}
              alt=""
              className="hidden aspect-[2/3] w-44 rounded-2xl object-cover shadow-[0_24px_70px_rgba(0,0,0,.65)] ring-1 ring-white/10 lg:block"
            />
          )}
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
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button
                onClick={() => void watchNow()}
                disabled={!lookup}
                className="prism-border flex items-center gap-2 rounded-2xl bg-gradient-to-r from-brand-light to-brand px-6 py-3.5 text-sm font-bold text-[#090806] shadow-[0_14px_40px_rgba(152,117,47,.24)] transition hover:-translate-y-0.5 hover:brightness-110 disabled:opacity-40"
              >
                {starting ? <LoaderCircle size={18} className="animate-spin" /> : <Play size={18} fill="currentColor" />}
                {starting ? "Opening…" : "Watch now"}
              </button>
              {!mobileApple && (
                <button
                  onClick={() => setSourceOpen(true)}
                  disabled={!lookup}
                  className="glass-panel flex items-center gap-2 rounded-2xl px-5 py-3.5 text-sm font-semibold transition hover:-translate-y-0.5 hover:bg-white/[0.10] disabled:opacity-40"
                >
                  <DownloadCloud size={18} /> Download
                </button>
              )}
              <span className="text-[11px] text-zinc-500">
                {mobileApple ? "Hosted or Jellyfin playback" : "Choose temporary stream or offline copy"}
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
              <button
                key={episode.id}
                onClick={() => {
                  setSelectedEpisode(episode);
                  void watchNow(episode);
                }}
                disabled={starting}
                className={`group flex w-full items-center gap-4 rounded-2xl border p-3 text-left transition ${
                  selectedEpisode?.id === episode.id
                    ? "border-brand/30 bg-brand/[0.06]"
                    : "border-white/[0.07] bg-white/[0.03] hover:border-white/15 hover:bg-white/[0.05]"
                }`}
              >
                <span className="w-7 text-center text-zinc-500">{episode.episode}</span>
                {episode.thumbnail ? (
                  <img src={episode.thumbnail} alt="" className="aspect-video w-40 rounded-xl object-cover" />
                ) : (
                  <div className="aspect-video w-40 rounded-xl bg-zinc-800" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {episode.name ?? episode.title ?? `Episode ${episode.episode}`}
                  </p>
                  {episode.overview && (
                    <p className="mt-1 line-clamp-2 text-xs text-zinc-400">{episode.overview}</p>
                  )}
                </div>
                <ChevronRight size={18} className="mr-3 shrink-0 text-zinc-600 transition group-hover:translate-x-0.5 group-hover:text-white" />
              </button>
            ))}
          </div>
        </section>
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
        }}
        open={sourceOpen}
        onClose={() => setSourceOpen(false)}
      />
    </motion.main>
  );
}
