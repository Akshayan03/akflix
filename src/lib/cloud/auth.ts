/**
 * Firebase Authentication over REST (email + password). Works the same
 * against the real project and the Auth emulator.
 */
import type { CloudEnv } from "@/lib/cloud/env";
import { CloudError, requestJson } from "@/lib/cloud/rest";

export interface CloudSession {
  uid: string;
  email: string;
  idToken: string;
  refreshToken: string;
  /** Epoch ms when idToken stops being accepted. */
  expiresAt: number;
  /** CloudEnv.key the session belongs to. */
  env: string;
}

interface SignInResponse {
  localId: string;
  email: string;
  idToken: string;
  refreshToken: string;
  expiresIn: string;
}

interface RefreshResponse {
  id_token: string;
  refresh_token: string;
  expires_in: string;
  user_id: string;
}

function requireEnv(env: CloudEnv) {
  if (env.mode === "unconfigured") throw new CloudError("setup", "Accounts aren't set up yet.", "UNCONFIGURED");
}

function session(env: CloudEnv, value: SignInResponse): CloudSession {
  return {
    uid: value.localId,
    email: value.email,
    idToken: value.idToken,
    refreshToken: value.refreshToken,
    expiresAt: Date.now() + Number(value.expiresIn || 3600) * 1000,
    env: env.key,
  };
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function signUp(env: CloudEnv, email: string, password: string): Promise<CloudSession> {
  requireEnv(env);
  const value = await requestJson<SignInResponse>(`${env.authBase}/accounts:signUp?key=${encodeURIComponent(env.apiKey)}`, {
    json: { email: normalizeEmail(email), password, returnSecureToken: true },
  });
  return session(env, value);
}

export async function signIn(env: CloudEnv, email: string, password: string): Promise<CloudSession> {
  requireEnv(env);
  const value = await requestJson<SignInResponse>(`${env.authBase}/accounts:signInWithPassword?key=${encodeURIComponent(env.apiKey)}`, {
    json: { email: normalizeEmail(email), password, returnSecureToken: true },
  });
  return session(env, value);
}

/** Exchanges a refresh token for a fresh ID token (refresh tokens are long-lived). */
export async function refreshSession(env: CloudEnv, current: Pick<CloudSession, "refreshToken" | "email">): Promise<CloudSession> {
  requireEnv(env);
  const value = await requestJson<RefreshResponse>(`${env.tokenBase}/token?key=${encodeURIComponent(env.apiKey)}`, {
    form: { grant_type: "refresh_token", refresh_token: current.refreshToken },
  });
  return {
    uid: value.user_id,
    email: current.email,
    idToken: value.id_token,
    refreshToken: value.refresh_token,
    expiresAt: Date.now() + Number(value.expires_in || 3600) * 1000,
    env: env.key,
  };
}

export async function sendPasswordReset(env: CloudEnv, email: string): Promise<void> {
  requireEnv(env);
  await requestJson(`${env.authBase}/accounts:sendOobCode?key=${encodeURIComponent(env.apiKey)}`, {
    json: { requestType: "PASSWORD_RESET", email: normalizeEmail(email) },
  });
}

/** Permanently deletes the Firebase user. Needs an ID token from a recent sign-in. */
export async function deleteUser(env: CloudEnv, idToken: string): Promise<void> {
  requireEnv(env);
  await requestJson(`${env.authBase}/accounts:delete?key=${encodeURIComponent(env.apiKey)}`, { json: { idToken } });
}

export function validateCredentials(email: string, password: string, creating: boolean): string | null {
  const clean = normalizeEmail(email);
  if (!clean) return "Enter your email address.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return "Enter a valid email address.";
  if (!password) return "Enter your password.";
  if (creating && password.length < 6) return "Use a password with at least 6 characters.";
  return null;
}
