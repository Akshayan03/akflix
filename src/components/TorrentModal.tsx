/** Premium Torrentio source picker with explicit temporary-stream/offline modes. */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  ExternalLink,
  Gauge,
  HardDrive,
  Languages,
  LoaderCircle,
  Radio,
  Search,
  ShieldCheck,
  Sparkles,
  Users,
  Wifi,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { withTimeout } from "@/lib/withTimeout";
import { useTorrents } from "@/stores/torrentStore";
import { useSettings } from "@/stores/settingsStore";
import { usePlayback } from "@/stores/playbackStore";
import type { DirectPlaybackMetadata } from "@/stores/playbackStore";
import { useT } from "@/i18n";
import { formatBytes } from "@/lib/utils";
import Spinner from "@/components/Spinner";
import Artwork from "@/components/Artwork";
import type { TorrentAddMode, TorrentResult } from "@/types/torrent";
import type { TorrentioLookup } from "@/api/torrentio";
import { sourceLanguage, type SourceLanguage } from "@/lib/sourceLanguage";
import { isAppleMobile } from "@/lib/platform";

interface Props {
  initialQuery: string;
  open: boolean;
  onClose: () => void;
  lookup?: TorrentioLookup;
  media?: DirectPlaybackMetadata;
}

type SortMode = "recommended" | "quality" | "seeders" | "smallest";
type QualityFilter = "all" | "4k" | "1080p" | "720p" | "sd";
type LanguageFilter = "all" | SourceLanguage;
type SourceFilter = "all" | "web" | "bluray" | "cam" | "other";
type SpeedFilter = "all" | "fast" | "direct";

const LANGUAGE_DETAILS: Record<SourceLanguage, { label: string }> = {
  english: { label: "English" },
  multi: { label: "Multi audio" },
  unknown: { label: "Audio unlisted" },
  "non-english": { label: "Non English" },
};

/** Peer health as signal bars: the count of filled bars carries the meaning. */
function HealthBars({ level, label }: { level: number; label: string }) {
  return (
    <span className="flex items-end gap-[3px]" role="img" aria-label={`Source health: ${label}`} title={label}>
      {[1, 2, 3, 4].map((bar) => (
        <span
          key={bar}
          className={`w-[3px] rounded-full ${bar <= level ? "bg-white" : "bg-white/20"}`}
          style={{ height: `${4 + bar * 3}px` }}
        />
      ))}
    </span>
  );
}

function sourceFacts(result: TorrentResult) {
  let linkDetails = result.magnetUrl ?? result.downloadUrl ?? "";
  try {
    linkDetails = decodeURIComponent(linkDetails);
  } catch {
    // A malformed display name should never stop the source picker rendering.
  }
  const text = `${result.title} ${linkDetails}`.toLowerCase();
  const resolution = text.match(/\b(4320p|2160p|1080p|720p|480p)\b/i)?.[1]?.toLowerCase();
  const quality =
    resolution === "4320p"
      ? "8K"
      : resolution === "2160p" || (!resolution && text.includes("4k"))
        ? "4K"
        : resolution ?? "Auto";
  const qualityRank =
    resolution === "4320p"
      ? 5
      : resolution === "2160p" || (!resolution && text.includes("4k"))
        ? 4
        : resolution === "1080p"
          ? 3
          : resolution === "720p"
            ? 2
            : resolution === "480p"
              ? 1
              : 0;
  const codec = /\b(h\.?264|x264|avc)\b/i.test(text)
    ? "H.264"
    : /\b(h\.?265|x265|hevc)\b/i.test(text)
      ? "HEVC"
      : /\bav1\b/i.test(text)
        ? "AV1"
        : "Video";
  const container = /\.mp4\b/i.test(text)
    ? "MP4"
    : /\.mkv\b/i.test(text)
      ? "MKV"
      : "File";
  const picture = /\b(dolby[ ._-]*vision|dovi|dv)\b/i.test(text)
    ? "Dolby Vision"
    : /\bhdr10\+?\b/i.test(text)
      ? "HDR10"
      : /\bhdr\b/i.test(text)
        ? "HDR"
        : null;
  const audio = /\batmos\b/i.test(text)
    ? "Atmos"
    : /\b7[ .]1\b/i.test(text)
      ? "7.1 audio"
      : /\b5[ .]1\b/i.test(text)
        ? "5.1 audio"
        : null;
  const releaseType = /remux/i.test(text)
    ? "BluRay Remux"
    : /\b(bluray|blu[ ._-]*ray|bdrip|brrip)\b/i.test(text)
      ? "BluRay"
      : /\bweb[ ._-]*dl(?:rip)?\b/i.test(text)
        ? "WEB-DL"
        : /\bweb[ ._-]*rip\b/i.test(text)
          ? "WEBRip"
          : /\bhdrip\b/i.test(text)
            ? "HDRip"
            : /\bweb\b/i.test(text)
              ? "WEB"
              : /\bhdtv\b/i.test(text)
                ? "HDTV"
                : /\b(dvdrip|dvd)\b/i.test(text)
                  ? "DVD"
                  : /\b(telesync|hdts|tsrip)\b/i.test(text)
                    ? "TeleSync"
                    : /\b(camrip|hdcam|cam)\b/i.test(text)
                      ? "CAM"
                      : result.streamUrl
                        ? "Hosted stream"
                        : "Streaming source";
  const sourceGroup: Exclude<SourceFilter, "all"> =
    releaseType.startsWith("WEB") || releaseType === "HDRip" || releaseType === "HDTV"
      ? "web"
      : releaseType.startsWith("BluRay") || releaseType === "DVD"
        ? "bluray"
        : releaseType === "CAM" || releaseType === "TeleSync"
          ? "cam"
          : "other";
  const language = LANGUAGE_DETAILS[sourceLanguage(result)];
  const hosted = !!result.streamUrl;
  const directPlay = !!result.streamUrl || (container === "MP4" && codec === "H.264");
  const health =
    hosted
      ? { label: "Instant", level: 4 }
      : result.seeders >= 500
      ? { label: "Excellent", level: 4 }
      : result.seeders >= 100
        ? { label: "Healthy", level: 3 }
        : result.seeders >= 20
          ? { label: "Fair", level: 2 }
          : { label: "Slow", level: 1 };
  return {
    quality,
    qualityRank,
    releaseType,
    sourceGroup,
    codec,
    container,
    picture,
    audio,
    language,
    hosted,
    directPlay,
    health,
  };
}

export default function TorrentModal({ initialQuery, open, onClose, lookup, media }: Props) {
  const t = useT();
  const navigate = useNavigate();
  const openDirect = usePlayback((state) => state.openDirect);
  const { search, addTorrent, beginStreamRequest, setStreamLaunchPhase } = useTorrents();
  const torrentSource = useSettings((state) => state.torrentSource);
  const mobileApple = isAppleMobile();

  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<TorrentResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addedGuid, setAddedGuid] = useState<string | null>(null);
  const [actingGuid, setActingGuid] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>("recommended");
  const [qualityFilter, setQualityFilter] = useState<QualityFilter>("all");
  const [languageFilter, setLanguageFilter] = useState<LanguageFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [speedFilter, setSpeedFilter] = useState<SpeedFilter>("all");
  const searchController = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, open]);

  const runSearch = async (value: string) => {
    searchController.current?.abort();
    if (!value.trim()) {
      setLoading(false);
      setResults([]);
      setError(null);
      return;
    }
    const controller = new AbortController();
    searchController.current = controller;
    setLoading(true);
    setResults([]);
    setError(null);
    if (torrentSource === "torrentio" && !lookup) {
      setResults([]);
      setError("Torrentio needs an IMDb-backed title. Open it from Discover and try again.");
      setLoading(false);
      return;
    }
    try {
      const found = await withTimeout((signal) => search(value.trim(), signal, lookup), 25000, controller.signal);
      if (!controller.signal.aborted) setResults(found);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    setResults([]);
    setAddedGuid(null);
    setActingGuid(null);
    setSortMode("recommended");
    setQualityFilter("all");
    setLanguageFilter("all");
    setSourceFilter("all");
    setSpeedFilter("all");
    runSearch(initialQuery);
    return () => searchController.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialQuery, lookup?.imdbId, lookup?.type, lookup?.season, lookup?.episode, torrentSource]);

  const compatibleResults = useMemo(
    () => mobileApple ? results.filter((result) => !!result.streamUrl) : results,
    [mobileApple, results]
  );

  const filteredSorted = useMemo(() => {
    const filtered = compatibleResults.filter((result) => {
      const facts = sourceFacts(result);
      const language = sourceLanguage(result);
      const matchesQuality =
        qualityFilter === "all" ||
        (qualityFilter === "4k" && facts.qualityRank >= 4) ||
        (qualityFilter === "1080p" && facts.qualityRank === 3) ||
        (qualityFilter === "720p" && facts.qualityRank === 2) ||
        (qualityFilter === "sd" && facts.qualityRank <= 1);
      const matchesLanguage = languageFilter === "all" || language === languageFilter;
      const matchesSource = sourceFilter === "all" || facts.sourceGroup === sourceFilter;
      const matchesSpeed =
        speedFilter === "all" ||
        (speedFilter === "fast" && (facts.hosted || result.seeders >= 100)) ||
        (speedFilter === "direct" && facts.directPlay);
      return matchesQuality && matchesLanguage && matchesSource && matchesSpeed;
    });

    if (sortMode === "quality") {
      return [...filtered].sort((a, b) => {
        const quality = sourceFacts(b).qualityRank - sourceFacts(a).qualityRank;
        return quality || b.seeders - a.seeders;
      });
    }
    if (sortMode === "seeders") return [...filtered].sort((a, b) => b.seeders - a.seeders);
    if (sortMode === "smallest") {
      return [...filtered].sort((a, b) => {
        if (!a.size) return 1;
        if (!b.size) return -1;
        return a.size - b.size;
      });
    }
    return filtered;
  }, [compatibleResults, languageFilter, qualityFilter, sortMode, sourceFilter, speedFilter]);

  const filtersActive =
    qualityFilter !== "all" ||
    languageFilter !== "all" ||
    sourceFilter !== "all" ||
    speedFilter !== "all";
  const clearFilters = () => {
    setQualityFilter("all");
    setLanguageFilter("all");
    setSourceFilter("all");
    setSpeedFilter("all");
  };
  const mediaTitle =
    media?.title?.trim() ||
    initialQuery.replace(/\s+\(?\d{4}\)?(?:\s+s\d{1,2}e\d{1,2})?$/i, "").trim() ||
    initialQuery;

  const recommendedGuid = compatibleResults[0]?.guid;

  const act = async (result: TorrentResult, mode: TorrentAddMode) => {
    if (actingGuid) return;
    setActingGuid(result.guid);
    let requestId: number | undefined;
    try {
      if (mode === "stream") usePlayback.getState().stop();
      requestId =
        mode === "stream"
          ? await beginStreamRequest(media ?? null)
          : undefined;
      if (requestId !== undefined && useTorrents.getState().streamRequestId !== requestId) return;
      if (mobileApple && !result.streamUrl) {
        throw new Error("This iPhone source is not a hosted stream. Choose a hosted/debrid option.");
      }
      if (mode === "stream" && result.streamUrl) {
        if (requestId !== undefined) setStreamLaunchPhase(requestId, "Opening player");
        openDirect({
          ...media,
          id: result.guid,
          url: result.streamUrl,
          title: mediaTitle,
          subtitle: media?.subtitle,
          posterUrl: media?.posterUrl,
          isEpisode: media?.isEpisode,
          season: media?.season,
          episode: media?.episode,
        });
        if (requestId !== undefined) setStreamLaunchPhase(requestId, null);
        toast.success("Direct stream ready", {
          description: "Using the hosted/debrid link. No peer discovery or torrent buffer.",
        });
        onClose();
        navigate("/stream");
        return;
      }
      if (mode === "stream") {
        await addTorrent(result, "stream", [], media, undefined, requestId);
      } else {
        await addTorrent(result, mode);
      }
      setAddedGuid(result.guid);
      if (mode === "stream") {
        const facts = sourceFacts(result);
        toast.success("Selected stream started", {
          description: `${facts.quality} · ${facts.language.label} · ${result.size ? formatBytes(result.size) : "Hosted link"}`,
        });
        onClose();
      } else {
        toast.success("Saved for offline", {
          description: "The complete file will remain in your library.",
        });
      }
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      toast.error(t("common.error"), {
        description: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      if (requestId !== undefined && !useTorrents.getState().pendingStreamHash) {
        setStreamLaunchPhase(requestId, null);
      }
      setActingGuid(null);
    }
  };

  const copyMagnet = (result: TorrentResult) => {
    if (!result.magnetUrl) return;
    navigator.clipboard.writeText(result.magnetUrl);
    toast.success("Magnet copied");
  };

  return createPortal((
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className={`fixed inset-0 z-50 flex bg-black/80 backdrop-blur-md ${
            mobileApple ? "items-end p-0" : "items-center justify-center p-4"
          }`}
          onClick={onClose}
        >
          <motion.section
            initial={mobileApple ? { opacity: 0, y: "100%" } : { opacity: 0, scale: 0.97, y: 24 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={mobileApple ? { opacity: 0, y: "100%" } : { opacity: 0, scale: 0.98, y: 12 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={`Choose a source for ${mediaTitle}`}
            className={`glass-panel flex w-full max-w-5xl flex-col overflow-hidden shadow-[0_30px_120px_rgba(0,0,0,.8)] ${
              mobileApple
                ? "max-h-[94svh] rounded-b-none rounded-t-[32px] border-x-0 border-b-0"
                : "max-h-[90vh] rounded-[30px]"
            }`}
          >
            <header className={`relative shrink-0 overflow-hidden border-b border-white/[0.07] ${mobileApple ? "px-4 pb-3 pt-2" : "px-5 pb-4 pt-5 md:px-6"}`}>
              {mobileApple && <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-white/20" />}
              <div className="pointer-events-none absolute -right-20 -top-28 h-64 w-64 rounded-full bg-white/[0.05] blur-[90px]" />
              <div className="relative flex items-start gap-4">
                <Artwork
                  src={media?.posterUrl}
                  title={media?.title ?? initialQuery}
                  variant="poster"
                  className={`${mobileApple ? "h-[64px] w-[44px]" : "h-[76px] w-[52px]"} shrink-0 rounded-xl object-cover shadow-xl ring-1 ring-white/10`}
                />
                <div className="min-w-0 flex-1 pt-0.5">
                  <div className="flex items-center gap-2">
                    <span className="ak-badge !text-[9px] !tracking-[0.18em]">
                      {mobileApple ? "Hosted source" : "Manual source"}
                    </span>
                    {!loading && compatibleResults.length > 0 && (
                      <span role="status" className="text-[10px] text-zinc-400">
                        {filtersActive ? `${filteredSorted.length} of ${compatibleResults.length} shown` : `${compatibleResults.length} available`}
                      </span>
                    )}
                  </div>
                  <h2 className={`${mobileApple ? "mt-1.5 text-[18px]" : "mt-2 text-xl"} truncate font-bold tracking-tight`}>
                    {mobileApple ? mediaTitle : `Choose a stream for ${mediaTitle}`}
                  </h2>
                  <p className="mt-1 truncate text-xs text-zinc-400">{media?.subtitle ?? initialQuery}</p>
                </div>
                <button
                  onClick={onClose}
                  aria-label="Close source picker"
                  className="rounded-full p-2 text-zinc-300 transition hover:bg-white/10 hover:text-white"
                >
                  <X size={20} />
                </button>
              </div>

              {!mobileApple && <div className="relative mt-4 flex items-start gap-3 rounded-2xl border border-white/15 bg-white/[0.04] px-4 py-3">
                <ShieldCheck size={17} className="mt-0.5 shrink-0 text-white" aria-hidden="true" />
                <div>
                  <p className="text-xs font-semibold text-zinc-100">Your choice stays selected</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">
                    {mobileApple
                      ? "Only hosted links that iPhone can open without a desktop peer engine are shown. Compare the available formats below."
                      : "Unlike Watch Now, manual mode does not race or replace your source. Compare audio, picture, size and peer health below."}
                  </p>
                </div>
              </div>}

              {mobileApple && (
                <div className="mt-3 flex items-center gap-2 rounded-2xl border border-white/15 bg-white/[0.04] px-3 py-2.5 text-[11px] text-zinc-100">
                  <ShieldCheck size={15} className="shrink-0" aria-hidden="true" /> Only iPhone-compatible hosted links are shown
                </div>
              )}

              <form
                className={`relative flex flex-col gap-2 md:flex-row ${mobileApple ? "mt-3" : "mt-4"}`}
                onSubmit={(event) => {
                  event.preventDefault();
                  runSearch(query);
                }}
              >
                <label className={`${mobileApple ? "hidden" : "flex"} min-w-0 flex-1 items-center gap-2 rounded-xl border border-white/15 bg-black/30 px-3 transition-colors focus-within:border-white/60`}>
                  <Search size={15} className="shrink-0 text-zinc-400" aria-hidden="true" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search sources"
                    aria-label="Search sources"
                    className="search-input w-full bg-transparent py-2.5 text-sm outline-none placeholder:text-zinc-500"
                  />
                </label>
                <div role="group" aria-label="Sort sources" className="no-scrollbar flex overflow-x-auto rounded-xl border border-white/15 bg-black/30 p-1">
                  {(
                    [
                      ["recommended", "Best"],
                      ["quality", "Quality"],
                      ["seeders", "Seeders"],
                      ["smallest", "Smallest"],
                    ] as [SortMode, string][]
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setSortMode(mode)}
                      aria-pressed={sortMode === mode}
                      className={`shrink-0 rounded-lg px-3 py-1.5 text-[11px] font-semibold transition ${
                        sortMode === mode
                          ? "bg-white text-black"
                          : "text-zinc-400 hover:text-white"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </form>

              <div className="relative mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
                <label className="min-w-0">
                  <span className="sr-only">Filter by quality</span>
                  <select
                    value={qualityFilter}
                    onChange={(event) => setQualityFilter(event.target.value as QualityFilter)}
                    className="w-full rounded-xl border border-white/15 bg-[#0e0e0e] px-3 py-2.5 text-[11px] font-semibold text-zinc-200 outline-none transition focus:border-white/70"
                  >
                    <option value="all">All quality</option>
                    <option value="4k">4K and 8K</option>
                    <option value="1080p">1080p</option>
                    <option value="720p">720p</option>
                    <option value="sd">SD and Auto</option>
                  </select>
                </label>
                <label className="min-w-0">
                  <span className="sr-only">Filter by audio language</span>
                  <select
                    value={languageFilter}
                    onChange={(event) => setLanguageFilter(event.target.value as LanguageFilter)}
                    className="w-full rounded-xl border border-white/15 bg-[#0e0e0e] px-3 py-2.5 text-[11px] font-semibold text-zinc-200 outline-none transition focus:border-white/70"
                  >
                    <option value="all">All audio</option>
                    <option value="english">English</option>
                    <option value="multi">Multi audio</option>
                    <option value="unknown">Audio unlisted</option>
                    <option value="non-english">Non English</option>
                  </select>
                </label>
                <label className="min-w-0">
                  <span className="sr-only">Filter by source type</span>
                  <select
                    value={sourceFilter}
                    onChange={(event) => setSourceFilter(event.target.value as SourceFilter)}
                    className="w-full rounded-xl border border-white/15 bg-[#0e0e0e] px-3 py-2.5 text-[11px] font-semibold text-zinc-200 outline-none transition focus:border-white/70"
                  >
                    <option value="all">All sources</option>
                    <option value="web">WEB</option>
                    <option value="bluray">BluRay</option>
                    <option value="cam">CAM or TeleSync</option>
                    <option value="other">Other</option>
                  </select>
                </label>
                <label className="min-w-0">
                  <span className="sr-only">Filter by stream speed</span>
                  <select
                    value={speedFilter}
                    onChange={(event) => setSpeedFilter(event.target.value as SpeedFilter)}
                    className="w-full rounded-xl border border-white/15 bg-[#0e0e0e] px-3 py-2.5 text-[11px] font-semibold text-zinc-200 outline-none transition focus:border-white/70"
                  >
                    <option value="all">Any speed</option>
                    <option value="fast">Fast peers</option>
                    <option value="direct">Direct play</option>
                  </select>
                </label>
                {filtersActive && (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="col-span-2 rounded-xl border border-white/15 px-3 py-2.5 text-[11px] font-semibold text-zinc-300 transition hover:bg-white/[0.06] hover:text-white sm:col-span-4 lg:col-span-1"
                  >
                    Clear filters
                  </button>
                )}
              </div>
            </header>

            <div className={`min-h-0 flex-1 overflow-y-auto ${mobileApple ? "p-2" : "p-3 md:p-4"}`}>
              {loading && <Spinner label="Finding healthy sources…" />}
              {error && (
                <div role="alert" className="ak-notice ak-notice--error m-2 text-sm">
                  <AlertTriangle size={17} aria-hidden="true" /> <span className="min-w-0 break-words">{error}</span>
                </div>
              )}
              {!loading && !error && !results.length && (
                <div role="status" className="py-16 text-center text-sm text-zinc-300">No playable sources found. Try another search or episode.</div>
              )}
              {!loading && !error && mobileApple && results.length > 0 && !compatibleResults.length && (
                <div className="mx-auto max-w-md py-16 text-center">
                  <p className="text-sm font-semibold text-zinc-200">No hosted streams are configured</p>
                  <p className="mt-2 text-xs leading-5 text-zinc-400">
                    This Torrentio setup returned peer links instead of direct video URLs. Add a debrid provider for instant iPhone playback.
                  </p>
                  <motion.button
                    whileTap={{ scale: 0.96 }}
                    type="button"
                    onClick={() => {
                      onClose();
                      navigate("/settings#hosted-streaming");
                    }}
                    className="mx-auto mt-5 flex h-11 items-center justify-center gap-2 rounded-full bg-white px-5 text-xs font-black text-black"
                  >
                    <ExternalLink size={15} /> Set up instant streaming
                  </motion.button>
                </div>
              )}
              {!loading && !error && compatibleResults.length > 0 && !filteredSorted.length && (
                <div className="flex flex-col items-center gap-3 py-16 text-center text-sm text-zinc-300">
                  <span>No sources match these filters.</span>
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="rounded-full border border-white/20 px-4 py-2 text-xs font-semibold text-zinc-200 transition hover:bg-white/[0.06] hover:text-white"
                  >
                    Clear filters
                  </button>
                </div>
              )}

              <motion.div layout className="space-y-2">
                <AnimatePresence initial={false} mode="popLayout">
                {filteredSorted.map((result, index) => {
                  const facts = sourceFacts(result);
                  const recommended = result.guid === recommendedGuid;
                  const acting = actingGuid === result.guid;
                  const added = addedGuid === result.guid;

                  return (
                    <motion.article
                      key={result.guid}
                      layout
                      aria-label={`Source ${index + 1} for ${mediaTitle}`}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.98 }}
                      whileHover={!mobileApple ? { y: -2, scale: 1.002 } : undefined}
                      transition={{
                        layout: { type: "spring", stiffness: 380, damping: 34 },
                        delay: Math.min(index * 0.025, 0.15),
                      }}
                      className={`relative overflow-hidden rounded-2xl border transition ${mobileApple ? "p-3" : "p-4"} ${
                        recommended
                          ? "border-white/50 bg-white/[0.06]"
                          : "border-white/[0.08] bg-white/[0.025] hover:border-white/20 hover:bg-white/[0.045]"
                      }`}
                    >
                      {recommended && (
                        <div className="absolute right-0 top-0 rounded-bl-xl bg-white px-3 py-1 text-[9px] font-bold uppercase tracking-[0.16em] text-black">
                          <span className="flex items-center gap-1"><Sparkles size={10} aria-hidden="true" /> Auto pick</span>
                        </div>
                      )}

                      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_270px_auto] lg:items-center">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2 pr-24 text-[9px] font-bold uppercase tracking-[0.18em] text-zinc-400">
                            <span>Source {String(index + 1).padStart(2, "0")}</span>
                            <span className="h-1 w-1 rounded-full bg-zinc-600" aria-hidden="true" />
                            <span className="normal-case tracking-normal text-zinc-400">{result.indexer}</span>
                          </div>
                          <h3 className="mt-1.5 text-lg font-bold tracking-tight text-zinc-100">
                            {mediaTitle}
                          </h3>
                          {media?.isEpisode && media.subtitle && (
                            <p className="mt-0.5 truncate text-[11px] text-zinc-400">{media.subtitle}</p>
                          )}
                          <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[10px]">
                            <span className="rounded-md bg-white/[0.05] px-2 py-1 text-zinc-300">
                              {facts.releaseType}
                            </span>
                            <span className="rounded-md bg-white/[0.05] px-2 py-1 text-zinc-400">
                              {facts.codec}
                            </span>
                            <span className="rounded-md bg-white/[0.05] px-2 py-1 text-zinc-400">
                              {facts.container}
                            </span>
                            {facts.picture && (
                              <span className="rounded-md bg-white/[0.05] px-2 py-1 text-zinc-400">
                                {facts.picture}
                              </span>
                            )}
                            {facts.audio && (
                              <span className="rounded-md bg-white/[0.05] px-2 py-1 text-zinc-400">
                                {facts.audio}
                              </span>
                            )}
                            {facts.directPlay && (
                              <span className="flex items-center gap-1 rounded-md bg-white px-2 py-1 font-semibold text-black">
                                <ShieldCheck size={11} aria-hidden="true" /> {facts.hosted ? "Hosted link" : "Direct play"}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-2 rounded-2xl border border-white/[0.06] bg-black/20 p-2.5">
                          <div className="rounded-xl bg-white/[0.035] p-2.5">
                            <span className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-[0.14em] text-zinc-400">
                              <Gauge size={11} /> Quality
                            </span>
                            <strong className="mt-1 block text-sm text-white">{facts.quality}</strong>
                          </div>
                          <div className="rounded-xl bg-white/[0.035] p-2.5">
                            <span className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-[0.14em] text-zinc-400">
                              <Languages size={11} /> Audio
                            </span>
                            <strong className="mt-1 block truncate text-xs text-zinc-200">
                              {facts.language.label}
                            </strong>
                          </div>
                          <div className="rounded-xl bg-white/[0.035] p-2.5">
                            <span className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-[0.14em] text-zinc-400">
                              <HardDrive size={11} /> Size
                            </span>
                            <strong className="mt-1 block text-xs text-zinc-200">
                              {result.size ? formatBytes(result.size) : "Hosted"}
                            </strong>
                          </div>
                          <div className="rounded-xl bg-white/[0.035] p-2.5">
                            <span className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-[0.14em] text-zinc-400">
                              <Users size={11} /> {facts.hosted ? "Speed" : "Peers"}
                            </span>
                            <strong className="mt-1 flex items-center gap-2 text-xs text-white">
                              {facts.hosted ? facts.health.label : result.seeders.toLocaleString()}
                              <HealthBars level={facts.health.level} label={facts.health.label} />
                            </strong>
                          </div>
                        </div>

                        <div className={`flex shrink-0 items-stretch gap-2 ${mobileApple ? "w-full" : ""}`}>
                          {added ? (
                            <div role="status" className="flex min-w-32 items-center justify-center gap-2 rounded-xl border border-white/40 px-4 py-2 text-xs font-semibold text-white">
                              <Check size={15} aria-hidden="true" /> Added
                            </div>
                          ) : (
                            <>
                              <motion.button
                                whileTap={{ scale: 0.95 }}
                                whileHover={!mobileApple ? { scale: 1.025 } : undefined}
                                onClick={() => act(result, "stream")}
                                disabled={!!actingGuid}
                                className={`group/stream flex min-w-32 items-center justify-center gap-2 rounded-full bg-white px-4 py-2.5 text-xs font-bold text-black transition hover:bg-zinc-200 disabled:opacity-50 ${mobileApple ? "h-11 flex-1" : ""}`}
                              >
                                {acting ? <LoaderCircle size={15} className="animate-spin" /> : <Wifi size={15} />}
                                {acting ? "Starting…" : "Watch this"}
                              </motion.button>
                              {!mobileApple && !result.streamUrl && (
                                <button
                                  onClick={() => act(result, "download")}
                                  disabled={!!actingGuid}
                                  title="Download and keep offline"
                                  className="flex items-center justify-center gap-2 rounded-full border border-white/20 bg-white/[0.04] px-3.5 py-2.5 text-xs font-semibold transition hover:bg-white/10 disabled:opacity-50"
                                >
                                  <Download size={15} /> Save
                                </button>
                              )}
                            </>
                          )}
                          {!mobileApple && result.magnetUrl && (
                            <button
                              onClick={() => copyMagnet(result)}
                              title="Copy magnet"
                              aria-label="Copy magnet link"
                              className="rounded-full border border-white/[0.12] p-2.5 text-zinc-300 transition hover:bg-white/10 hover:text-white"
                            >
                              <Copy size={15} />
                            </button>
                          )}
                        </div>
                      </div>
                    </motion.article>
                  );
                })}
                </AnimatePresence>
              </motion.div>
            </div>

            <footer className={`${mobileApple ? "hidden" : "flex"} shrink-0 items-center justify-between gap-4 border-t border-white/[0.08] bg-black/20 px-5 py-3 text-[10px] text-zinc-500`}>
              <span>⚖️ {t("torrent.disclaimer")}</span>
              <span className="hidden items-center gap-1 md:flex"><Radio size={11} /> {mobileApple ? "Hosted playback on iPhone" : "Powered by Torrentio + your local stream engine"}</span>
            </footer>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  ), document.body);
}
