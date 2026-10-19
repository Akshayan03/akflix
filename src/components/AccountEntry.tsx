import { Cloud, CloudOff } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { cloudStatusLine, useCloud } from "@/lib/cloud/engine";

/** Settings panel that opens the Akflix account screen and shows sync health. */
export default function AccountEntry() {
  const navigate = useNavigate();
  const status = useCloud();
  const detail = status.user
    ? `${cloudStatusLine(status)}${status.user.email ? ` · ${status.user.email}` : ""}`
    : "Sign in with Apple, Google or email to keep your Mac, iPhone and Roku where you left off";
  const Icon = status.user && status.phase !== "error" && status.phase !== "offline" ? Cloud : CloudOff;

  return (
    <section className="glass-panel mb-6 flex flex-wrap items-center gap-4 rounded-3xl p-6">
      <span
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${
          status.user ? "bg-white text-black" : "bg-white/[0.08] text-white"
        }`}
        aria-hidden="true"
      >
        <Icon size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="font-semibold">Akflix account</h2>
        <p className="mt-0.5 truncate text-xs text-zinc-400">{detail}</p>
      </div>
      <button
        type="button"
        onClick={() => navigate("/account")}
        className={`desktop-control ${status.user ? "desktop-secondary" : "desktop-primary"}`}
      >
        {status.user ? "Manage" : "Sign in"}
      </button>
    </section>
  );
}
