import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountExistsError, sessionFromIdp } from "../src/lib/cloud/auth";
import { emulatorEnv } from "../src/lib/cloud/env";
import { CloudError } from "../src/lib/cloud/rest";
import { browserAnswer, signInPageUrl } from "../src/lib/cloud/providers";

const env = emulatorEnv();

test("Mac sign-in: the browser page gets its settings in the fragment, on localhost", () => {
  const url = new URL(signInPageUrl({ ...env, mode: "production", apiKey: "AIzaKey", projectId: "akflix-e491a", authDomain: "akflix-e491a.firebaseapp.com" }, "apple.com", 51234, "a".repeat(32)));
  assert.equal(url.origin, "http://localhost:51234", "localhost is an authorized sign-in domain by default");
  assert.equal(url.pathname, "/signin.html");
  assert.equal(url.search, "", "nothing in the query string reaches a server log");
  const params = new URLSearchParams(url.hash.slice(1));
  assert.equal(params.get("provider"), "apple.com");
  assert.equal(params.get("authDomain"), "akflix-e491a.firebaseapp.com");
  assert.equal(params.get("emulator"), null);
  assert.equal(new URLSearchParams(new URL(signInPageUrl(env, "google.com", 1, "b".repeat(32))).hash.slice(1)).get("emulator"), "http://127.0.0.1:9099");
});

test("Mac sign-in: the page's answers become the same results as the native sheets", () => {
  const ok = browserAnswer({ status: "ok", providerId: "google.com", uid: "u1", email: "me@x.co", idToken: "id", refreshToken: "rt", expiresIn: 3600 }, "google.com");
  assert.equal(ok.kind, "response");
  const session = sessionFromIdp(env, (ok as { response: Record<string, unknown> }).response, { providerId: "google.com" });
  assert.deepEqual({ uid: session.uid, method: session.method, refreshToken: session.refreshToken }, { uid: "u1", method: "google.com", refreshToken: "rt" });
  const created = browserAnswer({ status: "ok", providerId: "apple.com", uid: "u2", idToken: "id", refreshToken: "rt", isNewUser: true }, "apple.com");
  assert.equal(sessionFromIdp(env, (created as { response: Record<string, unknown> }).response, { providerId: "apple.com" }).isNewUser, true, "so a mistaken delete confirmation can remove it");

  const exists = browserAnswer({ status: "exists", providerId: "apple.com", email: "me@x.co", credential: { pendingToken: "pt" } }, "apple.com");
  assert.throws(
    () => sessionFromIdp(env, (exists as { response: Record<string, unknown> }).response, { providerId: "apple.com" }),
    (error: unknown) => error instanceof AccountExistsError && error.email === "me@x.co" && error.pending.pendingToken === "pt"
  );

  assert.deepEqual(browserAnswer({ status: "cancelled" }, "apple.com"), { kind: "cancelled" });
  assert.deepEqual(browserAnswer({ status: "error", code: "auth/popup-closed-by-user" }, "apple.com"), { kind: "cancelled" });
  assert.throws(() => browserAnswer({ status: "error", code: "auth/admin-restricted-operation" }, "google.com"), /New sign-ups are closed/);
  assert.throws(() => browserAnswer({ status: "error", code: "auth/network-request-failed" }, "google.com"), (error: CloudError) => error.kind === "offline");
  assert.throws(() => browserAnswer({ status: "error", code: "auth/unauthorized-domain" }, "google.com"), (error: CloudError) => error.kind === "setup" && !/firebase|domain/i.test(error.message));
  assert.throws(() => browserAnswer({ status: "ok", uid: "u1" }, "google.com"), /didn't go through/, "an answer without a session is refused");
});
