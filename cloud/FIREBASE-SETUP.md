# Akflix accounts: console setup (project akflix-e491a)

Sign in with Apple, Google or email on the Mac and iPhone; the Roku signs in with a code approved from either.
The apps never show any of this: the config is built in at build time.

About 15 minutes of clicks. Everything stays on the free Spark plan: no card, no billing. Never click "Upgrade".
Nothing here is a password. Do **not** put passwords, the Apple `.p8` key or any token into this folder or chat.

When you're done, this folder should contain two files the builds read:

| File | What it is | Needed for |
|---|---|---|
| `firebase-web-config.json` | the web config block from step 1 | everything (Mac, iPhone, Roku) |
| `GoogleService-Info.plist` | the iPhone app file from step 3 | Continue with Google on the iPhone |

Folder: `/Volumes/Akflix 5/BuildCache/akflix-signin-20261019/`

---

## Part A: Firebase console (console.firebase.google.com → akflix-e491a)

### 1. Register the web app and copy its config (2 min)
1. Gear icon next to **Project Overview** → **Project settings** → **General** tab.
2. Under **Your apps**, click the **Web** icon `</>`.
3. Nickname **Akflix**. Leave **"Also set up Firebase Hosting" unchecked**. **Register app**.
4. Copy the whole `const firebaseConfig = { … };` block. Paste it into a new TextEdit file (Format → Make Plain
   Text) and save it in the folder above as **`firebase-web-config.json`**. Pasting it exactly as shown is fine;
   the build reads the JavaScript form too.
5. **Continue to console.**

### 2. Turn on the three sign-in methods (3 min)
**Build → Authentication → Get started → Sign-in method** tab.

1. **Email/Password** → switch on the **first** toggle only (leave "Email link" off) → **Save**.
2. **Add new provider → Google** → **Enable**.
   - **Public-facing name for project:** `Akflix` (this is the name Google's sign-in page shows).
   - **Support email for project:** your Gmail.
   - **Save**.
3. **Add new provider → Apple** → **Enable** → leave everything under "OAuth code flow configuration" empty for
   now → **Save**. (The iPhone doesn't need those fields; Part C fills them for the Mac.)

### 3. Register the iPhone app (2 min) — do this after step 2
1. **Project settings → General → Your apps → Add app → Apple** (the iOS+ icon).
2. **Apple bundle ID:** `com.akshayan.akflix` (exactly; the iPhone and Mac apps both use it).
   Nickname `Akflix iPhone`. Leave App Store ID empty. **Register app**.
3. **Download GoogleService-Info.plist** and save it into the folder above with that exact name.
4. Ignore the remaining "add the SDK / initialization code" pages: **Next, Next, Continue to console**.

Check: open the plist in TextEdit. It must contain a `CLIENT_ID` line ending in `.apps.googleusercontent.com`.
If it doesn't (Google was enabled after the download), download it again from **Project settings → General →
Your apps → Akflix iPhone → GoogleService-Info.plist** and replace the file.

Why this is needed: Apple's sign-in tokens name the app `com.akshayan.akflix`; Firebase only accepts them for a
registered Apple app. Google creates an iPhone sign-in client for it ("iOS client for com.akshayan.akflix (auto
created by Google Service)") whose ID is the plist's `CLIENT_ID`.

### 4. Create the database (2 min)
1. **Build → Firestore Database → Create database**.
2. Edition **Standard**. Database ID: leave `(default)`.
3. Location **northamerica-northeast2 (Toronto)** (or `nam5`). This can't be changed later.
4. **Start in production mode** → **Create**.
5. **Rules** tab → select everything → replace it with the whole of `~/Projects/akflixmac/cloud/firestore.rules`
   (open in TextEdit, Select All, Copy) → **Publish**.

### 5. Authentication settings (1 min, mostly checking)
**Authentication → Settings** tab.
- **User account linking:** keep **"Link accounts that use the same email"** (the default). This is what makes
  Apple, Google and email the same person.
- **Authorized domains:** make sure **`localhost`** and **`akflix-e491a.firebaseapp.com`** are listed (they are
  by default). The Mac's browser sign-in page runs on `localhost`; nothing to add.
- **User actions:** leave **"Enable create (sign-up)"** on for now. Turning it off later stops new accounts; the
  apps then say "New sign-ups are closed. Sign in with an existing account."
- Leave **Email enumeration protection** as it is (on).

---

## Part B: Google Cloud console

Nothing to do. Firebase creates both Google sign-in clients by itself in step 2 and 3. If you ever need the
iPhone client ID by hand: console.cloud.google.com → project akflix-e491a → **APIs & Services → Credentials →
OAuth 2.0 Client IDs → "iOS client for com.akshayan.akflix"** → Client ID. You can then write
`oauth-clients.json` instead of the plist:

```json
{ "iosClientId": "7864497382-xxxxxxxx.apps.googleusercontent.com" }
```

---

## Part C: Apple (developer.apple.com) — team ID M8A2365M7U

The Apple team ID is **M8A2365M7U** (it's the OU of your "Apple Development: akshayan.jeyakumar@gmail.com"
certificate; you can confirm it at developer.apple.com → Account → Membership details). "9J6HG9X236" in the
certificate's name is the certificate's own ID, not the team.

### C1. iPhone (probably nothing to do)
The iPhone build adds **Sign In with Apple** to the App ID `com.akshayan.akflix` through Xcode's automatic
signing. Only if that build reports that the profile lacks Sign in with Apple: developer.apple.com →
**Certificates, IDs & Profiles → Identifiers → com.akshayan.akflix** → tick **Sign In with Apple** → **Save**,
then tell the assistant to rebuild.

### C2. Mac: Apple sign-in in the browser (10 min; only needed for "Continue with Apple" on the Mac)
The Mac app is signed locally (ad hoc), which can't carry Apple's native sign-in entitlement, so on the Mac
"Continue with Apple" (and Google) finish in your web browser through Firebase's own sign-in page. Google needs
nothing more. Apple needs these four steps:

1. **Identifiers → + → Services IDs → Continue.**
   Description `Akflix Sign in`, Identifier **`com.akshayan.akflix.signin`** → **Continue → Register**.
2. Open **com.akshayan.akflix.signin** → tick **Sign In with Apple** → **Configure**:
   - Primary App ID: **com.akshayan.akflix**
   - Domains and Subdomains: **`akflix-e491a.firebaseapp.com`**
   - Return URLs: **`https://akflix-e491a.firebaseapp.com/__/auth/handler`**
   - **Next → Done → Continue → Save**.
3. **Keys → +**. Key name `Akflix Sign in with Apple`, tick **Sign in with Apple → Configure** → Primary App ID
   **com.akshayan.akflix** → **Save → Continue → Register → Download**. The `.p8` file downloads only once:
   keep it somewhere private (not this folder). Note the **Key ID** shown on that page.
4. Firebase console → **Authentication → Sign-in method → Apple → OAuth code flow configuration**:
   - Services ID: `com.akshayan.akflix.signin`
   - Apple team ID: `M8A2365M7U`
   - Key ID: the one from C2.3
   - Private key: open the `.p8` in TextEdit, copy everything (including the BEGIN/END lines), paste
   - **Save**.

No app rebuild is needed after Part C.

---

## Part D: build it into the apps

```sh
python3 -I ~/Projects/akflixmac/cloud/apply-config.py "/Volumes/Akflix 5/BuildCache/akflix-signin-20261019"
```

It writes each app's ignored `.env.local` (Mac, iPhone) and `akflix-roku/.cloud-config.json`, never anything in git.
Then rebuild the Mac and iPhone apps, and package the Roku with `sh package.sh` in akflix-roku.

## What each method needs, at a glance

| | iPhone | Mac | Roku |
|---|---|---|---|
| Email | steps 1, 2.1, 4 | same | — |
| Google | steps 1, 2.2, 3 (plist) | steps 1, 2.2 | — |
| Apple | steps 1, 2.3, 3 (+ C1 if asked) | steps 1, 2.3, C2 | — |
| Sign in with a code | — | — | step 1, 4 (approved from a signed-in iPhone or Mac) |
