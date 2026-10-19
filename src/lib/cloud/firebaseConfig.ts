/**
 * Akflix accounts: the project's public web config and sign-in client IDs,
 * built in at build time. Nothing here is a secret (who can read or write
 * what is enforced by cloud/firestore.rules in the Mac repo), but the values
 * stay out of git: `cloud/apply-config.py` in the Mac repo writes them to each
 * app's ignored `.env.local` from the console files.
 *
 * Without them, development builds use the local Firebase Emulator Suite and
 * release builds show the sign-in buttons with "Sign-in is being set up".
 */
function value(name: string): string {
  try {
    const env = (import.meta as unknown as { env?: Record<string, unknown> }).env ?? {};
    const found = env[name];
    return typeof found === "string" ? found.trim() : "";
  } catch {
    return "";
  }
}

export const FIREBASE_WEB_CONFIG = {
  apiKey: value("VITE_AKFLIX_FIREBASE_API_KEY"),
  authDomain: value("VITE_AKFLIX_FIREBASE_AUTH_DOMAIN"),
  projectId: value("VITE_AKFLIX_FIREBASE_PROJECT_ID"),
  appId: value("VITE_AKFLIX_FIREBASE_APP_ID"),
};

/** "iOS client for com.akshayan.akflix" (CLIENT_ID in GoogleService-Info.plist): Google sign-in on the iPhone. */
export const GOOGLE_IOS_CLIENT_ID = value("VITE_AKFLIX_GOOGLE_IOS_CLIENT_ID");
