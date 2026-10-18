/**
 * Akflix account: sign in once and Continue Watching (exact episode and
 * minute), watched titles, My List, ratings and playback preferences follow
 * you between the Mac, iPhone and Roku. Everything works signed out too.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  KeyRound,
  Laptop,
  LoaderCircle,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Trash2,
  Tv,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  applyFirebaseConfig,
  approveTvLink,
  cloudDeleteAccount,
  cloudSendPasswordReset,
  cloudSignIn,
  cloudSignOut,
  cloudStatusLine,
  forgetFirebaseConfig,
  lookupTvLink,
  normalizeTvCode,
  syncNow,
  useCloud,
  type TvLinkRequest,
} from "@/lib/cloud/engine";
import { pastedFirebaseConfig } from "@/lib/cloud/env";
import { CloudError } from "@/lib/cloud/rest";
import { isAppleMobile } from "@/lib/platform";

const spring = { type: "spring", stiffness: 420, damping: 34, mass: 0.7 } as const;

function message(reason: unknown) {
  return reason instanceof CloudError || reason instanceof Error ? reason.message : String(reason);
}

/** Re-renders every 30 s so "Synced 2 min ago" stays true. */
function useMinuteClock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function DeviceTrio({ linked, syncing }: { linked: boolean; syncing: boolean }) {
  const reduceMotion = useReducedMotion();
  const devices = [
    { Icon: Laptop, label: "Mac" },
    { Icon: Smartphone, label: "iPhone" },
    { Icon: Tv, label: "Roku" },
  ];
  return (
    <div className="account-trio" data-linked={linked} aria-hidden="true">
      <div className="account-trio-line">
        {syncing && !reduceMotion && <span className="account-trio-pulse" />}
      </div>
      {devices.map(({ Icon, label }, index) => (
        <motion.div
          key={label}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...spring, delay: 0.06 * index }}
          className="account-trio-device"
        >
          <span className="account-trio-icon">
            <Icon size={22} strokeWidth={1.6} />
          </span>
          <span className="account-trio-label">{label}</span>
        </motion.div>
      ))}
    </div>
  );
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label className="block">
      <span className="account-label">{label}</span>
      {children}
      {hint && <span className="account-hint">{hint}</span>}
    </label>
  );
}

function ErrorNotice({ text }: { text: string | null }) {
  return (
    <AnimatePresence initial={false}>
      {text && (
        <motion.p
          role="alert"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          className="account-error"
        >
          {text}
        </motion.p>
      )}
    </AnimatePresence>
  );
}

// ------------------------------------------------------------------ sign in

function SignInForm({ device }: { device: string }) {
  const [creating, setCreating] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await cloudSignIn(email, password, creating);
      toast.success(creating ? "Account created" : "Signed in", {
        description: `Your ${device} history is now part of your account.`,
      });
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setError(null);
    try {
      await cloudSendPasswordReset(email);
      toast.success("Check your email", { description: "We sent a link to choose a new password." });
    } catch (reason) {
      setError(message(reason));
    }
  };

  return (
    <motion.form
      onSubmit={submit}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring}
      className="account-card"
      noValidate
    >
      <div className="account-segment" role="tablist" aria-label="Account">
        {[
          { value: false, label: "Sign in" },
          { value: true, label: "Create account" },
        ].map((tab) => (
          <button
            key={tab.label}
            type="button"
            role="tab"
            aria-selected={creating === tab.value}
            onClick={() => {
              setCreating(tab.value);
              setError(null);
            }}
          >
            {creating === tab.value && <motion.span layoutId="account-segment" transition={spring} className="account-segment-thumb" />}
            <span className="relative">{tab.label}</span>
          </button>
        ))}
      </div>

      <div className="mt-5 space-y-4">
        <Field label="Email">
          <input
            type="email"
            inputMode="email"
            autoComplete={creating ? "email" : "username"}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            className="account-input"
            required
          />
        </Field>
        <Field label="Password" hint={creating ? "At least 6 characters." : undefined}>
          <span className="relative block">
            <input
              type={reveal ? "text" : "password"}
              autoComplete={creating ? "new-password" : "current-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="account-input pr-14"
              required
            />
            <button
              type="button"
              onClick={() => setReveal((value) => !value)}
              aria-label={reveal ? "Hide password" : "Show password"}
              className="account-reveal"
            >
              {reveal ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </span>
        </Field>
      </div>

      <ErrorNotice text={error} />

      <motion.button whileTap={{ scale: 0.97 }} type="submit" disabled={busy} aria-busy={busy} className="account-primary mt-5">
        {busy ? <LoaderCircle size={18} className="animate-spin" /> : null}
        {busy ? (creating ? "Creating account" : "Signing in") : creating ? "Create account" : "Sign in"}
      </motion.button>

      {!creating && (
        <button type="button" onClick={() => void reset()} className="account-link mx-auto mt-3 block">
          Forgot password?
        </button>
      )}

      <p className="account-fineprint mt-5">
        <ShieldCheck size={15} aria-hidden="true" />
        <span>
          What's on this {device} stays here and is added to your account. Signing out later keeps a copy too.
        </span>
      </p>
    </motion.form>
  );
}

// ------------------------------------------------------------------ setup

function SetupCard({ emulator }: { emulator: boolean }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pasted = pastedFirebaseConfig();

  const apply = () => {
    if (applyFirebaseConfig(text)) {
      toast.success("Accounts are ready", { description: "Sign in or create your Akflix account." });
      setText("");
      setOpen(false);
    } else {
      setError("That doesn't look like a Firebase web config. Paste the whole firebaseConfig block.");
    }
  };

  if (emulator || pasted) {
    return (
      <p className="account-fineprint mt-4 justify-center">
        <span>
          {emulator ? "Using the local test server." : `Using Firebase project ${pasted?.projectId}.`}{" "}
          {pasted && (
            <button type="button" className="account-link" onClick={() => forgetFirebaseConfig()}>
              Forget it
            </button>
          )}
        </span>
      </p>
    );
  }

  return (
    <motion.section initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="account-card">
      <p className="account-kicker">Not set up yet</p>
      <h2 className="account-title mt-1">Accounts not set up yet</h2>
      <p className="account-body mt-2">
        Akflix accounts live in your own free Firebase project. Once it exists, the next update has it built in, or paste
        its web config here to start now. Everything keeps working on this device meanwhile.
      </p>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="account-secondary mt-4"
      >
        <KeyRound size={17} /> Paste Firebase config
        <ChevronDown size={16} className={`ml-auto transition ${open ? "rotate-180" : ""}`} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <textarea
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setError(null);
              }}
              rows={6}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              placeholder={'const firebaseConfig = {\n  apiKey: "…",\n  projectId: "…",\n};'}
              className="account-input mt-3 font-mono !text-[max(16px,0.8em)]"
            />
            <ErrorNotice text={error} />
            <button type="button" onClick={apply} disabled={!text.trim()} className="account-primary mt-3">
              Use this project
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}

// -------------------------------------------------------------- signed in

function TvApproval() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<TvLinkRequest | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const valid = normalizeTvCode(code) !== null;

  const format = (raw: string) => {
    const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
  };

  const find = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      setRequest(await lookupTvLink(code));
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!request || busy) return;
    setBusy(true);
    setError(null);
    try {
      await approveTvLink(request);
      setDone(request.deviceName);
      setRequest(null);
      setCode("");
    } catch (reason) {
      setError(message(reason));
      setRequest(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="account-card" aria-labelledby="tv-heading">
      <div className="flex items-start gap-3">
        <span className="account-glyph">
          <Tv size={20} strokeWidth={1.7} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="tv-heading" className="account-title">
            Sign in on your TV
          </h2>
          <p className="account-body mt-1">
            On the Roku, open Settings → Akflix account. Type the code it shows.
          </p>
        </div>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        {done ? (
          <motion.div key="done" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={spring} className="account-success mt-4" role="status">
            <Check size={18} strokeWidth={2.6} />
            <span>
              <strong>{done}</strong> is signed in. Your Continue Watching appears there in a few seconds.
            </span>
            <button type="button" className="account-link ml-auto shrink-0" onClick={() => setDone(null)}>
              Another TV
            </button>
          </motion.div>
        ) : request ? (
          <motion.div key="confirm" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring} className="mt-4">
            <p className="account-body">
              Sign <strong className="text-white">{request.deviceName}</strong> in to this account?
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2.5">
              <button type="button" className="account-secondary justify-center" onClick={() => setRequest(null)} disabled={busy}>
                Cancel
              </button>
              <motion.button whileTap={{ scale: 0.97 }} type="button" className="account-primary" onClick={() => void approve()} disabled={busy} aria-busy={busy}>
                {busy && <LoaderCircle size={18} className="animate-spin" />} Sign in TV
              </motion.button>
            </div>
          </motion.div>
        ) : (
          <motion.form key="code" onSubmit={find} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mt-4 flex flex-wrap gap-2.5">
            <label className="min-w-0 flex-1 basis-[10rem]">
              <span className="sr-only">TV code</span>
              <input
                value={code}
                onChange={(event) => {
                  setCode(format(event.target.value));
                  setError(null);
                }}
                inputMode="text"
                autoCapitalize="characters"
                autoCorrect="off"
                autoComplete="one-time-code"
                spellCheck={false}
                placeholder="XXXX-XXXX"
                maxLength={9}
                className="account-input account-code"
              />
            </label>
            <motion.button whileTap={{ scale: 0.97 }} type="submit" disabled={!valid || busy} aria-busy={busy} className="account-primary !w-auto flex-none px-6">
              {busy ? <LoaderCircle size={18} className="animate-spin" /> : null} Continue
            </motion.button>
          </motion.form>
        )}
      </AnimatePresence>
      <ErrorNotice text={error} />
    </section>
  );
}

function DeleteAccount({ device }: { device: string }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const remove = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await cloudDeleteAccount(password);
      toast.success("Account deleted", { description: `Everything synced was removed. Your ${device} keeps its own copy.` });
      navigate("/settings");
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="account-row">
        <Trash2 size={18} aria-hidden="true" />
        <span className="flex-1">Delete account</span>
        <ChevronDown size={16} className={`transition ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.form
            onSubmit={remove}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden px-4 pb-4"
          >
            <p className="account-body">
              This permanently deletes your account and everything synced to it, on every device. What's on this {device} stays.
            </p>
            <Field label="Confirm with your password">
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="account-input"
              />
            </Field>
            <ErrorNotice text={error} />
            <button type="submit" disabled={!password || busy} aria-busy={busy} className="account-danger mt-3">
              {busy && <LoaderCircle size={18} className="animate-spin" />} Delete account forever
            </button>
          </motion.form>
        )}
      </AnimatePresence>
    </div>
  );
}

function SignedIn({ device }: { device: string }) {
  const status = useCloud();
  const now = useMinuteClock();
  const [signingOut, setSigningOut] = useState(false);
  const syncing = status.phase === "syncing";
  const initial = status.user?.email?.[0]?.toUpperCase() ?? "A";

  const sync = async () => {
    try {
      await syncNow();
    } catch {
      // The status line already explains it.
    }
  };

  const signOut = async () => {
    setSigningOut(true);
    try {
      await cloudSignOut();
      toast.success("Signed out", { description: `Your history stays on this ${device}.` });
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="space-y-4">
      <motion.section initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="account-card">
        <div className="flex items-center gap-3.5">
          <span className="account-avatar">{initial}</span>
          <div className="min-w-0 flex-1">
            <p className="account-title truncate">{status.user?.email}</p>
            <p className="account-status" data-phase={status.phase} role="status" aria-live="polite">
              <span className="account-status-dot" aria-hidden="true" />
              {cloudStatusLine(status, now)}
            </p>
          </div>
        </div>
        <div className="account-stats mt-4">
          <div>
            <strong>{status.titles}</strong>
            <span>{status.titles === 1 ? "title in your account" : "titles in your account"}</span>
          </div>
          <div>
            <strong>{status.pending}</strong>
            <span>{status.pending === 1 ? "change waiting" : "changes waiting"}</span>
          </div>
        </div>
        <motion.button whileTap={{ scale: 0.97 }} type="button" onClick={() => void sync()} disabled={syncing} className="account-secondary mt-4 justify-center">
          <RefreshCw size={17} className={syncing ? "animate-spin" : ""} /> {syncing ? "Syncing" : "Sync now"}
        </motion.button>
      </motion.section>

      <TvApproval />

      <section className="account-card !p-0 overflow-hidden" aria-label="Account actions">
        <button type="button" onClick={() => void signOut()} disabled={signingOut} className="account-row">
          {signingOut ? <LoaderCircle size={18} className="animate-spin" /> : <LogOut size={18} aria-hidden="true" />}
          <span className="flex-1">
            Sign out
            <span className="account-row-note">Keeps everything on this {device}</span>
          </span>
        </button>
        <DeleteAccount device={device} />
      </section>
    </div>
  );
}

// ------------------------------------------------------------------- page

export default function Account() {
  const navigate = useNavigate();
  const status = useCloud();
  const device = isAppleMobile() ? "iPhone" : "Mac";
  const signedIn = !!status.user;

  return (
    <motion.main
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="account-page mx-auto min-h-screen max-w-xl px-5 pb-36 pt-28"
    >
      <button type="button" onClick={() => navigate(-1)} className="account-back" aria-label="Back to Settings">
        <ArrowLeft size={18} /> Settings
      </button>

      <header className="mb-6 mt-3">
        <p className="ak-eyebrow flex items-center gap-2">
          Akflix account
          {status.mode === "emulator" && <span className="ak-badge ak-badge--quiet !tracking-[0.06em]">Test server</span>}
        </p>
        <h1 className="account-display mt-3">
          {!signedIn
            ? "Every screen, right where you left off."
            : status.phase === "offline"
              ? "Saved here for now."
              : status.phase === "error"
                ? "Sync needs a look."
                : "You're in sync."}
        </h1>
        <p className="account-lede mt-3">
          {signedIn
            ? "Continue Watching, the exact episode and minute, watched titles, My List, ratings and playback preferences follow you."
            : `Sign in on your Mac, ${device === "iPhone" ? "this iPhone" : "iPhone"} and Roku to pick up the exact episode and minute anywhere.`}
        </p>
        <DeviceTrio linked={signedIn} syncing={status.phase === "syncing"} />
      </header>

      {status.mode === "unconfigured" ? (
        <SetupCard emulator={false} />
      ) : signedIn ? (
        <SignedIn device={device} />
      ) : (
        <>
          <SignInForm device={device} />
          <SetupCard emulator={status.mode === "emulator"} />
        </>
      )}
    </motion.main>
  );
}
