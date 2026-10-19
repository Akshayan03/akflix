/**
 * Google sign-in in the system browser (no embedded web view): OAuth 2.0
 * authorization code + PKCE with the project's iOS client, then the ID token
 * goes to Firebase (GoogleAuthProvider.credential → signInWithIdp).
 */
import { CloudError, requestJson } from "@/lib/cloud/rest";

export const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 in plain JS: WebCrypto's subtle API only exists in secure contexts. */
export function sha256(bytes: Uint8Array): Uint8Array {
  const length = bytes.length;
  const padded = new Uint8Array(((length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000));
  view.setUint32(padded.length - 4, (length << 3) >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  h.forEach((word, index) => outView.setUint32(index * 4, word));
  return out;
}

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** URL-safe random string from the system's secure random source. */
export function randomToken(bytes = 32): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return base64Url(values);
}

export function pkceChallenge(verifier: string): string {
  return base64Url(sha256(new TextEncoder().encode(verifier)));
}

/** "123-abc.apps.googleusercontent.com" → "com.googleusercontent.apps.123-abc" (the iOS client's URL scheme). */
export function reversedClientId(clientId: string): string {
  return clientId.trim().split(".").reverse().join(".");
}

export interface GoogleAuthRequest {
  url: string;
  redirectUri: string;
  callbackScheme: string;
  state: string;
  verifier: string;
}

export function googleAuthRequest(clientId: string, loginHint = ""): GoogleAuthRequest {
  const callbackScheme = reversedClientId(clientId);
  const redirectUri = `${callbackScheme}:/oauth2redirect`;
  const verifier = randomToken(48);
  const state = randomToken(16);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
    state,
    prompt: "select_account",
  });
  if (loginHint) params.set("login_hint", loginHint);
  return { url: `${GOOGLE_AUTHORIZE}?${params}`, redirectUri, callbackScheme, state, verifier };
}

/** Reads the code from the redirect, or explains why there isn't one. Null means the person backed out. */
export function googleCodeFrom(callbackUrl: string, expectedState: string): string | null {
  let params: URLSearchParams;
  try {
    const url = new URL(callbackUrl);
    params = new URLSearchParams(url.search || url.hash.replace(/^#/, ""));
  } catch {
    throw new CloudError("invalid", "Google sign-in didn't go through. Try again.", "BAD_REDIRECT");
  }
  const error = params.get("error");
  if (error === "access_denied") return null;
  if (error) throw new CloudError("invalid", "Google sign-in didn't go through. Try again.", `GOOGLE_${error.toUpperCase()}`);
  if (params.get("state") !== expectedState) throw new CloudError("invalid", "Google sign-in didn't go through. Try again.", "STATE_MISMATCH");
  const code = params.get("code");
  if (!code) throw new CloudError("invalid", "Google sign-in didn't go through. Try again.", "NO_CODE");
  return code;
}

export async function exchangeGoogleCode(clientId: string, request: GoogleAuthRequest, code: string): Promise<{ idToken: string; accessToken?: string }> {
  try {
    const value = await requestJson<{ id_token?: string; access_token?: string }>(GOOGLE_TOKEN, {
      form: {
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: request.redirectUri,
        code_verifier: request.verifier,
      },
    });
    if (!value.id_token) throw new CloudError("invalid", "Google sign-in didn't go through. Try again.", "NO_ID_TOKEN");
    return { idToken: value.id_token, ...(value.access_token ? { accessToken: value.access_token } : {}) };
  } catch (reason) {
    if (reason instanceof CloudError && reason.kind !== "offline" && reason.code !== "NO_ID_TOKEN") {
      throw new CloudError("invalid", "Google sign-in didn't go through. Try again.", reason.code || "TOKEN_EXCHANGE");
    }
    throw reason;
  }
}
