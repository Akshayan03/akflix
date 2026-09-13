import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Check, HardDrive, LoaderCircle, Play, RotateCcw } from "lucide-react";
import Brand from "@/components/Brand";
import {
  getEmbeddedEngineStatus,
  getMediaStorageStatus,
  requireMediaStorage,
  resetMediaStorage,
} from "@/lib/mediaStorage";

const READY_KEY = "akflix.first-run-ready.v1";

type ReadinessPhase = "checking" | "engine" | "ready" | "action";

function readinessCopy(phase: ReadinessPhase) {
  switch (phase) {
    case "checking":
      return "Checking your private media space";
    case "engine":
      return "Starting the built-in playback engine";
    case "ready":
      return "Akflix is ready";
    case "action":
      return "Akflix needs a quick fix";
  }
}

/**
 * A first-launch gate that turns native setup into an automatic readiness
 * check. It stays out of the way on healthy repeat launches and only asks for
 * input when a selected drive is unavailable or a bundled tool cannot start.
 */
export default function StartupExperience() {
  const firstLaunch = useRef(localStorage.getItem(READY_KEY) !== "yes");
  const mounted = useRef(true);
  const [visible, setVisible] = useState(firstLaunch.current);
  const [phase, setPhase] = useState<ReadinessPhase>("checking");
  const [detail, setDetail] = useState("No account or server setup required");
  const [busy, setBusy] = useState(false);
  const [completedSteps, setCompletedSteps] = useState(0);

  useEffect(() => () => {
    mounted.current = false;
  }, []);

  const finish = useCallback(() => {
    if (!mounted.current) return;
    localStorage.setItem(READY_KEY, "yes");
    setCompletedSteps(3);
    setPhase("ready");
    setDetail("Opening your home screen");
    window.setTimeout(() => {
      if (mounted.current) setVisible(false);
    }, firstLaunch.current ? 850 : 350);
  }, []);

  const check = useCallback(async () => {
    setBusy(true);
    setPhase("checking");
    setCompletedSteps(0);
    setDetail("No account or server setup required");
    const delayedReveal = window.setTimeout(() => {
      if (mounted.current) setVisible(true);
    }, firstLaunch.current ? 0 : 550);

    try {
      const storage = await getMediaStorageStatus();
      if (!storage) {
        finish();
        return;
      }
      if (storage.restartRequired) {
        throw new Error("Restart Akflix to finish using your newly selected media location.");
      }
      if (!storage.activeAvailable || !storage.writable) {
        const name = storage.volumeName ?? "Your selected media drive";
        throw new Error(`${name} is disconnected or read-only. Reconnect it, or switch back to this Mac.`);
      }
      setCompletedSteps(1);

      if (!storage.engineRunning) {
        setPhase("engine");
        setDetail("This normally takes only a few seconds");
        await requireMediaStorage();
      }

      const engine = await getEmbeddedEngineStatus();
      if (engine && !engine.ffmpeg) {
        throw new Error("The bundled compatibility player is missing. Reinstall the latest Akflix download.");
      }
      if (engine && !engine.captionModel) {
        throw new Error("The bundled caption model is missing. Reinstall the latest Akflix download.");
      }
      if (engine && !engine.torrentEngine) {
        throw new Error("The playback engine did not become ready. Try again in a moment.");
      }
      setCompletedSteps(2);
      finish();
    } catch (reason) {
      if (!mounted.current) return;
      setVisible(true);
      setPhase("action");
      setDetail(reason instanceof Error ? reason.message : String(reason));
    } finally {
      window.clearTimeout(delayedReveal);
      if (mounted.current) setBusy(false);
    }
  }, [finish]);

  useEffect(() => {
    void check();
  }, [check]);

  const useMacStorage = async () => {
    setBusy(true);
    setPhase("checking");
    setDetail("Switching to private storage on this Mac");
    try {
      const status = await resetMediaStorage();
      if (status.restartRequired) {
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
        return;
      }
      await check();
    } catch (reason) {
      setPhase("action");
      setDetail(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  if (!visible) return null;

  const ready = phase === "ready";
  const action = phase === "action";

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[#090806]/95 px-6 backdrop-blur-2xl"
    >
      <div className="pointer-events-none absolute left-[12%] top-[8%] h-72 w-72 rounded-full bg-brand/10 blur-[110px]" />
      <motion.section
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 28 }}
        className="relative w-full max-w-md text-center"
      >
        <div className="mb-10 flex justify-center"><Brand /></div>
        <div className="glass-panel rounded-[30px] p-8 shadow-[0_30px_100px_rgba(0,0,0,.6)]">
          <motion.div
            key={phase}
            initial={{ opacity: 0, scale: 0.82 }}
            animate={{ opacity: 1, scale: 1 }}
            className={`mx-auto flex h-16 w-16 items-center justify-center rounded-2xl ${
              ready ? "bg-emerald-500/15 text-emerald-300" : action ? "bg-amber-500/15 text-amber-200" : "bg-brand/15 text-brand-light"
            }`}
          >
            {ready ? <Check size={30} /> : action ? <HardDrive size={28} /> : <LoaderCircle size={30} className="animate-spin" />}
          </motion.div>
          <h1 className="mt-6 text-2xl font-black tracking-[-0.035em]">{readinessCopy(phase)}</h1>
          <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-zinc-400">{detail}</p>

          <div className="mt-7 grid grid-cols-3 gap-2 text-[10px] font-semibold text-zinc-500">
            {["Storage", "Player", "Browse"].map((label, index) => {
              const complete = completedSteps > index;
              return (
              <div key={label} className={`rounded-xl border px-2 py-2.5 ${complete ? "border-emerald-500/15 bg-emerald-500/[0.07] text-emerald-300" : "border-white/[0.07] bg-white/[0.025]"}`}>
                {complete ? <Check size={12} className="mx-auto mb-1" /> : <span className="mx-auto mb-1 block h-3 w-3 rounded-full border border-current" />}
                {label}
              </div>
              );
            })}
          </div>

          {action && (
            <div className="mt-7 grid gap-2 sm:grid-cols-2">
              <button
                onClick={() => void check()}
                disabled={busy}
                className="flex h-11 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.05] text-sm font-semibold transition hover:bg-white/[0.09] disabled:opacity-50"
              >
                <RotateCcw size={15} /> Try again
              </button>
              <button
                onClick={() => void useMacStorage()}
                disabled={busy}
                className="flex h-11 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand-light to-brand text-sm font-black text-[#090806] disabled:opacity-50"
              >
                <Play size={15} fill="currentColor" /> Use this Mac
              </button>
            </div>
          )}
        </div>
        <p className="mt-5 text-[11px] text-zinc-600">Jellyfin and external playback tools remain optional in Settings.</p>
      </motion.section>
    </motion.div>
  );
}
