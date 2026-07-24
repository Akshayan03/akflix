/**
 * Settings — Jellyfin servers, qBittorrent, Prowlarr, download path,
 * language. Each service section has a live "Test connection" button.
 */

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  CheckCircle2,
  ExternalLink,
  FolderOpen,
  HardDrive,
  RefreshCw,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useLocation } from "react-router-dom";
import { toast } from "sonner";
import { useSettings } from "@/stores/settingsStore";
import { useAuth } from "@/stores/authStore";
import { useTorrents } from "@/stores/torrentStore";
import { JellyfinClient } from "@/api/jellyfin";
import { isTauri } from "@/lib/http";
import { checkForUpdates, installUpdate } from "@/lib/desktop";
import { useT } from "@/i18n";
import { isAppleMobile } from "@/lib/platform";
import {
  configureMediaStorage,
  getMediaStorageStatus,
  resetMediaStorage,
  type MediaStorageStatus,
} from "@/lib/mediaStorage";
import { formatBytes } from "@/lib/utils";

const APP_VERSION = "1.0.11"; // keep in sync with package.json / tauri.conf.json

type TestState = "idle" | "busy" | "ok" | "fail";

function TestBadge({ state }: { state: TestState }) {
  if (state === "ok") return <CheckCircle2 size={16} className="text-green-400" />;
  if (state === "fail") return <XCircle size={16} className="text-red-400" />;
  if (state === "busy")
    return <span className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-white" />;
  return null;
}

const inputCls =
  "w-full rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-sm outline-none transition focus:border-brand/60";
const labelCls = "mb-1 mt-4 block text-xs text-zinc-400";

export default function Settings() {
  const t = useT();
  const location = useLocation();
  const mobileApple = isAppleMobile();
  const settings = useSettings();
  const profiles = useAuth((s) => s.profiles);
  const activeProfileId = useAuth((s) => s.activeProfileId);
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId);
  const { qbt, prowlarr, torrentio } = useTorrents();

  // Local draft so typing doesn't thrash the persisted store.
  const [draft, setDraft] = useState({
    torrentEngine: settings.torrentEngine,
    qbtUrl: settings.qbtUrl,
    qbtUsername: settings.qbtUsername,
    qbtPassword: settings.qbtPassword,
    prowlarrUrl: settings.prowlarrUrl,
    prowlarrApiKey: settings.prowlarrApiKey,
    torrentSource: settings.torrentSource,
    torrentioManifestUrl: settings.torrentioManifestUrl,
    downloadPath: settings.downloadPath,
    language: settings.language,
    subtitleLanguage: settings.subtitleLanguage,
    audioLanguage: settings.audioLanguage,
  });
  const [saved, setSaved] = useState(false);
  const [qbtTest, setQbtTest] = useState<TestState>("idle");
  const [prowlarrTest, setProwlarrTest] = useState<TestState>("idle");
  const [jfTests, setJfTests] = useState<Record<string, TestState>>({});
  const [storageStatus, setStorageStatus] = useState<MediaStorageStatus | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);

  useEffect(() => {
    if (!mobileApple || location.hash !== "#hosted-streaming") return;
    const timer = setTimeout(() => {
      document.getElementById("hosted-streaming")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [location.hash, mobileApple]);

  useEffect(() => {
    if (mobileApple || !isTauri()) return;
    void getMediaStorageStatus()
      .then(setStorageStatus)
      .catch((reason) => {
        toast.error("Could not inspect media storage", {
          description: reason instanceof Error ? reason.message : String(reason),
        });
      });
  }, [mobileApple]);

  const set = <K extends keyof typeof draft>(k: K, v: (typeof draft)[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const save = () => {
    settings.update(mobileApple ? { ...draft, torrentSource: "torrentio" } : draft);
    setSaved(true);
    toast.success(t("settings.saved"));
    setTimeout(() => setSaved(false), 2000);
  };

  const [updateBusy, setUpdateBusy] = useState(false);
  const checkUpdates = async () => {
    setUpdateBusy(true);
    try {
      const status = await checkForUpdates();
      if (status.available) {
        toast("Update available", {
          description: `Akflix ${status.version}`,
          action: {
            label: "Install",
            onClick: () =>
              toast.promise(installUpdate(), {
                loading: "Downloading update…",
                success: "Restarting…",
                error: "Update failed",
              }),
          },
        });
      } else {
        toast.success("You're up to date", { description: `Akflix ${APP_VERSION}` });
      }
    } catch (e) {
      toast.error("Update check failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setUpdateBusy(false);
    }
  };

  const testQbt = async () => {
    save();
    setQbtTest("busy");
    setQbtTest((await qbt().test()) ? "ok" : "fail");
  };

  const testIndexer = async () => {
    save();
    setProwlarrTest("busy");
    const ok =
      (mobileApple || draft.torrentSource === "torrentio")
        ? await torrentio().test()
        : await prowlarr().test();
    setProwlarrTest(ok ? "ok" : "fail");
  };

  const testJellyfin = async (id: string, url: string) => {
    setJfTests((s) => ({ ...s, [id]: "busy" }));
    try {
      await JellyfinClient.pingServer(url);
      setJfTests((s) => ({ ...s, [id]: "ok" }));
    } catch {
      setJfTests((s) => ({ ...s, [id]: "fail" }));
    }
  };

  const configureTorrentio = async () => {
    try {
      await openUrl("https://torrentio.strem.fun/configure");
    } catch (reason) {
      toast.error("Could not open Torrentio", {
        description: reason instanceof Error ? reason.message : String(reason),
      });
    }
  };

  const chooseMediaStorage = async () => {
    if (storageBusy) return;
    setStorageBusy(true);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const choice = await open({
        directory: true,
        multiple: false,
        title: "Choose a drive or folder for Akflix media",
      });
      const selected = Array.isArray(choice) ? choice[0] : choice;
      if (!selected) return;
      const next = await configureMediaStorage(selected);
      setStorageStatus(next);
      toast.success("Media drive selected", {
        description: "Restart Akflix to move all new streaming work to this location.",
      });
    } catch (reason) {
      toast.error("Could not use this location", {
        description: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      setStorageBusy(false);
    }
  };

  const useMacStorage = async () => {
    if (storageBusy) return;
    setStorageBusy(true);
    try {
      const next = await resetMediaStorage();
      setStorageStatus(next);
      toast.success("Mac storage selected", {
        description: "Restart Akflix to apply the change.",
      });
    } catch (reason) {
      toast.error("Could not reset media storage", {
        description: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      setStorageBusy(false);
    }
  };

  const restartForStorage = async () => {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  };

  return (
    <motion.main
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="mx-auto min-h-screen max-w-3xl px-4 pb-32 pt-32 sm:px-6 sm:pb-24 sm:pt-28"
    >
      <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.22em] text-accent">Tune your space</p>
      <h1 className="mb-9 text-4xl font-black tracking-[-0.04em]">{t("settings.title")}</h1>

      {mobileApple && (
        <motion.section
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6 flex items-center gap-4 rounded-[28px] border border-white/[0.08] bg-gradient-to-br from-brand/[0.12] to-white/[0.025] p-4 shadow-[0_18px_50px_rgba(0,0,0,.22)]"
        >
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[20px] bg-gradient-to-br from-brand-light to-brand text-xl font-black uppercase text-[#090806] shadow-[0_12px_30px_rgba(214,178,94,.2)]">
            {activeProfile?.userName?.[0] ?? "A"}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-black tracking-tight">{activeProfile?.userName ?? "Akflix"}</p>
            <p className="mt-0.5 text-xs text-zinc-500">
              {activeProfile?.kind === "local" ? "Local profile on this iPhone" : activeProfile?.serverName ?? "Jellyfin profile"}
            </p>
          </div>
          <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-[9px] font-bold uppercase tracking-wider text-emerald-400">
            Active
          </span>
        </motion.section>
      )}

      {mobileApple && (
        <motion.section
          id="hosted-streaming"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="glass-panel mb-6 scroll-mt-24 rounded-3xl border-brand/20 p-6"
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-accent">Direct playback</p>
              <h2 className="mt-1 text-lg font-black">Instant streaming</h2>
            </div>
            <TestBadge state={prowlarrTest} />
          </div>
          <p className="mt-3 text-xs leading-5 text-zinc-400">
            Akflix can play a hosted video URL directly. Jellyfin is optional and no local download is needed.
          </p>

          <div className="mt-5 rounded-2xl border border-white/[0.07] bg-black/20 p-4">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Step 1</p>
            <p className="mt-1 text-sm font-semibold">Configure Torrentio with a debrid provider</p>
            <p className="mt-1 text-[11px] leading-5 text-zinc-500">
              Selecting None returns peer links, which cannot play directly on iPhone.
            </p>
            <motion.button
              whileTap={{ scale: 0.96 }}
              type="button"
              onClick={() => void configureTorrentio()}
              className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-brand-light text-xs font-black text-[#090806]"
            >
              <ExternalLink size={15} /> Open Torrentio setup
            </motion.button>
          </div>

          <div className="mt-3 rounded-2xl border border-white/[0.07] bg-black/20 p-4">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">Step 2</p>
            <label className="mt-1 block text-sm font-semibold">Paste the configured manifest link</label>
            <input
              value={draft.torrentioManifestUrl}
              onChange={(event) => set("torrentioManifestUrl", event.target.value)}
              placeholder="https://torrentio.strem.fun/.../manifest.json"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              className={`${inputCls} mt-3 text-[12px]`}
            />
            <div className="mt-3 grid grid-cols-2 gap-2">
              <motion.button
                whileTap={{ scale: 0.96 }}
                type="button"
                onClick={save}
                className="h-11 rounded-xl border border-white/10 bg-white/[0.06] text-xs font-bold text-zinc-200"
              >
                {saved ? "Saved" : "Save link"}
              </motion.button>
              <motion.button
                whileTap={{ scale: 0.96 }}
                type="button"
                onClick={() => void testIndexer()}
                className="h-11 rounded-xl border border-brand/30 bg-brand/10 text-xs font-bold text-brand-light"
              >
                Test source
              </motion.button>
            </div>
          </div>
        </motion.section>
      )}

      {/* ── Jellyfin servers (read-only list; add/remove via login screen) ── */}
      <section className="glass-panel mb-6 rounded-3xl p-6">
        <h2 className="mb-1 font-semibold">{mobileApple ? "Personal library" : t("settings.jellyfin")}</h2>
        {mobileApple && <p className="mb-4 text-xs text-zinc-500">Optional Jellyfin connection</p>}
        {profiles.filter((profile) => profile.kind !== "local").length === 0 && (
          <p className="text-sm text-zinc-500">No servers. Sign in from the login screen.</p>
        )}
        <ul className="space-y-2">
          {profiles.filter((profile) => profile.kind !== "local").map((p) => (
            <li
              key={p.id}
              className="flex items-center gap-3 rounded bg-black/30 px-4 py-2.5 text-sm"
            >
              <span className="font-medium">{p.serverName ?? "Jellyfin"}</span>
              <span className="truncate text-zinc-500">{p.serverUrl}</span>
              <span className="text-zinc-600">· {p.userName}</span>
              <span className="ml-auto flex items-center gap-2">
                <TestBadge state={jfTests[p.id] ?? "idle"} />
                <button
                  onClick={() => testJellyfin(p.id, p.serverUrl)}
                  className="text-xs text-zinc-400 underline-offset-2 hover:text-white hover:underline"
                >
                  {t("settings.test")}
                </button>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* ── Playback engine ── */}
      {!mobileApple && <section className="glass-panel mb-6 rounded-3xl p-6">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold">{t("settings.torrentClient")}</h2>
          <TestBadge state={qbtTest} />
        </div>

          <>
            <label className={labelCls}>Engine</label>
            <select
              value={draft.torrentEngine}
              onChange={(event) => set("torrentEngine", event.target.value as typeof draft.torrentEngine)}
              className={inputCls}
            >
              <option value="embedded">Built into Akflix (recommended)</option>
              <option value="qbittorrent">External qBittorrent (advanced)</option>
            </select>

            {draft.torrentEngine === "embedded" ? (
              <>
                <p className="mt-3 text-xs leading-relaxed text-zinc-500">
                  Ready automatically. Akflix manages its own temporary streams and offline media on this device.
                </p>

                {storageStatus && (
                  <div className="mt-5 overflow-hidden rounded-2xl border border-white/[0.08] bg-black/20">
                    <div className="flex items-start gap-3 p-4">
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand/15 text-brand-light">
                        <HardDrive size={20} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold">
                            {storageStatus.volumeName ?? "Mac storage"}
                          </p>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                              storageStatus.restartRequired ||
                              (storageStatus.available && !storageStatus.engineRunning)
                                ? "bg-amber-500/10 text-amber-300"
                                : storageStatus.available && storageStatus.writable
                                  ? "bg-emerald-500/10 text-emerald-400"
                                  : "bg-red-500/10 text-red-400"
                            }`}
                          >
                            {storageStatus.restartRequired
                              ? "Restart required"
                              : storageStatus.available && !storageStatus.engineRunning
                                ? "Restart engine"
                              : storageStatus.available && storageStatus.writable
                                ? "Ready"
                                : "Disconnected"}
                          </span>
                        </div>
                        <p className="mt-1 break-all text-[11px] leading-5 text-zinc-500">
                          {storageStatus.path}
                        </p>
                        <p className="mt-1 text-[11px] text-zinc-400">
                          {storageStatus.freeBytes !== null
                            ? `${formatBytes(storageStatus.freeBytes)} free`
                            : "Free space unavailable"}
                          {storageStatus.usingExternal ? " on external storage" : " on this Mac"}
                        </p>
                      </div>
                    </div>

                    {!storageStatus.available && (
                      <div className="border-t border-red-500/10 bg-red-500/[0.05] px-4 py-3 text-[11px] leading-5 text-red-300">
                        Reconnect this drive before streaming. Akflix will not create a fallback cache on the internal disk.
                      </div>
                    )}

                    <div className="border-t border-white/[0.06] px-4 py-3">
                      <p className="mb-3 text-[11px] leading-5 text-zinc-500">
                        New temporary streams, offline downloads and compatibility files use this location. Existing saved files stay where they were created.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void chooseMediaStorage()}
                          disabled={storageBusy}
                          className="flex items-center gap-2 rounded-xl bg-brand-light px-3.5 py-2.5 text-xs font-bold text-[#090806] transition hover:brightness-105 disabled:opacity-50"
                        >
                          <FolderOpen size={14} /> {storageBusy ? "Checking..." : "Choose drive"}
                        </button>
                        {!storageStatus.usingDefault && (
                          <button
                            type="button"
                            onClick={() => void useMacStorage()}
                            disabled={storageBusy}
                            className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2.5 text-xs font-semibold text-zinc-300 transition hover:bg-white/[0.08] disabled:opacity-50"
                          >
                            <RotateCcw size={14} /> Use Mac storage
                          </button>
                        )}
                        {(storageStatus.restartRequired ||
                          (storageStatus.available && !storageStatus.engineRunning)) && (
                          <button
                            type="button"
                            onClick={() => void restartForStorage()}
                            className="flex items-center gap-2 rounded-xl border border-amber-400/25 bg-amber-400/10 px-3.5 py-2.5 text-xs font-bold text-amber-200 transition hover:bg-amber-400/15"
                          >
                            <RefreshCw size={14} /> Restart now
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                <label className={labelCls}>URL</label>
                <input
                  value={draft.qbtUrl}
                  onChange={(e) => set("qbtUrl", e.target.value)}
                  placeholder="http://localhost:8080"
                  className={inputCls}
                />
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={labelCls}>{t("login.username")}</label>
                    <input
                      value={draft.qbtUsername}
                      onChange={(e) => set("qbtUsername", e.target.value)}
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className={labelCls}>{t("login.password")}</label>
                    <input
                      type="password"
                      value={draft.qbtPassword}
                      onChange={(e) => set("qbtPassword", e.target.value)}
                      className={inputCls}
                    />
                  </div>
                </div>
                <label className={labelCls}>{t("settings.downloadPath")}</label>
                <input
                  value={draft.downloadPath}
                  onChange={(e) => set("downloadPath", e.target.value)}
                  placeholder="/downloads"
                  className={inputCls}
                />
              </>
            )}

            <button
              onClick={testQbt}
              className="mt-4 rounded bg-zinc-700 px-4 py-2 text-sm font-medium hover:bg-zinc-600"
            >
              {t("settings.test")}
            </button>
          </>
      </section>}

      {/* ── Torrent metadata source ── */}
      {!mobileApple && <section className="glass-panel mb-6 rounded-3xl p-6">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold">
            {mobileApple ? "Hosted streaming" : t("settings.indexer")}
          </h2>
          <TestBadge state={prowlarrTest} />
        </div>

        <label className={labelCls}>Provider</label>
        <select
          value={mobileApple ? "torrentio" : draft.torrentSource}
          onChange={(e) =>
            set("torrentSource", e.target.value as typeof draft.torrentSource)
          }
          className={inputCls}
        >
          <option value="torrentio">Torrentio</option>
          {!mobileApple && <option value="prowlarr">Prowlarr</option>}
        </select>

        {mobileApple || draft.torrentSource === "torrentio" ? (
          <>
            <label className={labelCls}>Configured manifest URL</label>
            <input
              value={draft.torrentioManifestUrl}
              onChange={(e) => set("torrentioManifestUrl", e.target.value)}
              placeholder="https://torrentio.strem.fun/manifest.json"
              className={inputCls}
            />
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
              {mobileApple
                ? "iPhone playback needs a Torrentio manifest with a debrid provider so the app receives hosted links. Jellyfin playback works separately."
                : "Paste Torrentio’s configured manifest link here. A debrid provider is optional, but cached hosted links give the closest thing to instant playback."}
            </p>
          </>
        ) : (
          <>
            <label className={labelCls}>URL</label>
            <input
              value={draft.prowlarrUrl}
              onChange={(e) => set("prowlarrUrl", e.target.value)}
              placeholder="http://localhost:9696"
              className={inputCls}
            />
            <label className={labelCls}>API Key</label>
            <input
              value={draft.prowlarrApiKey}
              onChange={(e) => set("prowlarrApiKey", e.target.value)}
              placeholder="Prowlarr → Settings → General → API Key"
              className={inputCls}
            />
          </>
        )}

        <button
          onClick={testIndexer}
          className="mt-4 rounded bg-zinc-700 px-4 py-2 text-sm font-medium hover:bg-zinc-600"
        >
          {t("settings.test")}
        </button>
      </section>}

      {/* ── Language ── */}
      <section className="mb-10 rounded-lg border border-zinc-800 bg-surface-raised p-6">
        <h2 className="font-semibold">{t("settings.language")}</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <label className={labelCls}>{t("settings.language")}</label>
            <select
              value={draft.language}
              onChange={(e) => set("language", e.target.value as typeof draft.language)}
              className={inputCls}
            >
              <option value="en">English</option>
              <option value="es">Español</option>
              <option value="fr">Français</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>{t("settings.subtitleLang")}</label>
            <input
              value={draft.subtitleLanguage}
              onChange={(e) => set("subtitleLanguage", e.target.value)}
              placeholder="eng / spa / fra (ISO 639-2)"
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>{t("settings.audioLang")}</label>
            <input
              value={draft.audioLanguage}
              onChange={(e) => set("audioLanguage", e.target.value)}
              placeholder="eng (ISO 639-2)"
              className={inputCls}
            />
          </div>
        </div>
      </section>

      {/* ── About & updates ── */}
      <section className="mb-10 rounded-lg border border-zinc-800 bg-surface-raised p-6">
        <h2 className="mb-2 font-semibold">About</h2>
        <p className="text-sm text-zinc-500">
          Akflix v{APP_VERSION} ·{" "}
          <a
            href="https://github.com/Akshayan03/akflix"
            target="_blank"
            rel="noreferrer"
            className="underline-offset-2 hover:text-white hover:underline"
          >
            GitHub
          </a>
        </p>
        {isTauri() && !mobileApple && (
          <button
            onClick={checkUpdates}
            disabled={updateBusy}
            className="mt-4 flex items-center gap-2 rounded bg-zinc-700 px-4 py-2 text-sm font-medium hover:bg-zinc-600 disabled:opacity-50"
          >
            <RefreshCw size={14} className={updateBusy ? "animate-spin" : ""} />
            Check for updates
          </button>
        )}
      </section>

      <button
        onClick={save}
        className="rounded bg-brand px-8 py-2.5 font-semibold hover:bg-brand-light"
      >
        {saved ? t("settings.saved") + " ✓" : t("settings.save")}
      </button>
    </motion.main>
  );
}
