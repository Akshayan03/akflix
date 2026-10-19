import "./device-env";
import { parentPort } from "node:worker_threads";
import { useHistory, type HistoryTitle, type WatchHistoryEntry } from "@/stores/historyStore";
import { useMyList, savedTitlesFor } from "@/stores/listStore";
import { useSettings } from "@/stores/settingsStore";
import {
  approveTvLink,
  cloudDeleteAccount,
  cloudSignIn,
  cloudSignInMethods,
  cloudSignInWithProvider,
  cloudSignOut,
  initCloudSync,
  lookupTvLink,
  pendingAccountLink,
  syncNow,
  useCloud,
  type SignInResult,
} from "@/lib/cloud/engine";
import type { IdpProvider, IdpResponse } from "@/lib/cloud/auth";
import { CloudError } from "@/lib/cloud/rest";

/**
 * Stands in for the native Apple / Google sheets: the Auth emulator accepts a
 * provider token that is just the JSON claims, the way a real one carries them.
 */
const fakeProvider = (claims: Record<string, unknown>) => async (_env: unknown, provider: IdpProvider) => ({
  kind: "credential" as const,
  credential: { providerId: provider, idToken: JSON.stringify(claims), ...(provider === "apple.com" ? { rawNonce: "raw-nonce" } : {}) },
});
const summary = (result: SignInResult | null) => (result ? { uid: result.session.uid, method: result.session.method, linked: result.linked, linkProblem: result.linkProblem } : null);

/** Continue Watching rows as the Mac's Home builds them (newest per title, unfinished). */
function continuingEntries(entries: WatchHistoryEntry[], profileId: string) {
  const seen = new Set<string>();
  return entries
    .filter((e) => e.profileId === profileId && e.media.source === "discover")
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((e) => {
      const key = `${e.media.type}:${e.media.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .filter((e) => !e.completed && (e.position > 0 || (e.media.type === "series" && !!e.season && !!e.episode)));
}

initCloudSync();

const handlers: Record<string, (...args: any[]) => unknown> = {
  signUp: (email: string, password: string) => cloudSignIn(email, password, true).then(summary),
  signIn: (email: string, password: string) => cloudSignIn(email, password, false).then(summary),
  signOut: () => cloudSignOut(),
  signInWith: (provider: IdpProvider, claims: Record<string, unknown>) => cloudSignInWithProvider(provider, fakeProvider(claims)).then(summary),
  // The Mac's browser flow: Firebase already signed in on its page and hands back that answer.
  signInWithAnswer: (provider: IdpProvider, response: IdpResponse) => cloudSignInWithProvider(provider, async () => ({ kind: "response", response })).then(summary),
  cancelSignIn: (provider: IdpProvider) => cloudSignInWithProvider(provider, async () => ({ kind: "cancelled" })).then(summary),
  pendingLink: () => pendingAccountLink(),
  methods: () => cloudSignInMethods(),
  record: (media: HistoryTitle, position: number, duration: number, details?: Record<string, unknown>) =>
    useHistory.getState().recordProgress(media, position, duration, details),
  remove: (media: HistoryTitle) => useHistory.getState().removeEntry(media),
  rate: (media: HistoryTitle, value: number | null) => useHistory.getState().setRating(media, value),
  toggleList: (media: HistoryTitle) => useMyList.getState().toggle(media),
  setSettings: (patch: Record<string, unknown>) => useSettings.getState().update(patch as never),
  sync: () => syncNow(),
  offline: (value: boolean) => {
    (globalThis as { __offline?: boolean }).__offline = value;
  },
  approveTv: async (code: string) => {
    const request = await lookupTvLink(code);
    await approveTvLink(request);
    return request.deviceName;
  },
  deleteAccount: (password: string) => cloudDeleteAccount(password),
  deleteAccountWith: (provider: IdpProvider, claims: Record<string, unknown>) => cloudDeleteAccount({ method: provider }, fakeProvider(claims)),
  state: () => {
    const settings = useSettings.getState();
    return {
      entries: useHistory.getState().entries,
      ratings: useHistory.getState().ratings,
      continuing: continuingEntries(useHistory.getState().entries, "akflix-local").map((e) => ({
        key: `${e.media.type}:${e.media.id}`,
        season: e.season,
        episode: e.episode,
        position: e.position,
      })),
      myList: savedTitlesFor(useMyList.getState().items, "akflix-local").map((i) => `${i.media.type}:${i.media.id}`).sort(),
      settings: { audioLanguage: settings.audioLanguage, subtitleLanguage: settings.subtitleLanguage, autoPlayNextEpisode: settings.autoPlayNextEpisode },
      status: useCloud.getState(),
    };
  },
};

parentPort!.on("message", async ({ id, cmd, args }: { id: number; cmd: string; args: unknown[] }) => {
  try {
    const result = await handlers[cmd](...args);
    parentPort!.postMessage({ id, ok: true, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) });
  } catch (error) {
    parentPort!.postMessage({
      id,
      ok: false,
      error: { message: error instanceof Error ? error.message : String(error), kind: error instanceof CloudError ? error.kind : "", code: error instanceof CloudError ? error.code : "" },
    });
  }
});
