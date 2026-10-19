/**
 * The Mac's browser sign-in page (signin.html). Akflix serves it on a
 * one-shot localhost server and opens it in the default browser; it signs in
 * with Apple or Google on Firebase's own sign-in page (a popup) and posts the
 * result back to the app. Nothing is kept in this browser afterwards.
 */
import "./signin.css";
import logo from "@/brand/logo.json";
import { APPLE_MARK, GOOGLE_MARK } from "@/components/signInMarkPaths";
import { initializeApp } from "firebase/app";
import {
  browserPopupRedirectResolver,
  connectAuthEmulator,
  GoogleAuthProvider,
  inMemoryPersistence,
  initializeAuth,
  OAuthProvider,
  signInWithPopup,
  type AuthError,
} from "firebase/auth";

const params = new URLSearchParams(location.hash.slice(1));
// Keep the attempt's settings out of the browser history.
history.replaceState(null, "", location.pathname);

const state = params.get("state") ?? "";
const providerId = params.get("provider") === "apple.com" ? "apple.com" : "google.com";
const label = providerId === "apple.com" ? "Apple" : "Google";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const title = $("title");
const body = $("body");
const go = $<HTMLButtonElement>("go");
const cancel = $<HTMLButtonElement>("cancel");

const brand = $("brand") as unknown as SVGSVGElement;
brand.setAttribute("viewBox", logo.wordmark.viewBox);
brand.querySelector("path")?.setAttribute("d", logo.wordmark.path);

function show(heading: string, text: string, { button = false, canCancel = false } = {}) {
  title.textContent = heading;
  body.textContent = text;
  go.hidden = !button;
  go.disabled = false;
  cancel.hidden = !canCancel;
}

async function report(result: Record<string, unknown>): Promise<boolean> {
  try {
    const response = await fetch(`/result/${encodeURIComponent(state)}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(result),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const apiKey = params.get("apiKey") ?? "";
if (!/^[0-9a-f]{32}$/.test(state) || !apiKey) {
  show("This sign-in link has ended", `Go back to Akflix and choose Continue with ${label} again.`);
} else {
  const app = initializeApp({
    apiKey,
    authDomain: params.get("authDomain") ?? undefined,
    projectId: params.get("projectId") ?? undefined,
  });
  // In memory only: this browser keeps no Akflix session.
  const auth = initializeAuth(app, { persistence: inMemoryPersistence, popupRedirectResolver: browserPopupRedirectResolver });
  const emulator = params.get("emulator");
  if (emulator) connectAuthEmulator(auth, emulator, { disableWarnings: true });

  go.dataset.provider = providerId;
  // Apple's mark in the text colour; Google's "G" in its own colours (its sign-in branding asks for it).
  const svg = (name: string, attributes: Record<string, string>) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  };
  const mark = svg("svg", { width: "18", height: "18", "aria-hidden": "true" });
  if (providerId === "apple.com") {
    mark.setAttribute("viewBox", APPLE_MARK.viewBox);
    mark.setAttribute("fill", "currentColor");
    mark.appendChild(svg("path", { d: APPLE_MARK.path }));
  } else {
    mark.setAttribute("viewBox", GOOGLE_MARK.viewBox);
    for (const [fill, d] of GOOGLE_MARK.paths) mark.appendChild(svg("path", { fill, d }));
  }
  const text = document.createElement("span");
  text.textContent = `Continue with ${label}`;
  go.replaceChildren(mark, text);
  show("Sign in to Akflix", `Continue with ${label} to sign in on your Mac. Akflix never sees your ${label} password.`, { button: true, canCancel: true });

  go.addEventListener("click", async () => {
    go.disabled = true;
    const provider = providerId === "apple.com" ? new OAuthProvider("apple.com") : new GoogleAuthProvider();
    if (provider instanceof GoogleAuthProvider) provider.setCustomParameters({ prompt: "select_account" });
    else {
      provider.addScope("email");
      provider.addScope("name");
    }
    try {
      const result = await signInWithPopup(auth, provider);
      const user = result.user;
      const delivered = await report({
        status: "ok",
        providerId,
        uid: user.uid,
        email: user.email ?? "",
        idToken: await user.getIdToken(),
        refreshToken: user.refreshToken,
        expiresIn: 3600,
      });
      show(delivered ? "You're signed in" : "Akflix stopped waiting", delivered ? "Go back to Akflix. You can close this tab." : `Go back to Akflix and choose Continue with ${label} again.`);
    } catch (reason) {
      const error = reason as AuthError;
      const code = error?.code ?? "";
      if (code === "auth/account-exists-with-different-credential") {
        const credential =
          (providerId === "google.com" ? GoogleAuthProvider.credentialFromError(error) : OAuthProvider.credentialFromError(error))?.toJSON() as
            | Record<string, string | undefined>
            | undefined;
        await report({
          status: "exists",
          providerId,
          email: (error.customData as { email?: string } | undefined)?.email ?? "",
          credential: {
            idToken: credential?.idToken,
            accessToken: credential?.accessToken,
            nonce: credential?.nonce,
            pendingToken: credential?.pendingToken,
          },
        });
        show("You already have an account", "Go back to Akflix to finish. You can close this tab.");
      } else if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request" || code === "auth/user-cancelled") {
        show("Sign in to Akflix", `The ${label} window closed before you signed in. Try again, or cancel.`, { button: true, canCancel: true });
      } else if (code === "auth/popup-blocked") {
        show("Allow the sign-in window", `Your browser blocked the ${label} window. Allow pop-ups for this page, then try again.`, { button: true, canCancel: true });
      } else {
        await report({ status: "error", providerId, code });
        show("That didn't work", "Go back to Akflix to see what happened. You can close this tab.");
      }
    }
  });

  cancel.addEventListener("click", async () => {
    await report({ status: "cancelled" });
    show("Cancelled", "You can close this tab.");
  });
}
