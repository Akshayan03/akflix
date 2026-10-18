/**
 * Local facts the stores can't express on their own, kept so account sync
 * can merge them: when a title was removed from Continue Watching, when a
 * rating was cleared, and when each synced setting last changed here.
 * Deliberately import-free so stores can call it without cycles.
 */

export interface CloudJournal {
  /** `${profileId}|${type}:${id}` → epoch ms of the removal. */
  watchRemoved: Record<string, number>;
  ratingCleared: Record<string, number>;
  /** Setting name → epoch ms it last changed on this device. */
  settingsAt: Record<string, number>;
}

const KEY = "akflix.cloud.journal";
const LIMIT = 600;

function empty(): CloudJournal {
  return { watchRemoved: {}, ratingCleared: {}, settingsAt: {} };
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readJournal(): CloudJournal {
  const raw = storage()?.getItem(KEY);
  if (!raw) return empty();
  try {
    const value = JSON.parse(raw) as Partial<CloudJournal>;
    return {
      watchRemoved: value.watchRemoved ?? {},
      ratingCleared: value.ratingCleared ?? {},
      settingsAt: value.settingsAt ?? {},
    };
  } catch {
    return empty();
  }
}

function trim(map: Record<string, number>) {
  const entries = Object.entries(map);
  if (entries.length <= LIMIT) return map;
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, LIMIT));
}

export function writeJournal(journal: CloudJournal) {
  try {
    storage()?.setItem(
      KEY,
      JSON.stringify({
        watchRemoved: trim(journal.watchRemoved),
        ratingCleared: trim(journal.ratingCleared),
        settingsAt: journal.settingsAt,
      })
    );
  } catch {
    // Storage full: sync still works, a removal may just not propagate.
  }
}

export function journalKey(profileId: string, key: string) {
  return `${profileId}|${key}`;
}

export function noteWatchRemoved(profileId: string, key: string, at = Date.now()) {
  const journal = readJournal();
  journal.watchRemoved[journalKey(profileId, key)] = at;
  writeJournal(journal);
}

export function noteRatingCleared(profileId: string, key: string, at = Date.now()) {
  const journal = readJournal();
  journal.ratingCleared[journalKey(profileId, key)] = at;
  writeJournal(journal);
}

export function noteSettingsChanged(keys: string[], at = Date.now()) {
  if (!keys.length) return;
  const journal = readJournal();
  for (const key of keys) journal.settingsAt[key] = at;
  writeJournal(journal);
}
