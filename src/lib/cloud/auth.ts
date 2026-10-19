/**
 * Firebase Authentication over REST: email + password, and Apple / Google
 * credentials (signInWithIdp, the REST form of signInWithCredential). Works
 * the same against the real project and the Auth emulator.
 */
import type { CloudEnv } from "@/lib/cloud/env";
import { authError, CloudError, requestJson } from "@/lib/cloud/rest";

export type IdpProvider = "apple.com" | "google.com";
export type SignInMethod = "password" | IdpProvider;

export const METHOD_NAMES: Record<SignInMethod, string> = {
  password: "email",
  "apple.com": "Apple",
  "google.com": "Google",
};

export interface CloudSession {
  uid: string;
  email: string;
  idToken: string;
  refreshToken: string;
  /** Epoch ms when idToken stops being accepted. */
  expiresAt: number;
  /** CloudEnv.key the session belongs to. */
  env: string;
  /** How this device signed in (older sessions: email). */
  method?: SignInMethod;
  /** Set when this sign-in just created the account. */
  isNewUser?: boolean;
}

interface SignInResponse {
  localId: string;
  email: string;
  idToken: string;
  refreshToken: string;
  expiresIn: string;
}

/**
 * An Apple or Google sign-in to hand to Firebase: the provider's own token
 * (native flows), or the pending token Firebase returns when the credential
 * has to be linked to an existing account later.
 */
export interface IdpCredential {
  providerId: IdpProvider;
  idToken?: string;
  accessToken?: string;
  /** Apple: the unhashed nonce whose SHA-256 went into the request. */
  rawNonce?: string;
  pendingToken?: string;
}

/** accounts:signInWithIdp's answer (also what the browser flow hands back). */
export interface IdpResponse extends Partial<SignInResponse> {
  providerId?: string;
  needConfirmation?: boolean;
  pendingToken?: string;
  oauthIdToken?: string;
  oauthAccessToken?: string;
  nonce?: string;
  errorMessage?: string;
  isNewUser?: boolean;
}

/**
 * The email already has an Akflix account that signs in another way
 * (Firebase's auth/account-exists-with-different-credential). Signing in the
 * original way and then linking `pending` makes both work.
 */
export class AccountExistsError extends CloudError {
  constructor(
    public email: string,
    public pending: IdpCredential
  ) {
    super(
      "invalid",
      `${email ? `You already have an Akflix account with ${email}.` : "You already have an Akflix account with this email."} ` +
        `Sign in the way you did before, and ${METHOD_NAMES[pending.providerId]} will be added to it.`,
      "ACCOUNT_EXISTS_WITH_DIFFERENT_CREDENTIAL"
    );
    this.name = "AccountExistsError";
  }
}

interface RefreshResponse {
  id_token: string;
  refresh_token: string;
  expires_in: string;
  user_id: string;
}

export const NOT_SET_UP = "Sign-in is being set up. It will work after the next Akflix update.";

function requireEnv(env: CloudEnv) {
  if (env.mode === "unconfigured") throw new CloudError("setup", NOT_SET_UP, "UNCONFIGURED");
}

function session(env: CloudEnv, value: SignInResponse, method: SignInMethod): CloudSession {
  return {
    uid: value.localId,
    email: value.email ?? "",
    idToken: value.idToken,
    refreshToken: value.refreshToken,
    expiresAt: Date.now() + Number(value.expiresIn || 3600) * 1000,
    env: env.key,
    method,
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
  return session(env, value, "password");
}

export async function signIn(env: CloudEnv, email: string, password: string): Promise<CloudSession> {
  requireEnv(env);
  const value = await requestJson<SignInResponse>(`${env.authBase}/accounts:signInWithPassword?key=${encodeURIComponent(env.apiKey)}`, {
    json: { email: normalizeEmail(email), password, returnSecureToken: true },
  });
  return session(env, value, "password");
}

export function idpPostBody(credential: IdpCredential): string {
  const params = new URLSearchParams();
  if (credential.idToken) params.set("id_token", credential.idToken);
  if (credential.accessToken) params.set("access_token", credential.accessToken);
  if (credential.rawNonce) params.set("nonce", credential.rawNonce);
  params.set("providerId", credential.providerId);
  return params.toString();
}

/**
 * Turns a signInWithIdp answer into a session, or the matching error:
 * AccountExistsError when the email belongs to an account that signs in
 * another way, a plain CloudError for refusals Firebase reports in the body.
 */
export function sessionFromIdp(env: CloudEnv, value: IdpResponse, sent: IdpCredential): CloudSession {
  const providerId = (value.providerId === "apple.com" || value.providerId === "google.com" ? value.providerId : sent.providerId) as IdpProvider;
  if (value.errorMessage) {
    throw authError(value.errorMessage) ?? new CloudError("invalid", "That sign-in didn't go through. Try again.", value.errorMessage.split(/[ :]/)[0]);
  }
  if (value.needConfirmation || !value.idToken || !value.refreshToken || !value.localId) {
    if (!value.needConfirmation) throw new CloudError("server", "That sign-in didn't go through. Try again.", "NO_SESSION");
    const pending: IdpCredential = value.pendingToken
      ? { providerId, pendingToken: value.pendingToken }
      : {
          providerId,
          idToken: value.oauthIdToken ?? sent.idToken,
          accessToken: value.oauthAccessToken ?? sent.accessToken,
          rawNonce: value.nonce ?? sent.rawNonce,
        };
    throw new AccountExistsError(value.email ?? "", pending);
  }
  return { ...session(env, value as SignInResponse, providerId), ...(value.isNewUser ? { isNewUser: true } : {}) };
}

/**
 * Signs in with an Apple or Google credential (creating the account the first
 * time). With `linkTo` (a signed-in ID token) it adds the credential to that
 * account instead.
 */
export async function signInWithIdp(env: CloudEnv, credential: IdpCredential, linkTo?: string): Promise<CloudSession> {
  requireEnv(env);
  const body: Record<string, unknown> = { requestUri: "http://localhost", returnIdpCredential: true, returnSecureToken: true };
  if (credential.pendingToken) body.pendingToken = credential.pendingToken;
  else body.postBody = idpPostBody(credential);
  if (linkTo) body.idToken = linkTo;
  const value = await requestJson<IdpResponse>(`${env.authBase}/accounts:signInWithIdp?key=${encodeURIComponent(env.apiKey)}`, { json: body });
  return sessionFromIdp(env, value, credential);
}

/** The ways this account can sign in ("password", "apple.com", "google.com"). */
export async function signInMethods(env: CloudEnv, idToken: string): Promise<SignInMethod[]> {
  requireEnv(env);
  const value = await requestJson<{ users?: { providerUserInfo?: { providerId?: string }[]; passwordHash?: string }[] }>(
    `${env.authBase}/accounts:lookup?key=${encodeURIComponent(env.apiKey)}`,
    { json: { idToken } }
  );
  const user = value.users?.[0];
  const found = new Set<SignInMethod>();
  for (const info of user?.providerUserInfo ?? []) {
    if (info.providerId === "password" || info.providerId === "apple.com" || info.providerId === "google.com") found.add(info.providerId);
  }
  if (user?.passwordHash) found.add("password");
  return [...found];
}

/** Exchanges a refresh token for a fresh ID token (refresh tokens are long-lived). */
export async function refreshSession(env: CloudEnv, current: Pick<CloudSession, "refreshToken" | "email" | "method">): Promise<CloudSession> {
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
    ...(current.method ? { method: current.method } : {}),
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

/** Removes an account that a confirmation sign-in created by mistake (another Apple / Google account). */
export async function deleteUserIfNew(env: CloudEnv, session: CloudSession): Promise<void> {
  if (session.isNewUser) await deleteUser(env, session.idToken);
}

export function validateCredentials(email: string, password: string, creating: boolean): string | null {
  const clean = normalizeEmail(email);
  if (!clean) return "Enter your email address.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return "Enter a valid email address.";
  if (!password) return "Enter your password.";
  if (creating && password.length < 6) return "Use a password with at least 6 characters.";
  return null;
}
