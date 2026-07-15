/**
 * Settings — Jellyfin servers, qBittorrent, Prowlarr, download path,
 * language. Each service section has a live "Test connection" button.
 */

import { useState } from "react";
import { motion } from "framer-motion";
import { CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import { toast } from "sonner";
import { useSettings } from "@/stores/settingsStore";
import { useAuth } from "@/stores/authStore";
import { useTorrents } from "@/stores/torrentStore";
import { JellyfinClient } from "@/api/jellyfin";
import { isTauri } from "@/lib/http";
import { checkForUpdates, installUpdate } from "@/lib/desktop";
import { useT } from "@/i18n";
import { isAppleMobile } from "@/lib/platform";

const APP_VERSION = "1.0.6"; // keep in sync with package.json / tauri.conf.json

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
  const mobileApple = isAppleMobile();
  const settings = useSettings();
  const profiles = useAuth((s) => s.profiles);
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

  const set = <K extends keyof typeof draft>(k: K, v: (typeof draft)[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const save = () => {
    settings.update(draft);
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
      draft.torrentSource === "torrentio"
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

  return (
    <motion.main
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="mx-auto min-h-screen max-w-3xl px-6 pb-24 pt-28"
    >
      <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.22em] text-accent">Tune your space</p>
      <h1 className="mb-9 text-4xl font-black tracking-[-0.04em]">{t("settings.title")}</h1>

      {/* ── Jellyfin servers (read-only list; add/remove via login screen) ── */}
      <section className="glass-panel mb-6 rounded-3xl p-6">
        <h2 className="mb-4 font-semibold">{t("settings.jellyfin")}</h2>
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
      <section className="glass-panel mb-6 rounded-3xl p-6">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold">{t("settings.torrentClient")}</h2>
          <TestBadge state={qbtTest} />
        </div>

        {mobileApple ? (
          <p className="mt-3 text-xs leading-relaxed text-zinc-500">
            iPhone and iPad use hosted/debrid links or a connected Jellyfin library.
            The private peer engine and offline torrent manager are desktop-only.
          </p>
        ) : (
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
              <p className="mt-3 text-xs leading-relaxed text-zinc-500">
                Ready automatically. Akflix manages its own temporary streams and offline media on this device.
              </p>
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
        )}
      </section>

      {/* ── Torrent metadata source ── */}
      <section className="glass-panel mb-6 rounded-3xl p-6">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold">{t("settings.indexer")}</h2>
          <TestBadge state={prowlarrTest} />
        </div>

        <label className={labelCls}>Provider</label>
        <select
          value={draft.torrentSource}
          onChange={(e) =>
            set("torrentSource", e.target.value as typeof draft.torrentSource)
          }
          className={inputCls}
        >
          <option value="torrentio">Torrentio</option>
          <option value="prowlarr">Prowlarr</option>
        </select>

        {draft.torrentSource === "torrentio" ? (
          <>
            <label className={labelCls}>Configured manifest URL</label>
            <input
              value={draft.torrentioManifestUrl}
              onChange={(e) => set("torrentioManifestUrl", e.target.value)}
              placeholder="https://torrentio.strem.fun/manifest.json"
              className={inputCls}
            />
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
              Paste Torrentio’s configured manifest link here. A debrid provider is
              optional, but cached hosted links give the closest thing to instant playback.
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
      </section>

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
