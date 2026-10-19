import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AccountExistsError,
  idpPostBody,
  sessionFromIdp,
  signInWithIdp,
  signUp,
  NOT_SET_UP,
} from "../src/lib/cloud/auth";
import { authError, CloudError } from "../src/lib/cloud/rest";
import { emulatorEnv } from "../src/lib/cloud/env";
import { base64Url, googleAuthRequest, googleCodeFrom, pkceChallenge, reversedClientId, sha256 } from "../src/lib/cloud/oauth";
import { cloudSignIn, cloudSignInWithProvider } from "../src/lib/cloud/engine";

const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const env = emulatorEnv();

async function withFetch<T>(reply: (url: string, init: RequestInit) => { status?: number; body: unknown }, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const { status = 200, body } = reply(String(input), init);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

test("sign-in: SHA-256 and PKCE match the published test vectors", () => {
  assert.equal(hex(sha256(new Uint8Array())), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(hex(sha256(new TextEncoder().encode("abc"))), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const long = new TextEncoder().encode("a".repeat(1000));
  assert.equal(hex(sha256(long)), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
  // RFC 7636 appendix B.
  assert.equal(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  assert.equal(base64Url(new Uint8Array([251, 255, 191])), "-_-_");
});

test("sign-in: Google runs in the system browser with PKCE and the iOS client's redirect", () => {
  const clientId = "7864497382-abc123def.apps.googleusercontent.com";
  assert.equal(reversedClientId(clientId), "com.googleusercontent.apps.7864497382-abc123def");
  const request = googleAuthRequest(clientId);
  const url = new URL(request.url);
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("client_id"), clientId);
  assert.equal(url.searchParams.get("redirect_uri"), "com.googleusercontent.apps.7864497382-abc123def:/oauth2redirect");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), pkceChallenge(request.verifier));
  assert.ok(request.verifier.length >= 43 && request.verifier.length <= 128, "RFC 7636 verifier length");
  assert.equal(request.callbackScheme, "com.googleusercontent.apps.7864497382-abc123def");
  assert.notEqual(googleAuthRequest(clientId).state, request.state, "every attempt gets its own state");

  const back = `${request.redirectUri}?state=${request.state}&code=4/0Ab-xyz&scope=email`;
  assert.equal(googleCodeFrom(back, request.state), "4/0Ab-xyz");
  assert.equal(googleCodeFrom(`${request.redirectUri}?error=access_denied&state=${request.state}`, request.state), null, "backing out is a cancel");
  assert.throws(() => googleCodeFrom(`${request.redirectUri}?state=forged&code=x`, request.state), /didn't go through/);
  assert.throws(() => googleCodeFrom(`${request.redirectUri}?error=invalid_client`, request.state), (error: CloudError) => error.code === "GOOGLE_INVALID_CLIENT");
});

test("sign-in: Apple's token and raw nonce go to Firebase as signInWithIdp's postBody", () => {
  const body = new URLSearchParams(idpPostBody({ providerId: "apple.com", idToken: "eyJ.apple.jwt", rawNonce: "n0nce-._" }));
  assert.equal(body.get("id_token"), "eyJ.apple.jwt");
  assert.equal(body.get("nonce"), "n0nce-._");
  assert.equal(body.get("providerId"), "apple.com");
  const google = new URLSearchParams(idpPostBody({ providerId: "google.com", idToken: "g.jwt", accessToken: "ya29" }));
  assert.equal(google.get("access_token"), "ya29");
  assert.equal(google.get("nonce"), null);
});

test("sign-in: Firebase answers become a session, an account-exists prompt or a plain error", () => {
  const ok = sessionFromIdp(env, { providerId: "google.com", localId: "u1", email: "a@b.co", idToken: "id", refreshToken: "rt", expiresIn: "3600", isNewUser: true }, { providerId: "google.com" });
  assert.deepEqual({ uid: ok.uid, method: ok.method, isNewUser: ok.isNewUser, env: ok.env }, { uid: "u1", method: "google.com", isNewUser: true, env: env.key });

  const exists = () =>
    sessionFromIdp(env, { providerId: "apple.com", email: "me@x.co", needConfirmation: true, oauthIdToken: "apple-token" }, { providerId: "apple.com", idToken: "apple-token", rawNonce: "raw" });
  assert.throws(exists, (error: unknown) => {
    assert.ok(error instanceof AccountExistsError);
    assert.equal(error.code, "ACCOUNT_EXISTS_WITH_DIFFERENT_CREDENTIAL");
    assert.equal(error.email, "me@x.co");
    assert.deepEqual(error.pending, { providerId: "apple.com", idToken: "apple-token", accessToken: undefined, rawNonce: "raw" });
    assert.match(error.message, /already have an Akflix account with me@x\.co.*Sign in the way you did before, and Apple will be added/);
    return true;
  });
  // The real service may hand back a pending token instead of the provider's token.
  assert.throws(
    () => sessionFromIdp(env, { providerId: "google.com", email: "me@x.co", needConfirmation: true, pendingToken: "pt" }, { providerId: "google.com", idToken: "g" }),
    (error: unknown) => error instanceof AccountExistsError && error.pending.pendingToken === "pt" && !error.pending.idToken
  );
  assert.throws(
    () => sessionFromIdp(env, { errorMessage: "FEDERATED_USER_ID_ALREADY_LINKED" }, { providerId: "google.com" }),
    /already belongs to a different Akflix account/
  );
});

test("sign-in: linking sends the signed-in token with the waiting credential", async () => {
  let sent: Record<string, unknown> = {};
  await withFetch(
    (_url, init) => {
      sent = JSON.parse(String(init.body));
      return { body: { localId: "u1", email: "me@x.co", idToken: "id2", refreshToken: "rt2", expiresIn: "3600", providerId: "apple.com" } };
    },
    () => signInWithIdp(env, { providerId: "apple.com", pendingToken: "pt" }, "current-id-token")
  );
  assert.equal(sent.idToken, "current-id-token");
  assert.equal(sent.pendingToken, "pt");
  assert.equal(sent.postBody, undefined);
  assert.equal(sent.returnIdpCredential, true);
});

test("sign-in: closed sign-ups and other refusals read plainly", async () => {
  const closed = await withFetch(
    () => ({ status: 400, body: { error: { code: 400, message: "ADMIN_ONLY_OPERATION" } } }),
    () => signUp(env, "new@x.co", "secret-pass").catch((error) => error)
  );
  assert.ok(closed instanceof CloudError);
  assert.equal(closed.code, "ADMIN_ONLY_OPERATION");
  assert.equal(closed.message, "New sign-ups are closed. Sign in with an account that already exists.");
  const viaIdp = await withFetch(
    () => ({ status: 400, body: { error: { code: 400, message: "ADMIN_ONLY_OPERATION" } } }),
    () => signInWithIdp(env, { providerId: "google.com", idToken: "g" }).catch((error) => error)
  );
  assert.match(viaIdp.message, /New sign-ups are closed/);
  assert.equal(authError("INVALID_IDP_RESPONSE : The audience in ID Token [com.akshayan.akflix] does not match the expected audience.")?.kind, "setup");
  assert.equal(authError("OPERATION_NOT_ALLOWED : The identity provider configuration is not found.")?.message, "This way of signing in isn't available yet. Try another one.");
});

test("sign-in: nothing a person reads mentions Firebase, projects or configs", () => {
  const codes = [
    "EMAIL_EXISTS", "INVALID_LOGIN_CREDENTIALS", "ADMIN_ONLY_OPERATION", "OPERATION_NOT_ALLOWED", "PASSWORD_LOGIN_DISABLED",
    "CONFIGURATION_NOT_FOUND", "API_KEY_INVALID", "INVALID_IDP_RESPONSE", "FEDERATED_USER_ID_ALREADY_LINKED", "USER_DISABLED",
  ];
  const developerWords = /firebase|firestore|project|config|api key|emulator|rules/i;
  for (const code of codes) assert.doesNotMatch(authError(code)?.message ?? "", developerWords, code);
  assert.doesNotMatch(NOT_SET_UP, developerWords);
  for (const file of ["src/pages/Account.tsx", "src/components/AccountEntry.tsx"]) {
    const source = readFileSync(resolve(process.cwd(), file), "utf8");
    const visible = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*|import )/.test(line))
      .join("\n")
      // JSX text and string literals only.
      .match(/>[^<>{}]+<|"[^"]*"|`[^`]*`/g) ?? [];
    for (const text of visible) assert.doesNotMatch(text, /firebase|firestore|\bpaste\b|\bconfig\b|\bproject\b/i, `${file}: ${text}`);
  }
});

test("sign-in: without a built-in config the buttons explain sign-in is being set up", async () => {
  await assert.rejects(cloudSignIn("me@x.co", "secret-pass"), (error: CloudError) => error.code === "UNCONFIGURED" && error.message === NOT_SET_UP);
  await assert.rejects(
    cloudSignInWithProvider("apple.com", async () => assert.fail("no native sheet without a config")),
    (error: CloudError) => error.message === NOT_SET_UP
  );
});
