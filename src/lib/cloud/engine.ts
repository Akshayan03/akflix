/**
 * Akflix account sync engine.
 *
 * Offline-first: every change is written to the local stores first and the
 * app never waits on the network. When signed in, a sync cycle per profile
 *   1. pulls only the cloud titles changed since the last cycle,
 *   2. merges them with this device last-writer-wins per facet and applies
 *      whatever the cloud has newer,
 *   3. pushes whatever this device has newer, with an updateTime
 *      precondition so two devices writing at once never overwrite each
 *      other (a conflict simply re-runs the cycle).
 * The first cycle after signing in pulls the whole account and uploads the
 * local history; nothing local is wiped. Signing out keeps the local copy.
 */
import { create } from "zustand";
import { cloudEnv, parseFirebaseConfig, savePastedFirebaseConfig, type CloudEnv, type CloudMode } from "@/lib/cloud/env";
import * as auth from "@/lib/cloud/auth";
import type { CloudSession } from "@/lib/cloud/auth";
import { CloudError } from "@/lib/cloud/rest";
import { FirestoreClient, fromFields, toFields, type FirestoreDocument, type Write } from "@/lib/cloud/firestore";
import {
  addRemovalTombstones,
  collectLocalChanges,
  emptyPatch,
  fingerprint,
  journalWithPatch,
  localTitles,
  mergeSettings,
  mergeTitles,
  patchIsEmpty,
  settingsFingerprint,
  stable,
  titleDocId,
  titleFromDoc,
  titleToDoc,
  type CloudSettings,
  type CloudTitle,
  type LocalPatch,
} from "@/lib/cloud/model";
import { readJournal, writeJournal, noteSettingsChanged } from "@/lib/cloud/journal";
import { useHistory } from "@/stores/historyStore";
import { useMyList } from "@/stores/listStore";
import { useSettings } from "@/stores/settingsStore";
import { LOCAL_PROFILE_ID, useAuth } from "@/stores/authStore";
import { isAppleMobile } from "@/lib/platform";
import type { ServerProfile } from "@/types/jellyfin";

// ------------------------------------------------------------------ status

export type CloudPhase = "idle" | "syncing" | "offline" | "error";

export interface CloudStatus {
  mode: CloudMode;
  projectId: string;
  user: { uid: string; email: string } | null;
  phase: CloudPhase;
  lastSyncedAt: number | null;
  /** Human sentence for the last problem, or null. */
  message: string | null;
  /** Catalog titles this account holds for the active profile. */
  titles: number;
  /** Local changes that haven't reached the account yet. */
  pending: number;
}

function initialStatus(): CloudStatus {
  const env = cloudEnv();
  const session = loadSession(env);
  return {
    mode: env.mode,
    projectId: env.projectId,
    user: session ? { uid: session.uid, email: session.email } : null,
    phase: "idle",
    lastSyncedAt: session ? loadState(session.uid).lastSyncedAt : null,
    message: null,
    titles: 0,
    pending: 0,
  };
}

// --------------------------------------------------------------- persistence

const SESSION_KEY = "akflix.cloud.session";
const STATE_PREFIX = "akflix.cloud.state.";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function loadSession(env = cloudEnv()): CloudSession | null {
  const raw = storage()?.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as CloudSession;
    return session.env === env.key && session.uid && session.refreshToken ? session : null;
  } catch {
    return null;
  }
}

function saveSession(session: CloudSession | null) {
  const store = storage();
  if (!store) return;
  if (session) store.setItem(SESSION_KEY, JSON.stringify(session));
  else store.removeItem(SESSION_KEY);
}

interface MirrorRow {
  title: CloudTitle;
  updateTime: string;
}

interface SyncState {
  /** Cloud profile id → title key → last known cloud copy. */
  mirror: Record<string, Record<string, MirrorRow>>;
  /** Cloud profile id → newest (serverAt, document name) pulled. */
  cursors: Record<string, { at: string; name: string } | null>;
  settings: { remote: CloudSettings | null; updateTime: string | null };
  profilesWritten: Record<string, string>;
  userWritten: boolean;
  lastSyncedAt: number | null;
}

const emptyState = (): SyncState => ({
  mirror: {},
  cursors: {},
  settings: { remote: null, updateTime: null },
  profilesWritten: {},
  userWritten: false,
  lastSyncedAt: null,
});

function loadState(uid: string): SyncState {
  const raw = storage()?.getItem(STATE_PREFIX + uid);
  if (!raw) return emptyState();
  try {
    return { ...emptyState(), ...(JSON.parse(raw) as Partial<SyncState>) };
  } catch {
    return emptyState();
  }
}

function saveState(uid: string, state: SyncState) {
  try {
    storage()?.setItem(STATE_PREFIX + uid, JSON.stringify(state));
  } catch {
    // Storage full: the next cycle starts from a full pull, which is safe.
    storage()?.removeItem(STATE_PREFIX + uid);
  }
}

// Created after the storage helpers above, which its first state reads.
export const useCloud = create<CloudStatus>()(() => initialStatus());

// ------------------------------------------------------------------ profiles

function hash(input: string, seed: number) {
  let value = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 16777619) >>> 0;
  }
  return value.toString(16).padStart(8, "0");
}

/** Same person on the same Jellyfin server maps to the same cloud profile on every device. */
export function cloudProfileFor(profile: Pick<ServerProfile, "id" | "kind" | "serverUrl" | "userId" | "userName" | "serverName">) {
  if (profile.id === LOCAL_PROFILE_ID || profile.kind === "local") return { id: "main", name: "Akflix", kind: "local" };
  const identity = `${profile.serverUrl.trim().replace(/\/+$/, "").toLowerCase()}|${profile.userId}`;
  return {
    id: `jf-${hash(identity, 2166136261)}${hash(identity, 3735928559)}`,
    name: `${profile.userName} · ${profile.serverName ?? "Jellyfin"}`.slice(0, 80),
    kind: "jellyfin",
  };
}

function localProfiles(): ServerProfile[] {
  const profiles = useAuth.getState().profiles;
  return profiles.some((profile) => profile.id === LOCAL_PROFILE_ID)
    ? profiles
    : [{ id: LOCAL_PROFILE_ID, kind: "local", serverUrl: "local://akflix", userId: "local", userName: "Akflix", accessToken: "" }, ...profiles];
}

// ---------------------------------------------------------------- settings

export const SYNCED_SETTINGS = ["language", "subtitleLanguage", "audioLanguage", "autoPlayNextEpisode"] as const;

function syncedSettingKeys(): string[] {
  const state = useSettings.getState() as unknown as Record<string, unknown>;
  return SYNCED_SETTINGS.filter((key) => key in state);
}

function localSettings(): CloudSettings {
  const state = useSettings.getState() as unknown as Record<string, unknown>;
  const journal = readJournal();
  const values: Record<string, unknown> = {};
  const at: Record<string, number> = {};
  for (const key of syncedSettingKeys()) {
    values[key] = state[key];
    at[key] = journal.settingsAt[key] ?? 0;
  }
  return { values, at };
}

// ------------------------------------------------------------------ tokens

let refreshing: Promise<CloudSession> | null = null;

async function currentSession(env: CloudEnv, minimumLifeMs = 120_000): Promise<CloudSession> {
  const session = loadSession(env);
  if (!session) throw new CloudError("auth", "Sign in to sync.", "SIGNED_OUT");
  if (session.expiresAt - minimumLifeMs > Date.now()) return session;
  refreshing ??= auth
    .refreshSession(env, session)
    .then((fresh) => {
      // A sign-out while refreshing wins.
      if (loadSession(env)?.uid === fresh.uid) saveSession(fresh);
      return fresh;
    })
    .finally(() => {
      refreshing = null;
    });
  try {
    return await refreshing;
  } catch (reason) {
    if (reason instanceof CloudError && reason.kind === "auth") endSession(reason.message);
    throw reason;
  }
}

function client(env: CloudEnv) {
  return new FirestoreClient(env, async () => (await currentSession(env)).idToken);
}

function endSession(message: string | null) {
  const session = loadSession();
  saveSession(null);
  if (session) storage()?.removeItem(STATE_PREFIX + session.uid);
  useCloud.setState({ user: null, phase: "idle", message, titles: 0, pending: 0, lastSyncedAt: null });
}

// -------------------------------------------------------------- local apply

let applyingCloud = false;

function snapshot() {
  return {
    entries: useHistory.getState().entries,
    ratings: useHistory.getState().ratings,
    list: useMyList.getState().items,
    journal: readJournal(),
  };
}

function applyPatch(profileId: string, patch: LocalPatch) {
  if (!patchIsEmpty(patch)) {
    applyingCloud = true;
    try {
      useHistory.getState().applyCloud({
        entries: patch.entries,
        removeEntries: patch.removeEntries.map((key) => ({ profileId, key })),
        ratings: patch.ratings,
        removeRatings: patch.removeRatings.map((key) => ({ profileId, key })),
      });
      useMyList.getState().applyCloud(patch.list);
    } finally {
      applyingCloud = false;
    }
  }
  if (patch.watchTombstones.length || patch.ratingTombstones.length) {
    writeJournal(journalWithPatch(readJournal(), profileId, patch));
  }
}

function localView(profileId: string, mirror: Record<string, MirrorRow>) {
  const snap = snapshot();
  const titles = localTitles(profileId, snap);
  addRemovalTombstones(profileId, titles, snap.journal, (key) => mirror[key]?.title);
  return titles;
}

function pendingFor(profileId: string, mirror: Record<string, MirrorRow>) {
  let pending = 0;
  for (const [key, title] of localView(profileId, mirror)) {
    const remote = mirror[key]?.title;
    if (fingerprint(mergeTitles(title, remote)) !== fingerprint(remote)) pending += 1;
  }
  return pending;
}

// --------------------------------------------------------------------- cycle

const PAGE = 300;
const CHUNK = 100;
const serverAtTransform = [{ fieldPath: "serverAt", setToServerValue: "REQUEST_TIME" as const }];

async function writeAccountDocs(fs: FirestoreClient, uid: string, email: string, state: SyncState, profiles: ServerProfile[]) {
  const writes: Write[] = [];
  if (!state.userWritten) {
    writes.push({
      update: { name: fs.path("users", uid), fields: toFields({ email, app: "akflix" }) },
      updateMask: { fieldPaths: ["email", "app"] },
      updateTransforms: [{ fieldPath: "lastSeenAt", setToServerValue: "REQUEST_TIME" }],
    });
  }
  const wanted: Record<string, string> = {};
  for (const profile of profiles) {
    const cloud = cloudProfileFor(profile);
    wanted[cloud.id] = cloud.name;
    if (state.profilesWritten[cloud.id] === cloud.name) continue;
    writes.push({
      update: { name: fs.path("users", uid, "profiles", cloud.id), fields: toFields({ name: cloud.name, kind: cloud.kind }) },
      updateMask: { fieldPaths: ["name", "kind"] },
      updateTransforms: serverAtTransform,
    });
  }
  if (!writes.length) return;
  await fs.commit(writes);
  state.userWritten = true;
  state.profilesWritten = { ...state.profilesWritten, ...wanted };
}

async function syncProfile(fs: FirestoreClient, uid: string, state: SyncState, profile: ServerProfile, firstForProfile: boolean) {
  const cloudId = cloudProfileFor(profile).id;
  const parent = fs.path("users", uid, "profiles", cloudId);
  const mirror = (state.mirror[cloudId] ??= {});

  for (let attempt = 0; ; attempt += 1) {
    // 1. Pull what changed in the account since the last cycle.
    const changed = new Set<string>();
    for (;;) {
      const docs = await fs.changedSince(parent, "titles", "serverAt", state.cursors[cloudId] ?? null, PAGE);
      for (const doc of docs) {
        const title = titleFromDoc(fromFields(doc.fields));
        const serverAt = doc.fields?.serverAt && "timestampValue" in doc.fields.serverAt ? doc.fields.serverAt.timestampValue : null;
        if (serverAt) state.cursors[cloudId] = { at: serverAt, name: doc.name };
        if (!title || !doc.updateTime) continue;
        mirror[title.key] = { title, updateTime: doc.updateTime };
        changed.add(title.key);
      }
      if (docs.length < PAGE) break;
    }

    // 2. Adopt whatever the account has newer than this device.
    const local = localView(profile.id, mirror);
    const patch = emptyPatch();
    for (const key of firstForProfile ? Object.keys(mirror) : changed) {
      const merged = mergeTitles(local.get(key), mirror[key]?.title);
      if (merged) collectLocalChanges(profile.id, merged, local.get(key), patch);
    }
    applyPatch(profile.id, patch);

    // 3. Push whatever this device has newer than the account.
    const pushes: CloudTitle[] = [];
    for (const [key, title] of localView(profile.id, mirror)) {
      const remote = mirror[key]?.title;
      const merged = mergeTitles(title, remote);
      if (merged && fingerprint(merged) !== fingerprint(remote)) pushes.push(merged);
    }
    try {
      for (let index = 0; index < pushes.length; index += CHUNK) {
        const chunk = pushes.slice(index, index + CHUNK);
        const result = await fs.commit(
          chunk.map((title) => ({
            update: { name: `${parent}/titles/${titleDocId(title.type, title.id)}`, fields: toFields(titleToDoc(title)) },
            updateTransforms: serverAtTransform,
            currentDocument: mirror[title.key] ? { updateTime: mirror[title.key].updateTime } : { exists: false },
          }))
        );
        chunk.forEach((title, offset) => {
          const updateTime = result.writeResults?.[offset]?.updateTime ?? result.commitTime;
          mirror[title.key] = { title, updateTime };
        });
      }
      return;
    } catch (reason) {
      // Someone else wrote one of these titles since we pulled: pull again and re-merge. If that keeps
      // happening, this device's copy is off somehow, so the last try re-reads the whole profile.
      if (reason instanceof CloudError && reason.kind === "conflict" && attempt < 3) {
        if (attempt === 2) state.cursors[cloudId] = null;
        continue;
      }
      throw reason;
    }
  }
}

async function syncSettings(fs: FirestoreClient, uid: string, state: SyncState) {
  const name = fs.path("users", uid, "settings", "app");
  for (let attempt = 0; ; attempt += 1) {
    const doc = await fs.get(name);
    const data = doc ? fromFields(doc.fields) : null;
    const remote: CloudSettings | null = data
      ? { values: (data.values as Record<string, unknown>) ?? {}, at: (data.at as Record<string, number>) ?? {} }
      : null;
    state.settings = { remote, updateTime: doc?.updateTime ?? null };
    const local = localSettings();
    const merged = mergeSettings(local, remote) as CloudSettings;

    // Apply newer values from other devices.
    const current = useSettings.getState() as unknown as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    const journal = readJournal();
    for (const key of Object.keys(local.values)) {
      if (!(key in merged.values)) continue;
      if (stable(merged.values[key]) !== stable(current[key])) patch[key] = merged.values[key];
      if ((merged.at[key] ?? 0) > (journal.settingsAt[key] ?? 0)) journal.settingsAt[key] = merged.at[key];
    }
    writeJournal(journal);
    if (Object.keys(patch).length) {
      applyingCloud = true;
      try {
        useSettings.getState().update(patch as never);
      } finally {
        applyingCloud = false;
      }
    }

    if (settingsFingerprint(merged) === settingsFingerprint(remote)) return;
    try {
      const write: Write = {
        update: { name, fields: toFields({ values: merged.values, at: merged.at }) },
        updateTransforms: serverAtTransform,
        currentDocument: doc?.updateTime ? { updateTime: doc.updateTime } : { exists: false },
      };
      const result = await fs.commit([write]);
      state.settings = { remote: merged, updateTime: result.writeResults?.[0]?.updateTime ?? result.commitTime };
      return;
    } catch (reason) {
      if (reason instanceof CloudError && reason.kind === "conflict" && attempt < 3) continue;
      throw reason;
    }
  }
}

async function runCycle() {
  const env = cloudEnv();
  if (env.mode === "unconfigured") return;
  const session = loadSession(env);
  if (!session) return;
  const state = loadState(session.uid);
  const fs = client(env);
  const profiles = localProfiles();
  const activeId = useAuth.getState().activeProfileId ?? LOCAL_PROFILE_ID;
  useCloud.setState({ phase: "syncing", user: { uid: session.uid, email: session.email } });
  try {
    await writeAccountDocs(fs, session.uid, session.email, state, profiles);
    for (const profile of profiles) {
      const cloudId = cloudProfileFor(profile).id;
      const first = !(cloudId in state.cursors);
      await syncProfile(fs, session.uid, state, profile, first);
      state.cursors[cloudId] ??= null;
    }
    await syncSettings(fs, session.uid, state);
    // A sign-out during the cycle wins: don't resurrect its state.
    if (loadSession(env)?.uid !== session.uid) return;
    state.lastSyncedAt = Date.now();
    saveState(session.uid, state);
    const activeMirror = state.mirror[cloudProfileFor(profiles.find((p) => p.id === activeId) ?? profiles[0]).id] ?? {};
    useCloud.setState({
      phase: "idle",
      message: null,
      lastSyncedAt: state.lastSyncedAt,
      titles: Object.values(activeMirror).filter((row) => (row.title.watch && !row.title.watch.removed) || row.title.list?.saved).length,
      pending: 0,
    });
    failures = 0;
  } catch (reason) {
    if (loadSession(env)?.uid === session.uid) saveState(session.uid, state);
    const error = reason instanceof CloudError ? reason : new CloudError("server", reason instanceof Error ? reason.message : String(reason));
    const activeProfile = profiles.find((p) => p.id === activeId) ?? profiles[0];
    const pending = pendingFor(activeProfile.id, state.mirror[cloudProfileFor(activeProfile).id] ?? {});
    if (!loadSession(env)) return; // the session ended (endSession already reported why)
    useCloud.setState({ phase: error.kind === "offline" ? "offline" : "error", message: error.message, pending });
    failures += 1;
    throw error;
  }
}

// ---------------------------------------------------------------- scheduling

let running: Promise<void> | null = null;
let rerun = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let timerAt = 0;
let lastStart = 0;
let failures = 0;
let started = false;
let interval: ReturnType<typeof setInterval> | null = null;
const cleanups: (() => void)[] = [];
const MIN_GAP_MS = 15_000;

/** Runs a sync cycle now (or right after the one in flight) and resolves when it's done. */
export async function syncNow(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (running) {
    rerun = true;
    return running;
  }
  lastStart = Date.now();
  running = (async () => {
    try {
      do {
        rerun = false;
        await runCycle();
      } while (rerun);
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Asks for a sync soon; bursts of local changes coalesce into one cycle. */
export function requestCloudSync(delayMs = 12_000) {
  if (!loadSession()) return;
  const backoff = failures ? Math.min(300_000, 15_000 * 2 ** (failures - 1)) : 0;
  const due = Math.max(Date.now() + delayMs, lastStart + MIN_GAP_MS, failures ? lastStart + backoff : 0);
  if (timer && timerAt <= due) return;
  if (timer) clearTimeout(timer);
  timerAt = due;
  timer = setTimeout(() => {
    timer = null;
    void syncNow().catch(() => undefined);
  }, Math.max(0, due - Date.now()));
}

/** Starts watching local changes and syncing in the background. Idempotent. */
export function initCloudSync() {
  if (started) return;
  started = true;
  useCloud.setState(initialStatus());

  cleanups.push(
    useHistory.subscribe((state, previous) => {
      if (applyingCloud) return;
      // Ratings are deliberate taps; positions arrive every few seconds while playing.
      if (state.ratings !== previous.ratings) requestCloudSync(3_000);
      else if (state.entries !== previous.entries) requestCloudSync(30_000);
    }),
    useMyList.subscribe((state, previous) => {
      if (!applyingCloud && state.items !== previous.items) requestCloudSync(4_000);
    }),
    useSettings.subscribe((state, previous) => {
      if (applyingCloud) return;
      const now = state as unknown as Record<string, unknown>;
      const before = previous as unknown as Record<string, unknown>;
      const changed = syncedSettingKeys().filter((key) => stable(now[key]) !== stable(before[key]));
      if (changed.length) {
        noteSettingsChanged(changed);
        requestCloudSync(4_000);
      }
    }),
    useAuth.subscribe((state, previous) => {
      if (state.profiles !== previous.profiles) requestCloudSync(2_000);
    })
  );

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    const online = () => requestCloudSync(1_000);
    window.addEventListener("online", online);
    cleanups.push(() => window.removeEventListener("online", online));
  }
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    const visibility = () => {
      // Leaving the app: flush now; coming back: pick up the other devices.
      if (document.visibilityState === "hidden") void syncNow().catch(() => undefined);
      else requestCloudSync(1_500);
    };
    document.addEventListener("visibilitychange", visibility);
    cleanups.push(() => document.removeEventListener("visibilitychange", visibility));
  }
  interval = setInterval(() => {
    if (typeof document === "undefined" || document.visibilityState !== "hidden") requestCloudSync(0);
  }, 90_000);

  if (loadSession()) void syncNow().catch(() => undefined);
}

export function stopCloudSync() {
  started = false;
  while (cleanups.length) cleanups.pop()?.();
  if (interval) clearInterval(interval);
  interval = null;
  if (timer) clearTimeout(timer);
  timer = null;
}

// ------------------------------------------------------------- account flows

export async function cloudSignIn(email: string, password: string, create = false) {
  const env = cloudEnv();
  const problem = auth.validateCredentials(email, password, create);
  if (problem) throw new CloudError("invalid", problem, "INVALID_INPUT");
  const session = create ? await auth.signUp(env, email, password) : await auth.signIn(env, email, password);
  saveSession(session);
  failures = 0;
  useCloud.setState({ user: { uid: session.uid, email: session.email }, message: null, phase: "idle" });
  // The first cycle uploads this device's history and pulls the account.
  try {
    await syncNow();
  } catch {
    // Signed in; the status line explains the sync problem and it retries.
    requestCloudSync(15_000);
  }
  return session;
}

export async function cloudSignOut() {
  if (loadSession()) {
    try {
      await syncNow();
    } catch {
      // Offline: the local copy keeps everything anyway.
    }
  }
  endSession(null);
}

export async function cloudSendPasswordReset(email: string) {
  const clean = auth.normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw new CloudError("invalid", "Enter the email you signed up with.", "INVALID_INPUT");
  await auth.sendPasswordReset(cloudEnv(), clean);
}

async function deleteTree(fs: FirestoreClient, uid: string) {
  const deletes: string[] = [];
  const collect = async (collection: string) => {
    let token: string | undefined;
    const names: string[] = [];
    do {
      const page = await fs.list(collection, token);
      names.push(...page.documents.map((doc: FirestoreDocument) => doc.name));
      token = page.nextPageToken;
    } while (token);
    return names;
  };
  const profiles = await collect(fs.path("users", uid, "profiles"));
  for (const profile of profiles) deletes.push(...(await collect(`${profile}/titles`)));
  deletes.push(...profiles, ...(await collect(fs.path("users", uid, "settings"))), fs.path("users", uid));
  for (let index = 0; index < deletes.length; index += 400) {
    await fs.commit(deletes.slice(index, index + 400).map((name) => ({ delete: name })));
  }
}

/** Deletes everything in the account, then the account. Local history stays on this device. */
export async function cloudDeleteAccount(password: string) {
  const env = cloudEnv();
  const session = loadSession(env);
  if (!session) throw new CloudError("auth", "Sign in first.", "SIGNED_OUT");
  // Deleting needs a recent sign-in; this also confirms it's really them.
  const fresh = await auth.signIn(env, session.email, password);
  saveSession(fresh);
  if (running) await running.catch(() => undefined);
  stopTimers();
  await deleteTree(new FirestoreClient(env, async () => fresh.idToken), fresh.uid);
  await auth.deleteUser(env, fresh.idToken);
  endSession(null);
}

function stopTimers() {
  if (timer) clearTimeout(timer);
  timer = null;
}

// ---------------------------------------------------------- TV sign-in codes

const CODE_ALPHABET = /^[BCDFGHJKLMNPQRSTVWXZ2-9]{8}$/;

export function normalizeTvCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return CODE_ALPHABET.test(code) ? code : null;
}

export interface TvLinkRequest {
  code: string;
  deviceName: string;
  platform: string;
  updateTime: string;
}

export async function lookupTvLink(input: string): Promise<TvLinkRequest> {
  const code = normalizeTvCode(input);
  if (!code) throw new CloudError("invalid", "Codes are 8 letters and numbers, like BKDT-7M4Q.", "INVALID_INPUT");
  const env = cloudEnv();
  const fs = client(env);
  const doc = await fs.get(fs.path("deviceLinks", code));
  if (!doc?.updateTime) throw new CloudError("invalid", "No TV is showing that code. Check the code on the TV.", "NOT_FOUND");
  const data = fromFields(doc.fields);
  if (data.status !== "waiting") throw new CloudError("invalid", "That TV is already signed in.", "USED");
  const expires = Date.parse(String(data.expiresAt ?? ""));
  if (!Number.isFinite(expires) || expires <= Date.now()) {
    throw new CloudError("invalid", "That code has expired. Choose Sign in again on the TV for a new one.", "EXPIRED");
  }
  return {
    code,
    deviceName: String(data.deviceName ?? "TV").slice(0, 60),
    platform: String(data.platform ?? "tv"),
    updateTime: doc.updateTime,
  };
}

/** Signs the waiting TV in to this account by handing it this device's session. */
export async function approveTvLink(request: TvLinkRequest) {
  const env = cloudEnv();
  const session = await currentSession(env);
  const fs = client(env);
  try {
    await fs.patch(
      fs.path("deviceLinks", request.code),
      toFields({
        status: "approved",
        uid: session.uid,
        email: session.email,
        refreshToken: session.refreshToken,
        approvedBy: isAppleMobile() ? "iPhone" : "Mac",
      }),
      ["status", "uid", "email", "refreshToken", "approvedBy"],
      // The rules only let a waiting code be approved, so a code works once.
      { exists: true }
    );
  } catch (reason) {
    if (reason instanceof CloudError && (reason.kind === "conflict" || reason.kind === "denied")) {
      throw new CloudError("invalid", "That code was just used or expired. Get a new code on the TV.", "USED");
    }
    throw reason;
  }
}

// --------------------------------------------------------- project config

/** Points this app at the owner's Firebase project without a rebuild. */
export function applyFirebaseConfig(text: string): boolean {
  const config = parseFirebaseConfig(text);
  if (!config) return false;
  endSession(null);
  savePastedFirebaseConfig(config);
  useCloud.setState(initialStatus());
  return true;
}

export function forgetFirebaseConfig() {
  endSession(null);
  savePastedFirebaseConfig(null);
  useCloud.setState(initialStatus());
}

export function cloudStatusLine(status: CloudStatus, now = Date.now()): string {
  if (status.phase === "syncing") return "Syncing…";
  if (status.phase === "offline") {
    return status.pending ? `Offline · ${status.pending} ${status.pending === 1 ? "change" : "changes"} waiting` : "Offline · will sync when you're back";
  }
  if (status.phase === "error") return status.message ?? "Couldn't sync. Akflix will retry.";
  if (!status.lastSyncedAt) return "Not synced yet";
  const seconds = Math.max(0, Math.round((now - status.lastSyncedAt) / 1000));
  if (seconds < 45) return "Synced just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Synced ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Synced ${hours} h ago`;
  return `Synced ${new Date(status.lastSyncedAt).toLocaleDateString()}`;
}
