// End-to-end account sync against the Firebase Local Emulator Suite.
//
// Each simulated device is a worker thread running the real stores and sync
// engine with its own storage and its own network switch. Start the
// emulators first (Auth :9099, Firestore :8180, project demo-akflix, rules
// from akflixmac/cloud/firestore.rules), then: node scripts/test-cloud-e2e.mjs
import { build } from "esbuild";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { test, after } from "node:test";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const AUTH = "http://127.0.0.1:9099";
const FIRESTORE = "http://127.0.0.1:8180/v1";
const DOCS = "projects/demo-akflix/databases/(default)/documents";

// The second device can come from the other app's checkout (AKFLIX_PEER_ROOT),
// so the iPhone and Mac builds are tested against each other.
const peerRoot = process.env.AKFLIX_PEER_ROOT ? resolve(process.env.AKFLIX_PEER_ROOT) : root;
async function deviceBundle(appRoot) {
  const bundle = await build({
    absWorkingDir: appRoot,
    entryPoints: ["tests/cloud/device.ts"],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "error",
    define: { "import.meta.env": JSON.stringify({ DEV: true, VITE_AKFLIX_CLOUD: "emulator" }) },
    plugins: [{
      name: "native-test-bridge",
      setup(builder) {
        builder.onResolve({ filter: /^@tauri-apps\/(api\/core|plugin-http)$/ }, (args) => ({ path: args.path, namespace: "test" }));
        builder.onLoad({ filter: /.*/, namespace: "test" }, (args) => ({
          contents: args.path.endsWith("plugin-http")
            ? "export const fetch = (...args) => globalThis.fetch(...args);"
            : "export const invoke = async () => null;",
        }));
      },
    }],
  });
  return bundle.outputFiles[0].text;
}
const deviceCode = await deviceBundle(root);
const peerCode = peerRoot === root ? deviceCode : await deviceBundle(peerRoot);

const workers = [];
function device(name, code = deviceCode) {
  const worker = new Worker(code, { eval: true });
  workers.push(worker);
  let next = 0;
  const waiting = new Map();
  worker.on("message", ({ id, ok, result, error }) => {
    const pending = waiting.get(id);
    waiting.delete(id);
    if (ok) pending.resolve(result);
    else pending.reject(Object.assign(new Error(`${name}: ${error.message}`), error));
  });
  worker.on("error", (error) => {
    for (const pending of waiting.values()) pending.reject(error);
  });
  const call = (cmd, ...args) =>
    new Promise((resolvePromise, reject) => {
      const id = ++next;
      waiting.set(id, { resolve: resolvePromise, reject });
      worker.postMessage({ id, cmd, args });
    });
  return new Proxy({}, { get: (_, cmd) => (...args) => call(cmd, ...args) });
}
after(() => Promise.all(workers.map((worker) => worker.terminate())));

const tick = () => new Promise((done) => setTimeout(done, 15));

async function rest(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    body: init.json === undefined ? init.body : JSON.stringify(init.json),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
const asOwner = { Authorization: "Bearer owner" }; // emulator-only rules bypass, for checking results
async function signUpRaw(email) {
  const { body } = await rest(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo`, {
    method: "POST",
    json: { email, password: "secret-pass", returnSecureToken: true },
  });
  return body;
}

const stamp = Date.now().toString(36);
const email = `akshayan+${stamp}@example.com`;
const password = "popcorn-42";
const got = { source: "discover", id: "tt0944947", type: "series", name: "Game of Thrones", poster: "https://images.example/got.jpg", year: "2011" };
const film = { source: "discover", id: "tt0111161", type: "movie", name: "The Shawshank Redemption", year: "1994" };
const office = { source: "discover", id: "tt0386676", type: "series", name: "The Office", year: "2005" };
const dune = { source: "discover", id: "tt15239678", type: "movie", name: "Dune: Part Two", year: "2024" };
const keys = (state) => state.continuing.map((row) => row.key).sort();

const phone = device("iPhone");
const mac = device("Mac", peerCode);
let uid = "";

test("first sign-in uploads this device's history and never wipes it", async () => {
  await phone.record(got, 1500, 3300, { season: 1, episode: 3 });
  await tick();
  await phone.record(film, 2400, 8520);
  await phone.toggleList(dune);
  const before = await phone.state();
  ({ uid } = await phone.signUp(email, password));
  const afterSignIn = await phone.state();
  assert.deepEqual(keys(afterSignIn), keys(before), "local Continue Watching is untouched");
  assert.equal(afterSignIn.status.phase, "idle", afterSignIn.status.message ?? "");
  const titles = await rest(`${FIRESTORE}/${DOCS}/users/${uid}/profiles/main/titles`, { headers: asOwner });
  const ids = (titles.body.documents ?? []).map((doc) => doc.name.split("/").pop()).sort();
  assert.deepEqual(ids, ["movie-tt0111161", "movie-tt15239678", "series-tt0944947"]);
});

test("a second device signing in keeps its own history and gets the account's", async () => {
  await mac.record(office, 600, 1320, { season: 4, episode: 2 });
  await mac.signIn(email, password);
  const state = await mac.state();
  assert.deepEqual(keys(state), ["movie:tt0111161", "series:tt0386676", "series:tt0944947"]);
  assert.deepEqual(state.myList, ["movie:tt15239678"]);
  await phone.sync();
  assert.deepEqual(keys(await phone.state()), keys(state), "the phone picks up the Mac's show too");
});

test("watching to a position on one device shows the same episode and position on the other", async () => {
  await phone.record(got, 1234.5, 3300, { season: 2, episode: 5 });
  await phone.sync();
  await mac.sync();
  const row = (await mac.state()).continuing.find((entry) => entry.key === "series:tt0944947");
  assert.deepEqual({ season: row.season, episode: row.episode, position: row.position }, { season: 2, episode: 5, position: 1234.5 });
});

test("offline edits on both devices merge, newest per title wins, no duplicates", async () => {
  await phone.offline(true);
  await phone.record(film, 3000, 8520); // older
  await phone.toggleList(office); // only the phone does this
  await phone.setSettings({ audioLanguage: "fre" });
  await assert.rejects(phone.sync(), /offline/i);
  const offlineState = await phone.state();
  assert.equal(offlineState.status.phase, "offline");
  assert.ok(offlineState.status.pending >= 2, "the phone counts its waiting changes");
  await tick();
  await mac.record(film, 4100, 8520); // newer
  await mac.rate(got, 5);
  await mac.sync();
  await phone.offline(false);
  await phone.sync();
  await mac.sync();
  const [p, m] = [await phone.state(), await mac.state()];
  for (const state of [p, m]) {
    assert.equal(state.continuing.find((row) => row.key === "movie:tt0111161").position, 4100, "newest position wins");
    assert.deepEqual(state.myList, ["movie:tt15239678", "series:tt0386676"]);
    assert.equal(state.ratings.find((rating) => rating.media.id === "tt0944947")?.value, 5);
    assert.equal(state.settings.audioLanguage, "fre");
    assert.equal(new Set(keys(state)).size, state.continuing.length, "no duplicate Continue Watching rows");
  }
  assert.deepEqual(keys(p), keys(m));
});

test("finishing and removing travel too", async () => {
  await mac.record(film, 8400, 8520, { completed: true });
  await mac.remove(office);
  await mac.sync();
  await phone.sync();
  const state = await phone.state();
  assert.deepEqual(keys(state), ["series:tt0944947"], "finished film and removed show leave Continue Watching");
  assert.equal(state.entries.find((entry) => entry.media.id === "tt0111161")?.completed, true, "watched state syncs");
});

test("security rules: another account and anonymous callers can't read or write this one", async () => {
  const stranger = await signUpRaw(`stranger+${stamp}@example.com`);
  const bearer = { Authorization: `Bearer ${stranger.idToken}` };
  const theirs = `${FIRESTORE}/${DOCS}/users/${uid}/profiles/main/titles/series-tt0944947`;
  assert.equal((await rest(theirs, { headers: bearer })).status, 403, "cross-user read denied");
  assert.equal((await rest(theirs)).status, 403, "anonymous read denied");
  const write = await rest(`${theirs}?updateMask.fieldPaths=v`, { method: "PATCH", headers: bearer, json: { fields: { v: { integerValue: "9" } } } });
  assert.equal(write.status, 403, "cross-user write denied");
  const own = await rest(`${FIRESTORE}/${DOCS}/users/${stranger.localId}/profiles/main/titles/movie-x`, {
    method: "PATCH",
    headers: bearer,
    json: { fields: { v: { integerValue: "1" } } },
  });
  assert.equal(own.status, 200, "but each person can write their own");
  const listAll = await rest(`${FIRESTORE}/${DOCS}/users`, { headers: bearer });
  assert.equal(listAll.status, 403, "nobody can list every account");
  assert.equal((await rest(`${FIRESTORE}/${DOCS}/deviceLinks`)).status, 403, "TV codes can't be listed");
  const badCode = await rest(`${FIRESTORE}/${DOCS}/deviceLinks?documentId=AAAA1111`, {
    method: "POST",
    json: { fields: { status: { stringValue: "waiting" }, deviceName: { stringValue: "TV" }, platform: { stringValue: "roku" }, expiresAt: { timestampValue: new Date(Date.now() + 600_000).toISOString() } } },
  });
  assert.equal(badCode.status, 403, "codes outside the alphabet are refused");
});

test("a TV shows a code, the phone approves it, the TV reads the account", async () => {
  const alphabet = "BCDFGHJKLMNPQRSTVWXZ23456789";
  const code = Array.from({ length: 8 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  const link = `${FIRESTORE}/${DOCS}/deviceLinks/${code}`;
  const waiting = { status: { stringValue: "waiting" }, deviceName: { stringValue: "Living Room Roku" }, platform: { stringValue: "roku" }, expiresAt: { timestampValue: new Date(Date.now() + 10 * 60_000).toISOString() } };
  const created = await rest(`${FIRESTORE}/${DOCS}/deviceLinks?documentId=${code}`, { method: "POST", json: { fields: waiting } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const tooLong = await rest(`${FIRESTORE}/${DOCS}/deviceLinks?documentId=${code.slice(0, 7)}${code[7] === "B" ? "C" : "B"}`, {
    method: "POST",
    json: { fields: { ...waiting, expiresAt: { timestampValue: new Date(Date.now() + 60 * 60_000).toISOString() } } },
  });
  assert.equal(tooLong.status, 403, "codes live at most 15 minutes");
  const hijack = await rest(`${link}?updateMask.fieldPaths=status&updateMask.fieldPaths=uid&updateMask.fieldPaths=refreshToken`, {
    method: "PATCH",
    json: { fields: { status: { stringValue: "approved" }, uid: { stringValue: "x" }, refreshToken: { stringValue: "y" } } },
  });
  assert.equal(hijack.status, 403, "only a signed-in person can approve, as themselves");

  assert.equal(await phone.approveTv(`${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`), "Living Room Roku");
  await assert.rejects(mac.approveTv(code), /already signed in|just used/i, "a code works once");

  const approved = (await rest(link)).body.fields;
  assert.equal(approved.status.stringValue, "approved");
  assert.equal(approved.uid.stringValue, uid);
  const token = await fetch(`${AUTH}/securetoken.googleapis.com/v1/token?key=demo`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: approved.refreshToken.stringValue }),
  }).then((response) => response.json());
  assert.equal(token.user_id, uid);
  const tvBearer = { Authorization: `Bearer ${token.id_token}` };
  const show = await rest(`${FIRESTORE}/${DOCS}/users/${uid}/profiles/main/titles/series-tt0944947`, { headers: tvBearer });
  assert.equal(show.status, 200);
  assert.equal(show.body.fields.watch.mapValue.fields.episode.integerValue, "5");
  assert.equal((await rest(link, { method: "DELETE", headers: tvBearer })).status, 200, "the TV clears the handshake");
  assert.equal((await rest(link)).status, 404);
});

test("signing out keeps the local copy; deleting the account removes the cloud data", async () => {
  const before = await mac.state();
  await mac.signOut();
  const signedOut = await mac.state();
  assert.equal(signedOut.status.user, null);
  assert.deepEqual(keys(signedOut), keys(before), "Continue Watching stays on the Mac");

  await phone.deleteAccount(password);
  const remaining = await rest(`${FIRESTORE}/${DOCS}/users/${uid}/profiles/main/titles`, { headers: asOwner });
  assert.equal((remaining.body.documents ?? []).length, 0, "titles are gone from the cloud");
  assert.equal((await rest(`${FIRESTORE}/${DOCS}/users/${uid}`, { headers: asOwner })).status, 404);
  await assert.rejects(phone.signIn(email, password), /incorrect|no longer exists/i, "the login is gone");
  assert.ok((await phone.state()).continuing.length > 0, "the phone keeps its local history");
});
