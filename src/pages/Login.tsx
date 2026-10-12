/**
 * Login — Netflix-style "Who's watching?" profile picker over saved
 * Jellyfin sessions, plus a form to sign in to a new server/user.
 * Supports any number of servers.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import { useAuth } from "@/stores/authStore";
import { useT } from "@/i18n";
import type { ServerProfile } from "@/types/jellyfin";
import Brand from "@/components/Brand";

/** Deterministic monochrome avatar per user: tone and angle vary by name. */
function avatarGradient(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  const light = 30 + (h % 5) * 4;
  return `linear-gradient(${90 + (h % 8) * 22}deg, hsl(0 0% ${light}%), hsl(0 0% ${light - 18}%))`;
}

/** Jellyfin profile picture, when the user has one. */
const avatarUrl = (p: ServerProfile) =>
  p.userImageTag
    ? `${p.serverUrl}/Users/${p.userId}/Images/Primary?tag=${p.userImageTag}&maxWidth=192&quality=90`
    : null;

export default function Login() {
  const t = useT();
  const navigate = useNavigate();
  const { profiles, login, switchProfile, removeProfile } = useAuth();

  const [showForm, setShowForm] = useState(profiles.length === 0);
  const [serverUrl, setServerUrl] = useState("http://localhost:8096");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(serverUrl, username, password);
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-surface px-4">
      <div className="pointer-events-none absolute -left-40 -top-44 h-[560px] w-[560px] rounded-full bg-white/[0.06] blur-[150px]" />
      <motion.div
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-12 text-white"
      >
        <Brand height={30} />
      </motion.div>

      {/* Profile picker */}
      {!showForm && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center">
          <p className="ak-eyebrow mb-3">Your space</p>
          <h2 className="mb-9 font-display text-4xl tracking-[-0.02em] text-white">
            {t("login.whosWatching")}
          </h2>
          <div className="flex flex-wrap items-start justify-center gap-6">
            {profiles.map((p, i) => {
              const img = avatarUrl(p);
              return (
                <motion.div
                  key={p.id}
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.06, duration: 0.35, ease: "easeOut" }}
                  className="relative w-28"
                >
                  <motion.button
                    whileHover={editMode ? undefined : { scale: 1.06 }}
                    onClick={() => {
                      if (editMode) return;
                      switchProfile(p.id);
                      navigate("/");
                    }}
                    className="group w-full"
                  >
                    <div
                      className={`mx-auto flex h-24 w-24 items-center justify-center overflow-hidden rounded-[28px] text-4xl font-bold uppercase text-white shadow-2xl transition group-hover:-translate-y-1 group-hover:ring-2 group-hover:ring-white group-focus-visible:ring-2 group-focus-visible:ring-white ${
                        editMode ? "opacity-60 saturate-0" : ""
                      }`}
                      style={img ? undefined : { background: avatarGradient(p.userName) }}
                    >
                      {img ? (
                        <img src={img} alt="" className="h-full w-full object-cover" />
                      ) : (
                        p.userName[0]
                      )}
                    </div>
                    <p className="mt-2 truncate text-sm text-zinc-300 group-hover:text-white">
                      {p.userName}
                    </p>
                    <p className="truncate text-xs text-zinc-500">
                      {p.serverName ?? p.serverUrl}
                    </p>
                  </motion.button>
                  {editMode && (
                    <button
                      onClick={() => removeProfile(p.id)}
                      aria-label={`Remove ${p.userName}`}
                      className="absolute -right-1 -top-1 rounded-full border-2 border-black bg-white p-1.5 text-black hover:bg-zinc-200"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </motion.div>
              );
            })}

            {/* Add server tile */}
            <motion.button
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: profiles.length * 0.06, duration: 0.35 }}
              onClick={() => setShowForm(true)}
              className="group w-28"
            >
              <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-[28px] border border-dashed border-white/25 bg-white/[0.025] text-zinc-400 transition group-hover:-translate-y-1 group-hover:border-white/70 group-hover:text-white">
                <Plus size={32} />
              </div>
              <p className="mt-2 text-sm text-zinc-400 group-hover:text-white">
                {t("login.addServer")}
              </p>
            </motion.button>
          </div>

          {profiles.length > 0 && (
            <button
              onClick={() => setEditMode((m) => !m)}
              className="mt-10 rounded-full border border-white/20 px-5 py-2 text-sm text-zinc-300 hover:bg-white/[0.08] hover:text-white"
            >
              {editMode ? "Done" : "Manage profiles"}
            </button>
          )}
        </motion.div>
      )}

      {/* New-server login form */}
      {showForm && (
        <motion.form
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          onSubmit={submit}
          className="glass-panel w-full max-w-md rounded-[28px] p-8"
        >
          <h2 className="mb-6 text-xl font-semibold">{t("login.title")}</h2>

          <label htmlFor="login-server" className="mb-1 block text-xs text-zinc-300">{t("login.server")}</label>
          <input
            id="login-server"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="http://localhost:8096"
            required
            className="mb-4 w-full rounded-xl border border-white/15 bg-black/40 px-4 py-3 text-sm outline-none transition focus:border-white/70"
          />

          <label htmlFor="login-username" className="mb-1 block text-xs text-zinc-300">{t("login.username")}</label>
          <input
            id="login-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            className="mb-4 w-full rounded-xl border border-white/15 bg-black/40 px-4 py-3 text-sm outline-none transition focus:border-white/70"
          />

          <label htmlFor="login-password" className="mb-1 block text-xs text-zinc-300">{t("login.password")}</label>
          <input
            type="password"
            id="login-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className="mb-6 w-full rounded-xl border border-white/15 bg-black/40 px-4 py-3 text-sm outline-none transition focus:border-white/70"
          />

          {error && (
            <p role="alert" className="ak-notice ak-notice--error mb-4 whitespace-pre-wrap text-xs">
              <AlertTriangle size={15} aria-hidden="true" /> <span className="min-w-0 break-words">{error}</span>
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-full bg-white py-3 font-bold text-black transition hover:bg-zinc-200 disabled:opacity-50"
          >
            {busy ? "Signing in…" : t("login.signIn")}
          </button>

          {profiles.length > 0 && (
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="mt-4 w-full text-center text-sm text-zinc-400 hover:text-white"
            >
              ← {t("login.whosWatching")}
            </button>
          )}
        </motion.form>
      )}
    </div>
  );
}
