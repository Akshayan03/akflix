import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectLocalChanges,
  emptyPatch,
  fingerprint,
  localTitles,
  mergeSettings,
  mergeTitles,
  stable,
  titleDocId,
  titleFromDoc,
  titleToDoc,
  type CloudTitle,
  type LocalSnapshot,
} from "../src/lib/cloud/model";
import { fromFields, toFields } from "../src/lib/cloud/firestore";
import { parseFirebaseConfig } from "../src/lib/cloud/env";
import { cloudProfileFor, cloudStatusLine, normalizeTvCode } from "../src/lib/cloud/engine";
import { readJournal } from "../src/lib/cloud/journal";
import { useHistory, type HistoryTitle, type WatchHistoryEntry } from "../src/stores/historyStore";
import { useMyList } from "../src/stores/listStore";

/** Continue Watching rows as the Mac's Home builds them (newest per title, unfinished). */
function continuingEntries(entries: WatchHistoryEntry[], profileId: string) {
  const seen = new Set<string>();
  return entries
    .filter((e) => e.profileId === profileId && e.media.source === "discover")
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((e) => {
      const key = `${e.media.type}:${e.media.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .filter((e) => !e.completed && (e.position > 0 || (e.media.type === "series" && !!e.season && !!e.episode)));
}

function withStorage<T>(run: () => T): T {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    },
  });
  try {
    return run();
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

const show: HistoryTitle = { source: "discover", id: "tt0944947", type: "series", name: "Game of Thrones", poster: "https://img/got.jpg", genres: ["Drama"] };
const film: HistoryTitle = { source: "discover", id: "tt0111161", type: "movie", name: "The Shawshank Redemption", year: "1994" };

const entry = (media: HistoryTitle, at: number, patch: Partial<WatchHistoryEntry> = {}): WatchHistoryEntry => ({
  profileId: "akflix-local",
  media,
  position: 600,
  duration: 3000,
  progress: 20,
  completed: false,
  updatedAt: at,
  ...(media.type === "series" ? { season: 2, episode: 5, subtitle: "S2 E5 · The Wolf and the Lion" } : {}),
  ...patch,
});

const snapshot = (patch: Partial<LocalSnapshot> = {}): LocalSnapshot => ({
  entries: [],
  ratings: [],
  list: [],
  journal: { watchRemoved: {}, ratingCleared: {}, settingsAt: {} },
  ...patch,
});

const cloud = (patch: Partial<CloudTitle>): CloudTitle => ({ key: "series:tt0944947", type: "series", id: "tt0944947", meta: { name: "Game of Thrones" }, ...patch });

test("cloud sync: each facet keeps its own newest writer", () => {
  const phone = cloud({ watch: { at: 200, position: 1234.5, duration: 3300, progress: 37.41, completed: false, season: 2, episode: 6 }, list: { at: 100, saved: false } });
  const mac = cloud({ watch: { at: 150, position: 10, duration: 3300, progress: 0.3, completed: false, season: 2, episode: 5 }, list: { at: 180, saved: true }, rating: { at: 90, value: 4 } });
  const merged = mergeTitles(phone, mac)!;
  assert.equal(merged.watch?.episode, 6, "the newer position and exact episode win");
  assert.equal(merged.watch?.position, 1234.5);
  assert.equal(merged.list?.saved, true, "a newer My List add on another device is kept");
  assert.equal(merged.rating?.value, 4, "a rating only one side has is kept");
});

test("cloud sync: merging is symmetric and idempotent so devices converge", () => {
  const titles: CloudTitle[] = [];
  for (let index = 0; index < 40; index += 1) {
    titles.push(cloud({
      meta: { name: `Name ${index % 3}`, ...(index % 2 ? { poster: `p${index}` } : {}) },
      ...(index % 4 ? { watch: { at: index % 7, position: index, duration: 100, progress: index, completed: index % 5 === 0 } } : {}),
      ...(index % 3 ? { list: { at: index % 5, saved: index % 2 === 0 } } : {}),
      ...(index % 6 ? { rating: { at: index % 4, value: index % 6 } } : {}),
    }));
  }
  for (const a of titles) {
    for (const b of titles) {
      const ab = mergeTitles(a, b)!;
      assert.equal(stable(ab), stable(mergeTitles(b, a)), "merge(a, b) must equal merge(b, a)");
      assert.equal(stable(mergeTitles(ab, a)), stable(ab), "merging again changes nothing");
    }
  }
});

test("cloud sync: one record per title, so Continue Watching never duplicates", () => {
  const titles = localTitles("akflix-local", snapshot({
    entries: [entry(show, 100, { episode: 4 }), entry(show, 300, { episode: 6 }), entry(film, 200), { ...entry(show, 400), profileId: "other" }],
  }));
  assert.deepEqual([...titles.keys()].sort(), ["movie:tt0111161", "series:tt0944947"]);
  assert.equal(titles.get("series:tt0944947")?.watch?.episode, 6, "the newest legacy row wins");
});

test("cloud sync: Jellyfin library rows stay on the device", () => {
  const jellyfin: HistoryTitle = { source: "jellyfin", id: "abc", type: "movie", name: "Home video" };
  assert.equal(localTitles("akflix-local", snapshot({ entries: [entry(jellyfin, 10)] })).size, 0);
});

test("cloud sync: a removal from Continue Watching travels as a timestamped tombstone", () => {
  const journal = { watchRemoved: { "akflix-local|series:tt0944947": 500 }, ratingCleared: {}, settingsAt: {} };
  const titles = localTitles("akflix-local", snapshot({ entries: [entry(show, 400)], journal }));
  assert.equal(titles.get("series:tt0944947")?.watch?.removed, true, "removed after the last watch");
  const rewatched = localTitles("akflix-local", snapshot({ entries: [entry(show, 600)], journal }));
  assert.equal(rewatched.get("series:tt0944947")?.watch?.removed, undefined, "watching again later beats the removal");
});

test("cloud sync: newer cloud rows patch this device, older ones never do", () => {
  const local = localTitles("akflix-local", snapshot({ entries: [entry(show, 300)] })).get("series:tt0944947");
  const newer = cloud({ meta: { name: "Game of Thrones", poster: "x" }, watch: { at: 900, position: 42, duration: 3300, progress: 1.27, completed: false, season: 3, episode: 1 } });
  const patch = emptyPatch();
  collectLocalChanges("akflix-local", mergeTitles(local, newer)!, local, patch);
  assert.equal(patch.entries.length, 1);
  assert.equal(patch.entries[0].season, 3);
  assert.equal(patch.entries[0].position, 42);
  assert.equal(patch.entries[0].updatedAt, 900, "the other device's timestamp is kept, not a new one");

  const older = cloud({ watch: { at: 100, position: 5, duration: 3300, progress: 0.1, completed: false, season: 1, episode: 1 } });
  const untouched = emptyPatch();
  collectLocalChanges("akflix-local", mergeTitles(local, older)!, local, untouched);
  assert.equal(untouched.entries.length, 0);
});

test("cloud sync: a newer removal elsewhere drops the local row and records the tombstone", () => {
  const local = localTitles("akflix-local", snapshot({ entries: [entry(show, 300)] })).get("series:tt0944947");
  const removed = cloud({ watch: { at: 800, removed: true, position: 0, duration: 0, progress: 0, completed: false } });
  const patch = emptyPatch();
  collectLocalChanges("akflix-local", mergeTitles(local, removed)!, local, patch);
  assert.deepEqual(patch.removeEntries, ["series:tt0944947"]);
  assert.deepEqual(patch.watchTombstones, [["series:tt0944947", 800]]);
});

test("cloud sync: documents survive the Firestore value codec unchanged", () => {
  const title = cloud({
    meta: { name: "Game of Thrones", poster: "https://img/got.jpg", genres: ["Drama", "Fantasy"] },
    watch: { at: 1760744000123, position: 1234.5, duration: 3300, progress: 37.41, completed: false, season: 2, episode: 6, subtitle: "S2 E6" },
    list: { at: 1760744000000, saved: true },
    rating: { at: 1760744000001, value: 5 },
  });
  const fields = toFields(titleToDoc(title));
  assert.equal((fields.watch as { mapValue: { fields: Record<string, unknown> } }).mapValue.fields.at && "integerValue" in ((fields.watch as any).mapValue.fields.at), true);
  const back = titleFromDoc(fromFields(JSON.parse(JSON.stringify(fields))))!;
  assert.equal(stable(back), stable(title));
  assert.equal(titleDocId("series", "tt0944947"), "series-tt0944947", "the Roku derives the same document id");
  assert.equal(titleDocId("movie", "kitsu:1"), "movie-kitsu~3a1");
});

test("cloud sync: identical facets give identical fingerprints, metadata alone does not", () => {
  const a = cloud({ meta: { name: "A", poster: "1" }, watch: { at: 1, position: 2, duration: 3, progress: 4, completed: false } });
  const b = cloud({ meta: { name: "B" }, watch: { at: 1, position: 2, duration: 3, progress: 4, completed: false } });
  assert.equal(fingerprint(a), fingerprint(b));
});

test("cloud sync: applying cloud rows keeps one Continue Watching card per title", () => {
  withStorage(() => {
    useHistory.setState({ entries: [entry(show, 100, { episode: 2 })], ratings: [] });
    useHistory.getState().applyCloud({ entries: [entry(show, 900, { episode: 7 }), entry(show, 950, { episode: 8 })], removeEntries: [], ratings: [], removeRatings: [] });
    const rows = continuingEntries(useHistory.getState().entries, "akflix-local");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].episode, 8);
  });
});

test("cloud sync: removing a title or clearing a rating is journaled for sync", () => {
  withStorage(() => {
    useHistory.setState({ entries: [entry(show, 100)], ratings: [] });
    useHistory.getState().removeEntry(show);
    useHistory.getState().setRating(show, 4);
    useHistory.getState().setRating(show, null);
    const journal = readJournal();
    assert.ok(journal.watchRemoved["akflix-local|series:tt0944947"] > 0);
    assert.ok(journal.ratingCleared["akflix-local|series:tt0944947"] > 0);
  });
});

test("cloud sync: My List keeps a removal marker so removals sync", () => {
  withStorage(() => {
    useMyList.setState({ items: [] });
    assert.equal(useMyList.getState().toggle(film), true);
    assert.equal(useMyList.getState().toggle(film), false);
    const [row] = useMyList.getState().items;
    assert.equal(row.saved, false);
    const titles = localTitles("akflix-local", snapshot({ list: useMyList.getState().items }));
    assert.equal(titles.get("movie:tt0111161")?.list?.saved, false);
  });
});

test("cloud sync: settings merge per setting by time", () => {
  const merged = mergeSettings(
    { values: { audioLanguage: "jpn", subtitleLanguage: "eng" }, at: { audioLanguage: 50, subtitleLanguage: 10 } },
    { values: { audioLanguage: "eng", subtitleLanguage: "spa", language: "fr" }, at: { audioLanguage: 20, subtitleLanguage: 30, language: 5 } }
  )!;
  assert.deepEqual(merged.values, { audioLanguage: "jpn", subtitleLanguage: "spa", language: "fr" });
});

test("cloud sync: the Firebase console config snippet can be pasted as-is", () => {
  const snippet = `const firebaseConfig = {\n  apiKey: "AIzaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvW",\n  authDomain: "akflix-123.firebaseapp.com",\n  projectId: "akflix-123",\n  appId: "1:123:web:abc"\n};`;
  assert.deepEqual(parseFirebaseConfig(snippet), {
    apiKey: "AIzaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvW",
    projectId: "akflix-123",
    authDomain: "akflix-123.firebaseapp.com",
    appId: "1:123:web:abc",
  });
  assert.equal(parseFirebaseConfig("hello"), null);
});

test("cloud sync: TV codes ignore dashes, spaces and case", () => {
  assert.equal(normalizeTvCode("bkdt-7m4q"), "BKDT7M4Q");
  assert.equal(normalizeTvCode(" BKDT 7M4Q "), "BKDT7M4Q");
  assert.equal(normalizeTvCode("BKDT-7M4"), null);
  assert.equal(normalizeTvCode("BKDT-7M4O"), null, "O is never in a code");
});

test("cloud sync: the same Jellyfin login maps to the same cloud profile everywhere", () => {
  const base = { id: "random-1", kind: "jellyfin" as const, serverUrl: "http://10.0.0.35:8096/", userId: "u1", userName: "Ak", serverName: "Home" };
  assert.equal(cloudProfileFor(base).id, cloudProfileFor({ ...base, id: "random-2", serverUrl: "HTTP://10.0.0.35:8096" }).id);
  assert.equal(cloudProfileFor({ ...base, id: "akflix-local", kind: "local" }).id, "main");
});

test("cloud sync: status line reads like a person wrote it", () => {
  const base = { mode: "emulator" as const, projectId: "demo", user: { uid: "u", email: "a@b.c" }, message: null, titles: 3, pending: 0 };
  assert.equal(cloudStatusLine({ ...base, phase: "idle", lastSyncedAt: 1_000 }, 5_000), "Synced just now");
  assert.equal(cloudStatusLine({ ...base, phase: "offline", lastSyncedAt: 1_000, pending: 2 }, 5_000), "Offline · 2 changes waiting");
});
