# Akflix accounts: the 5-minute Firebase setup

Akflix accounts (one sign-in for Mac, iPhone and Roku, with Continue Watching, the exact episode and minute, watched
titles, My List, ratings and playback preferences in sync) use **your own free Firebase project**. Everything below
stays on the free **Spark** plan: no card, no billing. Don't click "Upgrade".

Until you do this, the apps work exactly as before and the account screens say **"Accounts not set up yet"**.

## 1. Create the project (1 min)

1. Open <https://console.firebase.google.com> and sign in with your Google account.
2. **Create a project** (or "Get started by setting up a Firebase project").
3. Name it `akflix` (any name works). Continue.
4. Turn **off** "Enable Google Analytics for this project" (not needed). **Create project**, then **Continue**.

## 2. Turn on email + password sign-in (1 min)

1. Left sidebar: **Build → Authentication** → **Get started**.
2. **Sign-in method** tab → **Email/Password**.
3. Switch on the **first** toggle (Email/Password). Leave "Email link (passwordless sign-in)" off. **Save**.

## 3. Create the database in production mode (1 min)

1. Left sidebar: **Build → Firestore Database** → **Create database**.
2. Edition: **Standard** if asked. Database ID: leave `(default)`.
3. Location: **northamerica-northeast2 (Toronto)** (or `nam5`). This can't be changed later; any location works.
4. Choose **Start in production mode** → **Create**.

## 4. Paste the security rules (1 min)

1. In Firestore Database, open the **Rules** tab.
2. Select everything in the editor and replace it with the whole contents of
   `~/Projects/akflixmac/cloud/firestore.rules` (open it in TextEdit, Select All, Copy).
3. **Publish**.

These rules let each signed-in person read and write only their own data (`/users/{their id}/…`), and let a TV
show a short sign-in code that only a signed-in phone or Mac can approve. Everything else is refused. They were
tested against the Firebase emulator (other accounts and anonymous callers are rejected; codes can't be listed,
reused, hijacked or kept alive longer than 15 minutes).

## 5. Copy the web config (1 min)

1. Click the **gear** next to "Project Overview" → **Project settings** → **General** tab.
2. Under **Your apps**, click the **Web** icon (`</>`).
3. App nickname `Akflix`. Leave "Also set up Firebase Hosting" **unchecked**. **Register app**.
4. You'll see a block like this. Copy the whole `firebaseConfig = { … }` part:

   ```js
   const firebaseConfig = {
     apiKey: "AIza…",
     authDomain: "akflix-xxxx.firebaseapp.com",
     projectId: "akflix-xxxx",
     storageBucket: "…",
     messagingSenderId: "…",
     appId: "1:…:web:…"
   };
   ```

   These values only name your project; they aren't passwords. The rules from step 4 are what protect your data.

## 6. Give it to the apps

**Fastest (no rebuild), iPhone and Mac:** open **Settings → Akflix account → Paste Firebase config**, paste the
block, tap **Use this project**, then **Create account** with your email and a password (6+ characters). Do the same
paste on the other device and **Sign in** there with the same email and password.

**Built in, and needed for the Roku:** save the block to a file (for example `~/Desktop/firebase.txt`) and run

```sh
python3 -I ~/Projects/akflixmac/cloud/apply-config.py ~/Desktop/firebase.txt
```

It writes the config into all three apps (`src/lib/cloud/firebaseConfig.ts` in the Mac and iPhone repos,
`components/lib/AkflixCloudConfig.brs` in the Roku repo). Rebuild them; the Roku zip then needs your usual
sideload (Developer Mode installer, `rokudev` password).

**Roku sign-in:** on the TV, Settings (✱) → move right to **Akflix account** → **Sign in with a code**. On your
iPhone or Mac: Settings → Akflix account → **Sign in on your TV**, type the 8-character code, **Continue**,
**Sign in TV**. No typing on the TV remote.

## Good to know

- First sign-in on each device **adds** what's already on that device to the account; nothing local is wiped.
  Signing out keeps a local copy. Account deletion is in Settings → Akflix account → Delete account (asks for your
  password, removes everything synced, keeps each device's local copy).
- Free-plan limits (50,000 reads and 20,000 writes per day) are far above what a household uses: roughly one read
  per device every minute and a half while the app is open, and about two writes per minute while something plays.
- Forgot the password? **Forgot password?** on the sign-in screen sends Firebase's reset email.
- Optional hardening later: Authentication → Settings → **Password policy**; Google Cloud console → APIs &
  Services → Credentials → restrict the browser API key to the Identity Toolkit, Token Service and Cloud Firestore
  APIs.
