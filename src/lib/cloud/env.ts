/**
 * Where Akflix accounts live: the owner's Firebase project, the local
 * Firebase Emulator Suite (development), or nowhere yet.
 */
import { FIREBASE_WEB_CONFIG } from "@/lib/cloud/firebaseConfig";

export type CloudMode = "production" | "emulator" | "unconfigured";

export interface CloudEnv {
  mode: CloudMode;
  apiKey: string;
  projectId: string;
  /** identitytoolkit.googleapis.com/v1 (or the emulator's copy). */
  authBase: string;
  /** securetoken.googleapis.com/v1 (or the emulator's copy). */
  tokenBase: string;
  /** firestore.googleapis.com/v1 (or the emulator). */
  firestoreBase: string;
  /** Sessions only stay valid inside the environment that issued them. */
  key: string;
}

export interface PastedFirebaseConfig {
  apiKey: string;
  projectId: string;
  authDomain?: string;
  appId?: string;
}

const PASTED_CONFIG_KEY = "akflix.cloud.config";
export const EMULATOR_PROJECT_ID = "demo-akflix";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function viteEnv(): Record<string, unknown> {
  try {
    return (import.meta as unknown as { env?: Record<string, unknown> }).env ?? {};
  } catch {
    return {};
  }
}

/** Accepts the console's JS snippet, plain JSON, or just "key: value" lines. */
export function parseFirebaseConfig(text: string): PastedFirebaseConfig | null {
  const pick = (name: string) => {
    const match = text.match(new RegExp(`["']?${name}["']?\\s*[:=]\\s*["']([^"']+)["']`));
    return match?.[1]?.trim() ?? "";
  };
  const apiKey = pick("apiKey");
  const projectId = pick("projectId");
  if (!/^[A-Za-z0-9_-]{20,}$/.test(apiKey) || !/^[a-z0-9-]{4,40}$/.test(projectId)) return null;
  const authDomain = pick("authDomain");
  const appId = pick("appId");
  return { apiKey, projectId, ...(authDomain ? { authDomain } : {}), ...(appId ? { appId } : {}) };
}

export function pastedFirebaseConfig(): PastedFirebaseConfig | null {
  const raw = storage()?.getItem(PASTED_CONFIG_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as PastedFirebaseConfig;
    return value.apiKey && value.projectId ? value : null;
  } catch {
    return null;
  }
}

export function savePastedFirebaseConfig(config: PastedFirebaseConfig | null) {
  const store = storage();
  if (!store) return;
  if (config) store.setItem(PASTED_CONFIG_KEY, JSON.stringify(config));
  else store.removeItem(PASTED_CONFIG_KEY);
}

function production(apiKey: string, projectId: string): CloudEnv {
  return {
    mode: "production",
    apiKey,
    projectId,
    authBase: "https://identitytoolkit.googleapis.com/v1",
    tokenBase: "https://securetoken.googleapis.com/v1",
    firestoreBase: "https://firestore.googleapis.com/v1",
    key: `production:${projectId}`,
  };
}

export function emulatorEnv(host = "127.0.0.1"): CloudEnv {
  return {
    mode: "emulator",
    apiKey: "demo-akflix-emulator-key",
    projectId: EMULATOR_PROJECT_ID,
    authBase: `http://${host}:9099/identitytoolkit.googleapis.com/v1`,
    tokenBase: `http://${host}:9099/securetoken.googleapis.com/v1`,
    firestoreBase: `http://${host}:8180/v1`,
    key: `emulator:${host}`,
  };
}

/**
 * Precedence: a config pasted in the app, then the emulator for development
 * builds (or builds made with VITE_AKFLIX_CLOUD=emulator), then the config file.
 */
export function cloudEnv(): CloudEnv {
  const pasted = pastedFirebaseConfig();
  if (pasted) return production(pasted.apiKey, pasted.projectId);
  const env = viteEnv();
  const wantsEmulator = env.VITE_AKFLIX_CLOUD === "emulator" || (env.DEV === true && env.VITE_AKFLIX_CLOUD !== "production");
  if (wantsEmulator) {
    const host = typeof env.VITE_AKFLIX_EMULATOR_HOST === "string" && env.VITE_AKFLIX_EMULATOR_HOST ? env.VITE_AKFLIX_EMULATOR_HOST : "127.0.0.1";
    return emulatorEnv(host);
  }
  if (FIREBASE_WEB_CONFIG.apiKey && FIREBASE_WEB_CONFIG.projectId) {
    return production(FIREBASE_WEB_CONFIG.apiKey, FIREBASE_WEB_CONFIG.projectId);
  }
  return {
    mode: "unconfigured",
    apiKey: "",
    projectId: "",
    authBase: "",
    tokenBase: "",
    firestoreBase: "",
    key: "unconfigured",
  };
}
