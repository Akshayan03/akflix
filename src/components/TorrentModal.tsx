/** Premium Torrentio source picker with explicit temporary-stream/offline modes. */

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  Copy,
  Download,
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

interface Props {
  initialQuery: string;
  open: boolean;
  onClose: () => void;
  lookup?: TorrentioLookup;
  media?: DirectPlaybackMetadata;
}

type SortMode = "recommended" | "quality" | "seeders" | "smallest";

const LANGUAGE_DETAILS: Record<SourceLanguage, { label: string; className: string }> = {
  english: { label: "English", className: "bg-emerald-500/10 text-emerald-300" },
  multi: { label: "Multi audio", className: "bg-amber-500/10 text-amber-200" },
  unknown: { label: "Audio unlisted", className: "bg-white/[0.05] text-zinc-400" },
  "non-english": { label: "Non English", className: "bg-red-500/10 text-red-300" },
};

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
  const language = LANGUAGE_DETAILS[sourceLanguage(result)];
  const hosted = !!result.streamUrl;
  const directPlay = !!result.streamUrl || (container === "MP4" && codec === "H.264");
  const health =
    hosted
      ? { label: "Instant", color: "text-emerald-400" }
      : result.seeders >= 500
      ? { label: "Excellent", color: "text-emerald-400" }
      : result.seeders >= 100
        ? { label: "Healthy", color: "text-lime-400" }
        : result.seeders >= 20
          ? { label: "Fair", color: "text-amber-400" }
          : { label: "Slow", color: "text-red-400" };
  const displayName = quality === "Auto" ? releaseType : `${quality} ${releaseType}`;
  return {
    quality,
    qualityRank,
    displayName,
    releaseType,
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

function shortTitle(result: TorrentResult): string {
  return result.title.split("\n")[0].replace(/\\n.*$/, "").trim();
}

export default function TorrentModal({ initialQuery, open, onClose, lookup, media }: Props) {
  const t = useT();
  const navigate = useNavigate();
  const openDirect = usePlayback((state) => state.openDirect);
  const { search, addTorrent } = useTorrents();
  const torrentSource = useSettings((state) => state.torrentSource);

  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<TorrentResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addedGuid, setAddedGuid] = useState<string | null>(null);
  const [actingGuid, setActingGuid] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>("recommended");

  const runSearch = async (value: string) => {
    if (!value.trim()) return;
    setLoading(true);
    setError(null);
    if (torrentSource === "torrentio" && !lookup) {
      setResults([]);
      setError("Torrentio needs an IMDb-backed title. Open it from Discover and try again.");
      setLoading(false);
      return;
    }
    try {
      setResults(await search(value, undefined, lookup));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    setResults([]);
    setAddedGuid(null);
    setActingGuid(null);
    setSortMode("recommended");
    runSearch(initialQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialQuery]);

  const sorted = useMemo(() => {
    if (sortMode === "quality") {
      return [...results].sort((a, b) => {
        const quality = sourceFacts(b).qualityRank - sourceFacts(a).qualityRank;
        return quality || b.seeders - a.seeders;
      });
    }
    if (sortMode === "seeders") return [...results].sort((a, b) => b.seeders - a.seeders);
    if (sortMode === "smallest") {
      return [...results].sort((a, b) => {
        if (!a.size) return 1;
        if (!b.size) return -1;
        return a.size - b.size;
      });
    }
    return results;
  }, [results, sortMode]);

  const recommendedGuid = results[0]?.guid;

  const act = async (result: TorrentResult, mode: TorrentAddMode) => {
    if (actingGuid) return;
    setActingGuid(result.guid);
    try {
      if (mode === "stream" && result.streamUrl) {
        openDirect({
          ...media,
          id: result.guid,
          url: result.streamUrl,
          title: media?.title ?? shortTitle(result),
          subtitle: media?.subtitle,
          posterUrl: media?.posterUrl,
          isEpisode: media?.isEpisode,
          season: media?.season,
          episode: media?.episode,
        });
        toast.success("Direct stream ready", {
          description: "Using the hosted/debrid link. No peer discovery or torrent buffer.",
        });
        onClose();
        navigate("/stream");
        return;
      }
      if (mode === "stream") {
        await addTorrent(result, "stream", [], media);
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
      toast.error(t("common.error"), {
        description: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      setActingGuid(null);
    }
  };

  const copyMagnet = (result: TorrentResult) => {
    if (!result.magnetUrl) return;
    navigator.clipboard.writeText(result.magnetUrl);
    toast.success("Magnet copied");
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-md"
          onClick={onClose}
        >
          <motion.section
            initial={{ opacity: 0, scale: 0.97, y: 24 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 12 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            onClick={(event) => event.stopPropagation()}
            className="glass-panel flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-[30px] shadow-[0_30px_120px_rgba(0,0,0,.8)]"
          >
            <header className="relative shrink-0 overflow-hidden border-b border-white/[0.07] px-5 pb-4 pt-5 md:px-6">
              <div className="pointer-events-none absolute -right-20 -top-28 h-64 w-64 rounded-full bg-brand/10 blur-[90px]" />
              <div className="relative flex items-start gap-4">
                <Artwork
                  src={media?.posterUrl}
                  title={media?.title ?? initialQuery}
                  variant="poster"
                  className="h-[76px] w-[52px] shrink-0 rounded-xl object-cover shadow-xl ring-1 ring-white/10"
                />
                <div className="min-w-0 flex-1 pt-0.5">
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-brand/10 px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.18em] text-brand-light ring-1 ring-brand/20">
                      Manual source
                    </span>
                    {!loading && results.length > 0 && (
                      <span className="text-[10px] text-zinc-600">{results.length} available</span>
                    )}
                  </div>
                  <h2 className="mt-2 truncate text-xl font-bold tracking-tight">
                    Choose a stream for {media?.title ?? initialQuery}
                  </h2>
                  <p className="mt-1 truncate text-xs text-zinc-500">{media?.subtitle ?? initialQuery}</p>
                </div>
                <button
                  onClick={onClose}
                  aria-label="Close source picker"
                  className="rounded-xl p-2 text-zinc-500 transition hover:bg-white/10 hover:text-white"
                >
                  <X size={20} />
                </button>
              </div>

              <div className="relative mt-4 flex items-start gap-3 rounded-2xl border border-brand/20 bg-brand/[0.055] px-4 py-3">
                <ShieldCheck size={17} className="mt-0.5 shrink-0 text-brand-light" />
                <div>
                  <p className="text-xs font-semibold text-zinc-100">Your choice stays selected</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                    Unlike Watch Now, manual mode does not race or replace your source. Compare audio, picture, size and peer health below.
                  </p>
                </div>
              </div>

              <form
                className="relative mt-4 flex flex-col gap-2 md:flex-row"
                onSubmit={(event) => {
                  event.preventDefault();
                  runSearch(query);
                }}
              >
                <label className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-white/10 bg-black/25 px-3 focus-within:border-brand/60">
                  <Search size={15} className="shrink-0 text-zinc-600" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search sources"
                    className="w-full bg-transparent py-2.5 text-sm outline-none placeholder:text-zinc-700"
                  />
                </label>
                <div className="flex overflow-x-auto rounded-xl border border-white/10 bg-black/25 p-1">
                  {(
                    [
                      ["recommended", "Best"],
                      ["quality", "Quality"],
                      ["seeders", "Peers"],
                      ["smallest", "Smallest"],
                    ] as [SortMode, string][]
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setSortMode(mode)}
                      className={`rounded-lg px-3 py-1.5 text-[11px] font-semibold transition ${
                        sortMode === mode
                          ? "bg-white text-black"
                          : "text-zinc-500 hover:text-white"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </form>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto p-3 md:p-4">
              {loading && <Spinner label="Finding healthy sources…" />}
              {error && (
                <div className="m-2 rounded-xl border border-red-500/20 bg-red-500/[0.06] p-4 text-sm text-red-300">
                  {error}
                </div>
              )}
              {!loading && !error && !sorted.length && (
                <div className="py-16 text-center text-sm text-zinc-500">No playable sources found.</div>
              )}

              <div className="space-y-2">
                {sorted.map((result, index) => {
                  const facts = sourceFacts(result);
                  const recommended = result.guid === recommendedGuid;
                  const acting = actingGuid === result.guid;
                  const added = addedGuid === result.guid;

                  return (
                    <motion.article
                      key={result.guid}
                      title={shortTitle(result)}
                      className={`relative overflow-hidden rounded-2xl border p-4 transition ${
                        recommended
                          ? "border-brand/30 bg-gradient-to-r from-brand/[0.08] to-white/[0.025]"
                          : "border-white/[0.07] bg-white/[0.025] hover:border-white/15 hover:bg-white/[0.045]"
                      }`}
                    >
                      {recommended && (
                        <div className="absolute right-0 top-0 rounded-bl-xl bg-brand px-3 py-1 text-[9px] font-bold uppercase tracking-[0.16em] text-white">
                          <span className="flex items-center gap-1"><Sparkles size={10} /> Auto pick</span>
                        </div>
                      )}

                      <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2 pr-24 text-[9px] font-bold uppercase tracking-[0.18em] text-zinc-600">
                            <span>Source {String(index + 1).padStart(2, "0")}</span>
                            <span className="h-1 w-1 rounded-full bg-zinc-700" />
                            <span className="normal-case tracking-normal text-zinc-500">{result.indexer}</span>
                          </div>
                          <h3 className="mt-1.5 text-lg font-bold tracking-tight text-zinc-100">
                            {facts.displayName}
                          </h3>
                          <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[10px]">
                            <span className="rounded-md bg-white/[0.05] px-2 py-1 text-zinc-400">
                              {facts.codec}
                            </span>
                            <span className="rounded-md bg-white/[0.05] px-2 py-1 text-zinc-400">
                              {facts.container}
                            </span>
                            <span className={`flex items-center gap-1 rounded-md px-2 py-1 font-medium ${facts.language.className}`}>
                              <Languages size={11} /> {facts.language.label}
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
                              <span className="flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-1 font-semibold text-emerald-400">
                                <ShieldCheck size={11} /> {facts.hosted ? "Hosted link" : "Direct play"}
                              </span>
                            )}
                          </div>
                          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
                            <span className="flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-black/20 px-2.5 py-1.5 text-zinc-400">
                              <HardDrive size={12} className="text-zinc-600" />
                              <strong className="font-semibold text-zinc-200">{result.size ? formatBytes(result.size) : "Hosted"}</strong>
                              <span>size</span>
                            </span>
                            {!facts.hosted && (
                              <span className="flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-black/20 px-2.5 py-1.5 text-zinc-400">
                                <Users size={12} className="text-zinc-600" />
                                <strong className="font-semibold text-zinc-200">{result.seeders.toLocaleString()}</strong>
                                <span>seeders</span>
                              </span>
                            )}
                            <span className={`flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-black/20 px-2.5 py-1.5 ${facts.health.color}`}>
                              <Gauge size={12} /> {facts.health.label} health
                            </span>
                          </div>
                        </div>

                        <div className="flex shrink-0 items-stretch gap-2">
                          {added ? (
                            <div className="flex min-w-32 items-center justify-center gap-2 rounded-xl bg-emerald-500/10 px-4 py-2 text-xs font-semibold text-emerald-400">
                              <Check size={15} /> Added
                            </div>
                          ) : (
                            <>
                              <button
                                onClick={() => act(result, "stream")}
                                disabled={!!actingGuid}
                                className="group/stream flex min-w-32 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand-light to-brand px-4 py-2.5 text-xs font-bold text-[#090806] shadow-[0_10px_28px_rgba(152,117,47,.16)] transition hover:scale-[1.02] hover:brightness-110 disabled:opacity-50"
                              >
                                {acting ? <LoaderCircle size={15} className="animate-spin" /> : <Wifi size={15} />}
                                {acting ? "Starting…" : "Watch this"}
                              </button>
                              {!result.streamUrl && (
                                <button
                                  onClick={() => act(result, "download")}
                                  disabled={!!actingGuid}
                                  title="Download and keep offline"
                                  className="flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.06] px-3.5 py-2.5 text-xs font-semibold transition hover:bg-white/10 disabled:opacity-50"
                                >
                                  <Download size={15} /> Save
                                </button>
                              )}
                            </>
                          )}
                          {result.magnetUrl && (
                            <button
                              onClick={() => copyMagnet(result)}
                              title="Copy magnet"
                              className="rounded-xl border border-white/[0.07] p-2.5 text-zinc-500 transition hover:bg-white/10 hover:text-white"
                            >
                              <Copy size={15} />
                            </button>
                          )}
                        </div>
                      </div>
                    </motion.article>
                  );
                })}
              </div>
            </div>

            <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-white/[0.07] bg-black/20 px-5 py-3 text-[10px] text-zinc-600">
              <span>⚖️ {t("torrent.disclaimer")}</span>
              <span className="hidden items-center gap-1 md:flex"><Radio size={11} /> Powered by Torrentio + your local stream engine</span>
            </footer>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
