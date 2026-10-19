/**
 * Mac: where Apple and Google sign-ins come from.
 *
 * This app is signed locally (ad hoc), which can't carry Apple's native Sign
 * in with Apple entitlement, and Google blocks sign-in inside embedded web
 * views. So both run in the default browser on Firebase's own sign-in page:
 * the app serves its bundled `signin.html` on a one-shot localhost server
 * (src-tauri/src/signin.rs); the page signs in with a popup and posts the
 * result back; this module turns it into the same answer signInWithIdp gives.
 */
import { invoke } from "@tauri-apps/api/core";
import type { IdpCredential, IdpProvider, IdpResponse } from "@/lib/cloud/auth";
import { NOT_SET_UP } from "@/lib/cloud/auth";
import type { CloudEnv } from "@/lib/cloud/env";
import { authError, CloudError } from "@/lib/cloud/rest";

export type ProviderSignIn =
  | { kind: "credential"; credential: IdpCredential }
  /** Firebase already signed in (browser flow): its signInWithIdp answer. */
  | { kind: "response"; response: IdpResponse }
  | { kind: "cancelled" };

/** Sign-ins finish in the browser; the screen says so and offers Cancel. */
export const BROWSER_SIGN_IN = true;

const WAIT_MS = 10 * 60_000;
let cancelCurrent: (() => void) | null = null;

export function cancelProviderSignIn() {
  cancelCurrent?.();
}

/** What signin.html posts back. */
export interface BrowserResult {
  status: "ok" | "exists" | "error" | "cancelled";
  providerId?: string;
  /** ok: the signed-in user. */
  uid?: string;
  email?: string;
  idToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  /** exists: the credential to link later (OAuthCredential.toJSON()). */
  credential?: { idToken?: string; accessToken?: string; nonce?: string; pendingToken?: string };
  /** error: the SDK's code, such as auth/admin-restricted-operation. */
  code?: string;
}

const SDK_CODES: Record<string, string> = {
  "auth/admin-restricted-operation": "ADMIN_ONLY_OPERATION",
  "auth/operation-not-allowed": "OPERATION_NOT_ALLOWED",
  "auth/user-disabled": "USER_DISABLED",
  "auth/credential-already-in-use": "FEDERATED_USER_ID_ALREADY_LINKED",
  "auth/invalid-credential": "INVALID_IDP_RESPONSE",
  "auth/too-many-requests": "TOO_MANY_ATTEMPTS_TRY_LATER",
  "auth/invalid-api-key": "API_KEY_INVALID",
  "auth/configuration-not-found": "CONFIGURATION_NOT_FOUND",
};

/** Maps the page's answer onto signInWithIdp's, so the engine treats both flows alike. */
export function browserAnswer(result: BrowserResult, provider: IdpProvider): ProviderSignIn {
  const providerId = result.providerId === "apple.com" || result.providerId === "google.com" ? result.providerId : provider;
  switch (result.status) {
    case "ok":
      if (!result.uid || !result.idToken || !result.refreshToken) break;
      return {
        kind: "response",
        response: {
          providerId,
          localId: result.uid,
          email: result.email ?? "",
          idToken: result.idToken,
          refreshToken: result.refreshToken,
          expiresIn: String(result.expiresIn ?? 3600),
        },
      };
    case "exists":
      return {
        kind: "response",
        response: {
          providerId,
          needConfirmation: true,
          email: result.email ?? "",
          oauthIdToken: result.credential?.idToken,
          oauthAccessToken: result.credential?.accessToken,
          nonce: result.credential?.nonce,
          pendingToken: result.credential?.pendingToken,
        },
      };
    case "cancelled":
      return { kind: "cancelled" };
    case "error": {
      if (result.code === "auth/popup-closed-by-user" || result.code === "auth/cancelled-popup-request" || result.code === "auth/user-cancelled") {
        return { kind: "cancelled" };
      }
      if (result.code === "auth/network-request-failed") throw new CloudError("offline", "You're offline. Connect and try again.", "NETWORK");
      if (result.code === "auth/unauthorized-domain" || result.code === "auth/invalid-oauth-client-id") throw new CloudError("setup", NOT_SET_UP, result.code);
      const known = result.code ? authError(SDK_CODES[result.code] ?? "") : null;
      throw known ?? new CloudError("invalid", "That sign-in didn't go through. Try again.", result.code ?? "BROWSER_SIGN_IN");
    }
  }
  throw new CloudError("invalid", "That sign-in didn't go through. Try again.", "BROWSER_SIGN_IN");
}

/** The page reads its settings from the URL fragment, which never leaves the browser. */
export function signInPageUrl(env: CloudEnv, provider: IdpProvider, port: number, state: string): string {
  const params = new URLSearchParams({
    state,
    provider,
    apiKey: env.apiKey,
    authDomain: env.authDomain,
    projectId: env.projectId,
  });
  if (env.mode === "emulator") params.set("emulator", new URL(env.authBase).origin);
  return `http://localhost:${port}/signin.html#${params}`;
}

export async function obtainProviderSignIn(env: CloudEnv, provider: IdpProvider): Promise<ProviderSignIn> {
  cancelCurrent?.();
  const [{ listen }, { openUrl }] = await Promise.all([import("@tauri-apps/api/event"), import("@tauri-apps/plugin-opener")]);
  const { port, state } = await invoke<{ port: number; state: string }>("signin_browser_start");
  let settle: (value: ProviderSignIn | PromiseLike<ProviderSignIn>) => void = () => undefined;
  let fail: (reason: unknown) => void = () => undefined;
  const answer = new Promise<ProviderSignIn>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const unlisten = await listen<string>("signin-browser-result", (event) => {
    try {
      settle(browserAnswer(JSON.parse(event.payload) as BrowserResult, provider));
    } catch (reason) {
      fail(reason);
    }
  });
  const timer = setTimeout(() => settle({ kind: "cancelled" }), WAIT_MS);
  cancelCurrent = () => settle({ kind: "cancelled" });
  try {
    await openUrl(signInPageUrl(env, provider, port, state));
    return await answer;
  } catch (reason) {
    if (reason instanceof CloudError) throw reason;
    throw new CloudError("invalid", "The browser didn't open. Try again.", "BROWSER_OPEN");
  } finally {
    clearTimeout(timer);
    cancelCurrent = null;
    unlisten();
    void invoke("signin_browser_cancel").catch(() => undefined);
  }
}
