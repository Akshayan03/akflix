/**
 * Small JSON-over-HTTP layer for the Firebase REST APIs. Uses the app's
 * fetch (the Tauri HTTP plugin in the app, window.fetch in a browser) and
 * turns every failure into a CloudError with a human sentence.
 */
import { httpRaw } from "@/lib/http";

export type CloudErrorKind = "offline" | "auth" | "conflict" | "denied" | "setup" | "invalid" | "server";

export class CloudError extends Error {
  constructor(
    public kind: CloudErrorKind,
    message: string,
    public code = "",
    public status = 0
  ) {
    super(message);
    this.name = "CloudError";
  }
}

// People read these, so they never mention the backend, projects or configs.
const BEING_SET_UP = "Sign-in is being set up. Try again after the next Akflix update.";
const DID_NOT_GO_THROUGH = "That sign-in didn't go through. Try again.";
const AUTH_MESSAGES: Record<string, [CloudErrorKind, string]> = {
  EMAIL_EXISTS: ["invalid", "An account already uses this email. Sign in instead, with your password or with Apple or Google if that's how you joined."],
  EMAIL_NOT_FOUND: ["invalid", "Email or password is incorrect."],
  INVALID_PASSWORD: ["invalid", "Email or password is incorrect."],
  INVALID_LOGIN_CREDENTIALS: ["invalid", "Email or password is incorrect. If you joined with Apple or Google, use that button instead."],
  INVALID_EMAIL: ["invalid", "Enter a valid email address."],
  MISSING_EMAIL: ["invalid", "Enter your email address."],
  MISSING_PASSWORD: ["invalid", "Enter your password."],
  WEAK_PASSWORD: ["invalid", "Use a password with at least 6 characters."],
  USER_DISABLED: ["auth", "This account has been turned off."],
  TOO_MANY_ATTEMPTS_TRY_LATER: ["invalid", "Too many attempts. Wait a minute and try again."],
  RESET_PASSWORD_EXCEED_LIMIT: ["invalid", "Too many reset emails. Wait a while and try again."],
  // Sign-ups switched off for the project (Authentication → Settings → User actions).
  ADMIN_ONLY_OPERATION: ["invalid", "New sign-ups are closed. Sign in with an account that already exists."],
  OPERATION_NOT_ALLOWED: ["setup", "This way of signing in isn't available yet. Try another one."],
  PASSWORD_LOGIN_DISABLED: ["setup", "Signing in with email isn't available yet. Try Apple or Google."],
  CONFIGURATION_NOT_FOUND: ["setup", BEING_SET_UP],
  API_KEY_INVALID: ["setup", BEING_SET_UP],
  INVALID_IDP_RESPONSE: ["invalid", DID_NOT_GO_THROUGH],
  MISSING_OR_INVALID_NONCE: ["invalid", DID_NOT_GO_THROUGH],
  INVALID_PENDING_TOKEN: ["invalid", DID_NOT_GO_THROUGH],
  INVALID_CREDENTIAL_OR_PROVIDER_ID: ["invalid", DID_NOT_GO_THROUGH],
  FEDERATED_USER_ID_ALREADY_LINKED: ["invalid", "That account already belongs to a different Akflix account."],
  TOKEN_EXPIRED: ["auth", "Your session ended. Sign in again."],
  INVALID_REFRESH_TOKEN: ["auth", "Your session ended. Sign in again."],
  INVALID_ID_TOKEN: ["auth", "Your session ended. Sign in again."],
  USER_NOT_FOUND: ["auth", "This account no longer exists."],
  CREDENTIAL_TOO_OLD_LOGIN_AGAIN: ["auth", "Confirm it's you again to continue."],
};

/** Turns an auth error code such as "EMAIL_EXISTS : details" into a CloudError. */
export function authError(raw: string, status = 0): CloudError | null {
  const code = raw.split(/[ :]/)[0];
  // An Apple or Google token for an app the project doesn't know yet.
  if (code === "INVALID_IDP_RESPONSE" && /audience|client id|not enabled/i.test(raw)) return new CloudError("setup", BEING_SET_UP, code, status);
  const known = AUTH_MESSAGES[code];
  return known ? new CloudError(known[0], known[1], code, status) : null;
}

function describe(status: number, body: unknown): CloudError {
  const error = (body as { error?: { message?: string; status?: string; code?: number } } | null)?.error;
  const raw = String(error?.message ?? "");
  // Auth errors look like "WEAK_PASSWORD : Password should be at least 6 characters".
  const known = authError(raw || String(error?.status ?? ""), status);
  if (known) return known;
  if (/API key not valid|API_KEY/.test(raw)) return new CloudError("setup", BEING_SET_UP, "API_KEY_INVALID", status);
  const grpc = String(error?.status ?? "");
  const missingDatabase = /does not exist for project|database .*does not exist|datastore mode|not been used in project|Cloud Firestore API/i;
  const syncNotReady = "Syncing isn't ready yet. Akflix keeps everything on this device and retries.";
  if (grpc === "FAILED_PRECONDITION" || grpc === "ABORTED" || grpc === "ALREADY_EXISTS" || status === 409) {
    if (missingDatabase.test(raw)) return new CloudError("setup", syncNotReady, grpc, status);
    if (/requires an index/i.test(raw)) return new CloudError("setup", syncNotReady, grpc, status);
    return new CloudError("conflict", "Another device changed this at the same time.", grpc, status);
  }
  if (grpc === "NOT_FOUND" || status === 404) {
    if (missingDatabase.test(raw)) return new CloudError("setup", syncNotReady, grpc, status);
    return new CloudError("conflict", "That item no longer exists.", grpc || "NOT_FOUND", status);
  }
  if (grpc === "PERMISSION_DENIED" || status === 403) {
    if (/has not been used|is disabled|SERVICE_DISABLED/i.test(raw)) {
      return new CloudError("setup", syncNotReady, grpc, status);
    }
    return new CloudError("denied", "Akflix wasn't allowed to do that.", grpc || "PERMISSION_DENIED", status);
  }
  if (grpc === "UNAUTHENTICATED" || status === 401) return new CloudError("auth", "Your session ended. Sign in again.", grpc || "UNAUTHENTICATED", status);
  if (status === 400) return new CloudError("invalid", raw || "The request wasn't accepted.", grpc || "INVALID_ARGUMENT", status);
  return new CloudError("server", status >= 500 ? "The account service is having trouble. Akflix will retry." : raw || `HTTP ${status}`, grpc, status);
}

export interface JsonRequest {
  method?: string;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  timeoutMs?: number;
}

export async function requestJson<T>(url: string, init: JsonRequest = {}): Promise<T> {
  const headers: Record<string, string> = { ...init.headers };
  let body: string | undefined;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  } else if (init.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(init.form).toString();
  }
  const controller = typeof AbortController === "undefined" ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), init.timeoutMs ?? 20_000) : null;
  let response: Response;
  try {
    response = await httpRaw(url, { method: init.method ?? (body ? "POST" : "GET"), headers, body, signal: controller?.signal });
  } catch (reason) {
    throw new CloudError("offline", "You're offline. Changes stay on this device and sync later.", reason instanceof Error ? reason.name : "NETWORK");
  } finally {
    if (timer) clearTimeout(timer);
  }
  const text = await response.text().catch(() => "");
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) throw describe(response.status, parsed ?? { error: { message: text.slice(0, 200) } });
  return parsed as T;
}
