/**
 * Where Akflix accounts live: the owner's Firebase project (config built in
 * at build time), the local Firebase Emulator Suite (development), or nowhere
 * yet. Never shown to people.
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
  /** <project>.firebaseapp.com: hosts the browser sign-in handler. */
  authDomain: string;
}

export const EMULATOR_PROJECT_ID = "demo-akflix";

function viteEnv(): Record<string, unknown> {
  try {
    return (import.meta as unknown as { env?: Record<string, unknown> }).env ?? {};
  } catch {
    return {};
  }
}

function production(apiKey: string, projectId: string, authDomain: string): CloudEnv {
  return {
    mode: "production",
    apiKey,
    projectId,
    authDomain: authDomain || `${projectId}.firebaseapp.com`,
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
    authDomain: `${host}:9099`,
  };
}

/**
 * Precedence: the emulator for development builds (or builds made with
 * VITE_AKFLIX_CLOUD=emulator), then the config built into the app.
 */
export function cloudEnv(): CloudEnv {
  const env = viteEnv();
  const wantsEmulator = env.VITE_AKFLIX_CLOUD === "emulator" || (env.DEV === true && env.VITE_AKFLIX_CLOUD !== "production");
  if (wantsEmulator) {
    const host = typeof env.VITE_AKFLIX_EMULATOR_HOST === "string" && env.VITE_AKFLIX_EMULATOR_HOST ? env.VITE_AKFLIX_EMULATOR_HOST : "127.0.0.1";
    return emulatorEnv(host);
  }
  if (FIREBASE_WEB_CONFIG.apiKey && FIREBASE_WEB_CONFIG.projectId) {
    return production(FIREBASE_WEB_CONFIG.apiKey, FIREBASE_WEB_CONFIG.projectId, FIREBASE_WEB_CONFIG.authDomain);
  }
  return {
    mode: "unconfigured",
    apiKey: "",
    projectId: "",
    authBase: "",
    tokenBase: "",
    firestoreBase: "",
    key: "unconfigured",
    authDomain: "",
  };
}
