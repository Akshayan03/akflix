/**
 * ===========================================================================
 *  AKFLIX ACCOUNTS: FIREBASE WEB CONFIG  (the one file to edit for accounts)
 * ===========================================================================
 *
 *  Paste the web app config from the Firebase console:
 *  Project settings → General → Your apps → (Web app) → SDK setup and
 *  configuration → Config. Only `apiKey` and `projectId` are required.
 *
 *  These values identify the project; they are not secrets. Who can read or
 *  write what is enforced by the Firestore rules (cloud/firestore.rules in the
 *  akflix Mac repo).
 *
 *  While `apiKey` or `projectId` is empty:
 *  - development builds (`npm run dev`) use the local Firebase Emulator Suite;
 *  - release builds show "Accounts not set up yet", unless a config was pasted
 *    in the app (Profile → Akflix account → Set up accounts).
 * ===========================================================================
 */
export const FIREBASE_WEB_CONFIG = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  appId: "",
};
