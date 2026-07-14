/**
 * Login — Netflix-style "Who's watching?" profile picker over saved
 * Jellyfin sessions, plus a form to sign in to a new server/user.
 * Supports any number of servers.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Plus, Trash2 } from "lucide-react";
import { useAuth } from "@/stores/authStore";
import { useT } from "@/i18n";
import type { ServerProfile } from "@/types/jellyfin";

/** Deterministic avatar gradient per user, so profiles are recognizable. */
function avatarGradient(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `linear-gradient(135deg, hsl(${h} 72% 42%), hsl(${(h + 45) % 360} 72% 26%))`;
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
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-black via-surface to-black px-4">
      <motion.h1
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-10 text-5xl font-extrabold tracking-tight text-brand"
      >
        AKFLIX
      </motion.h1>

      {/* Profile picker */}
      {!showForm && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center">
          <h2 className="mb-8 text-2xl font-light text-zinc-200">
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
                      className={`mx-auto flex h-24 w-24 items-center justify-center overflow-hidden rounded-md text-4xl font-bold uppercase transition group-hover:ring-4 group-hover:ring-white ${
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
                    <p className="truncate text-xs text-zinc-600">
                      {p.serverName ?? p.serverUrl}
                    </p>
                  </motion.button>
                  {editMode && (
                    <button
                      onClick={() => removeProfile(p.id)}
                      aria-label={`Remove ${p.userName}`}
                      className="absolute -right-1 -top-1 rounded-full bg-red-600 p-1.5 text-white hover:bg-red-500"
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
              <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-md border-2 border-dashed border-zinc-700 text-zinc-600 transition group-hover:border-zinc-400 group-hover:text-zinc-300">
                <Plus size={32} />
              </div>
              <p className="mt-2 text-sm text-zinc-500 group-hover:text-zinc-300">
                {t("login.addServer")}
              </p>
            </motion.button>
          </div>

          {profiles.length > 0 && (
            <button
              onClick={() => setEditMode((m) => !m)}
              className="mt-10 border border-zinc-600 px-5 py-1.5 text-sm text-zinc-400 hover:border-white hover:text-white"
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
          className="w-full max-w-sm rounded-lg bg-black/60 p-8"
        >
          <h2 className="mb-6 text-xl font-semibold">{t("login.title")}</h2>

          <label className="mb-1 block text-xs text-zinc-400">{t("login.server")}</label>
          <input
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="http://localhost:8096"
            required
            className="mb-4 w-full rounded bg-zinc-800 px-4 py-2.5 text-sm outline-none ring-1 ring-transparent focus:ring-brand"
          />

          <label className="mb-1 block text-xs text-zinc-400">{t("login.username")}</label>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            className="mb-4 w-full rounded bg-zinc-800 px-4 py-2.5 text-sm outline-none ring-1 ring-transparent focus:ring-brand"
          />

          <label className="mb-1 block text-xs text-zinc-400">{t("login.password")}</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className="mb-6 w-full rounded bg-zinc-800 px-4 py-2.5 text-sm outline-none ring-1 ring-transparent focus:ring-brand"
          />

          {error && (
            <p className="mb-4 whitespace-pre-wrap text-xs text-red-400">{error}</p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded bg-brand py-2.5 font-semibold transition hover:bg-brand-light disabled:opacity-50"
          >
            {busy ? "…" : t("login.signIn")}
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
