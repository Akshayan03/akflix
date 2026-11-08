/**
 * People — the cast and crew of a title and a person's movies and shows.
 *
 * Cinemeta lists only three actors and has no person endpoint, so credits come
 * from keyless public sources:
 * - Wikidata SPARQL: a title's cast, director and creator with their IMDb
 *   person ids, and a person's credits as IMDb title ids (the Cinemeta ids, so
 *   posters and title pages reuse the catalogue). Sitelink counts stand in for
 *   popularity.
 * - TVmaze: a series' main cast in billing order.
 * - Wikipedia's page summary: a person's short bio and photo.
 *
 * Results are cached in memory and in localStorage (one bounded key) and every
 * request is optional: a title page always falls back to Cinemeta's names.
 */

import { httpJson, isTauri } from "@/lib/http";
import type { StremioMediaType, StremioMeta } from "@/types/stremio";

const SPARQL_URL = "https://query.wikidata.org/sparql";
const TVMAZE_URL = "https://api.tvmaze.com";
const WIKIPEDIA_SUMMARY_URL = "https://en.wikipedia.org/api/rest_v1/page/summary/";
/** Wikimedia rejects requests without a User-Agent; a browser sends its own. */
const USER_AGENT = "Akflix/1.0 (https://akshayan03.github.io/akflix)";

export type CreditRole = "cast" | "director" | "creator";

export interface CreditPerson {
  name: string;
  /** IMDb person id (nm…), the stable key that tells apart people who share a name. */
  imdbId?: string;
  /** Wikidata item (Q…), used when a person has no IMDb id there. */
  wikidataId?: string;
}

export interface TitleCredits {
  /** Billing order: Cinemeta's (or TVmaze's for series) first, then the best known. */
  cast: CreditPerson[];
  directors: CreditPerson[];
  creators: CreditPerson[];
}

export interface PersonWork {
  /** IMDb title id, which is also the Cinemeta id. */
  id: string;
  type: StremioMediaType;
  name: string;
  /** ISO date (first release / first air date) when known. */
  released?: string;
  /** Wikipedia sitelinks: how widely the title is covered. */
  popularity: number;
  roles: CreditRole[];
}

export interface PersonInfo {
  name: string;
  imdbId?: string;
  wikidataId?: string;
  /** Wikidata's one-line description: "American actor and producer (born 1974)". */
  description?: string;
  bio?: string;
  photo?: string;
  born?: string;
  died?: string;
  /** Link to the English Wikipedia article the bio came from. */
  wikipediaUrl?: string;
}

export interface PersonRef {
  imdbId?: string;
  wikidataId?: string;
  name?: string;
  /** The title the person was opened from, to choose between namesakes. */
  titleId?: string;
}

// ── Parsing ────────────────────────────────────────────────────────────────

interface SparqlValue {
  value: string;
}
export interface SparqlResponse {
  results?: { bindings?: Record<string, SparqlValue | undefined>[] };
}

const IMDB_PERSON = /^nm\d{5,}$/;
const IMDB_TITLE = /^tt\d{5,}$/;
const WIKIDATA_ITEM = /^Q\d+$/;

const bindings = (response: SparqlResponse) => response?.results?.bindings ?? [];
const entityId = (uri?: string) => uri?.split("/").pop();
/** Wikidata falls back to the item id when nothing has an English label. */
const usableLabel = (label?: string) => (label && !WIKIDATA_ITEM.test(label) ? label.trim() : undefined);

/** Compare names across sources: case, accents and punctuation don't matter. */
export function nameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

interface WikidataCredit extends CreditPerson {
  role: CreditRole;
  popularity: number;
}

export function parseWikidataCredits(response: SparqlResponse): WikidataCredit[] {
  const credits = new Map<string, WikidataCredit>();
  for (const row of bindings(response)) {
    const name = usableLabel(row.personLabel?.value);
    const role = row.role?.value as CreditRole | undefined;
    const wikidataId = entityId(row.person?.value);
    if (!name || !wikidataId || (role !== "cast" && role !== "director" && role !== "creator")) continue;
    const nm = row.nm?.value;
    const key = `${role}:${wikidataId}`;
    const previous = credits.get(key);
    credits.set(key, {
      name,
      role,
      wikidataId,
      imdbId: previous?.imdbId ?? (nm && IMDB_PERSON.test(nm) ? nm : undefined),
      popularity: Math.max(previous?.popularity ?? 0, Number(row.links?.value) || 0),
    });
  }
  return [...credits.values()];
}

export interface TvmazeCastEntry {
  person?: { name?: string };
}

export function parseTvmazeCast(cast: TvmazeCastEntry[] | null | undefined): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(cast) ? cast : []) {
    const name = entry?.person?.name?.trim();
    if (!name || seen.has(nameKey(name))) continue;
    seen.add(nameKey(name));
    names.push(name);
  }
  return names;
}

const MAX_CAST = 24;

/**
 * Merge the sources into one ordered credit list. Billing comes from the
 * names Cinemeta/TVmaze list first (TVmaze leads for series: it has the
 * whole main cast in order), then Wikidata's remaining cast by popularity.
 * Wikidata supplies the person ids wherever a name matches.
 */
export function mergeCredits(
  meta: Pick<StremioMeta, "type" | "cast" | "director" | "writer">,
  wikidata: WikidataCredit[] = [],
  billing: string[] = []
): TitleCredits {
  const byRole = (role: CreditRole) =>
    wikidata.filter((credit) => credit.role === role).sort((a, b) => b.popularity - a.popularity);
  const build = (names: string[], known: WikidataCredit[], limit: number): CreditPerson[] => {
    const people: CreditPerson[] = [];
    const seen = new Set<string>();
    const ids = new Map<string, WikidataCredit>();
    for (const credit of known) if (!ids.has(nameKey(credit.name))) ids.set(nameKey(credit.name), credit);
    const add = (name: string, match?: WikidataCredit) => {
      const key = nameKey(name);
      const id = match?.wikidataId ?? key;
      if (!key || seen.has(key) || seen.has(id) || people.length >= limit) return;
      seen.add(key);
      seen.add(id);
      people.push({
        name: name.trim(),
        ...(match?.imdbId ? { imdbId: match.imdbId } : {}),
        ...(match?.wikidataId ? { wikidataId: match.wikidataId } : {}),
      });
    };
    for (const name of names) add(name, ids.get(nameKey(name)));
    for (const credit of known) add(credit.name, credit);
    return people;
  };
  const series = meta.type === "series";
  const castNames = series ? [...billing, ...(meta.cast ?? [])] : [...(meta.cast ?? []), ...billing];
  return {
    cast: build(castNames, byRole("cast"), MAX_CAST),
    directors: series ? [] : build(meta.director ?? [], byRole("director"), 3),
    // Cinemeta's "writer" on a series is its creator.
    creators: series ? build(meta.writer ?? [], byRole("creator"), 3) : [],
  };
}

export function parseFilmography(response: SparqlResponse): PersonWork[] {
  const works = new Map<string, PersonWork>();
  for (const row of bindings(response)) {
    const id = row.tt?.value;
    const name = usableLabel(row.workLabel?.value);
    const kind = row.kind?.value;
    if (!id || !IMDB_TITLE.test(id) || !name || (kind !== "movie" && kind !== "series")) continue;
    const roles = (row.roles?.value ?? "cast")
      .split(/\s+/)
      .filter((role): role is CreditRole => role === "cast" || role === "director" || role === "creator");
    const released = row.released?.value?.slice(0, 10);
    const previous = works.get(id);
    works.set(id, {
      id,
      // A title Wikidata files as both a film and a series keeps the first kind.
      type: previous?.type ?? kind,
      name: previous?.name ?? name,
      released: previous?.released ?? (released && /^\d{4}-\d{2}-\d{2}$/.test(released) ? released : undefined),
      popularity: Math.max(previous?.popularity ?? 0, Number(row.pop?.value) || 0),
      roles: [...new Set([...(previous?.roles ?? []), ...roles])],
    });
  }
  return [...works.values()];
}

export function parsePersonInfo(response: SparqlResponse, fallbackName = ""): PersonInfo | null {
  const row = bindings(response)[0];
  if (!row) return null;
  const nm = row.nm?.value;
  const image = row.image?.value;
  return {
    name: usableLabel(row.personLabel?.value) ?? fallbackName,
    imdbId: nm && IMDB_PERSON.test(nm) ? nm : undefined,
    wikidataId: entityId(row.person?.value),
    description: row.personDescription?.value,
    born: row.born?.value?.slice(0, 10),
    died: row.died?.value?.slice(0, 10),
    // Commons serves a resized copy of the file at this address.
    photo: image ? `${image.replace(/^http:/, "https:")}?width=480` : undefined,
    wikipediaUrl: row.article?.value,
  };
}

export interface WikipediaSummary {
  type?: string;
  extract?: string;
  thumbnail?: { source?: string };
}

export function applySummary(info: PersonInfo, summary: WikipediaSummary | null | undefined): PersonInfo {
  if (!summary || summary.type === "disambiguation") return info;
  return {
    ...info,
    bio: summary.extract?.trim() || info.bio,
    photo: summary.thumbnail?.source ?? info.photo,
  };
}

export type WorkSort = "popular" | "recent";

export function sortWorks(works: PersonWork[], sort: WorkSort): PersonWork[] {
  const time = (work: PersonWork) => (work.released ? Date.parse(work.released) : Number.NaN);
  return [...works].sort((a, b) => {
    if (sort === "recent") {
      const ta = time(a);
      const tb = time(b);
      // Undated titles (often unannounced) go last.
      if (Number.isNaN(ta) !== Number.isNaN(tb)) return Number.isNaN(ta) ? 1 : -1;
      if (!Number.isNaN(ta) && ta !== tb) return tb - ta;
      return b.popularity - a.popularity;
    }
    if (b.popularity !== a.popularity) return b.popularity - a.popularity;
    return (time(b) || 0) - (time(a) || 0);
  });
}

/** A credit as a catalogue item, so the existing poster cards show it. */
export function workAsMeta(work: PersonWork): StremioMeta {
  const year = work.released?.slice(0, 4);
  return {
    id: work.id,
    type: work.type,
    name: work.name,
    poster: `https://images.metahub.space/poster/small/${work.id}/img`,
    ...(year ? { releaseInfo: year, year } : {}),
  };
}

/** The route for a person's page. */
export function personPath(person: CreditPerson, titleId?: string): string {
  const id = person.imdbId ?? person.wikidataId ?? "name";
  const params = new URLSearchParams({ name: person.name });
  if (titleId) params.set("title", titleId);
  return `/person/${encodeURIComponent(id)}?${params}`;
}

// ── Queries ────────────────────────────────────────────────────────────────

const literal = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, " ")}"`;

export function titleCreditsQuery(titleId: string): string {
  return `SELECT ?person ?nm ?personLabel ?role (MAX(?sitelinks) AS ?links) WHERE {
  ?work wdt:P345 ${literal(titleId)} .
  VALUES (?prop ?role) { (wdt:P161 "cast") (wdt:P57 "director") (wdt:P170 "creator") }
  ?work ?prop ?person .
  OPTIONAL { ?person wdt:P345 ?nm . FILTER(STRSTARTS(?nm, "nm")) }
  OPTIONAL { ?person wikibase:sitelinks ?sitelinks }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
} GROUP BY ?person ?nm ?personLabel ?role`;
}

/** Binds ?person to the person: by IMDb id when known, else the Wikidata item. */
function personPattern(ref: PersonRef): string {
  if (ref.imdbId && IMDB_PERSON.test(ref.imdbId)) return `?person wdt:P345 ${literal(ref.imdbId)} .`;
  if (ref.wikidataId && WIKIDATA_ITEM.test(ref.wikidataId)) return `BIND(wd:${ref.wikidataId} AS ?person)`;
  throw new Error("This person has no id to look up.");
}

export function resolvePersonQuery(name: string, titleId?: string): string {
  const credited = titleId && IMDB_TITLE.test(titleId)
    ? `BIND(EXISTS { ?work wdt:P345 ${literal(titleId)} ; (wdt:P161|wdt:P57|wdt:P170) ?person } AS ?inTitle)`
    : "BIND(false AS ?inTitle)";
  return `SELECT ?person ?nm ?links ?inTitle WHERE {
  { ?person rdfs:label ${literal(name)}@en } UNION { ?person skos:altLabel ${literal(name)}@en }
  ?person wdt:P31 wd:Q5 .
  OPTIONAL { ?person wdt:P345 ?nm . FILTER(STRSTARTS(?nm, "nm")) }
  OPTIONAL { ?person wikibase:sitelinks ?links }
  ${credited}
} ORDER BY DESC(?inTitle) DESC(?links) LIMIT 1`;
}

export function personInfoQuery(ref: PersonRef): string {
  return `SELECT ?person ?nm ?personLabel ?personDescription ?image ?born ?died ?article WHERE {
  ${personPattern(ref)}
  OPTIONAL { ?person wdt:P345 ?nm . FILTER(STRSTARTS(?nm, "nm")) }
  OPTIONAL { ?person wdt:P18 ?image }
  OPTIONAL { ?person wdt:P569 ?born }
  OPTIONAL { ?person wdt:P570 ?died }
  OPTIONAL { ?article schema:about ?person ; schema:isPartOf <https://en.wikipedia.org/> }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
} LIMIT 1`;
}

export function filmographyQuery(ref: PersonRef): string {
  return `SELECT ?tt ?workLabel ?kind (MIN(?date) AS ?released) (MAX(?sitelinks) AS ?pop) (GROUP_CONCAT(DISTINCT ?role) AS ?roles) WHERE {
  ${personPattern(ref)}
  VALUES (?prop ?role) { (wdt:P161 "cast") (wdt:P57 "director") (wdt:P170 "creator") }
  ?work ?prop ?person ; wdt:P345 ?tt .
  FILTER(STRSTARTS(?tt, "tt"))
  { ?work wdt:P31/wdt:P279* wd:Q11424 . BIND("movie" AS ?kind) }
  UNION { ?work wdt:P31/wdt:P279* wd:Q5398426 . BIND("series" AS ?kind) }
  OPTIONAL { ?work wdt:P577 ?published }
  OPTIONAL { ?work wdt:P580 ?started }
  BIND(COALESCE(?published, ?started) AS ?date)
  OPTIONAL { ?work wikibase:sitelinks ?sitelinks }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
} GROUP BY ?tt ?workLabel ?kind`;
}

// ── Cache ──────────────────────────────────────────────────────────────────

interface CacheEntry<T> {
  savedAt: number;
  value: T;
}

export interface PeopleCacheOptions {
  storageKey?: string;
  /** Upper bound for the persisted JSON so it never crowds out profile data. */
  budget?: number;
  now?: () => number;
  storage?: () => Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined;
}

/**
 * A small two-level cache: a Map for this session and one localStorage key
 * that keeps the newest entries within `budget` characters. Expired entries
 * are ignored but kept as a stale fallback when the network fails.
 */
export class PeopleCache {
  private memory = new Map<string, CacheEntry<unknown>>();
  private loaded = false;
  private readonly storageKey: string;
  private readonly budget: number;
  private readonly now: () => number;
  private readonly storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined;

  constructor(options: PeopleCacheOptions = {}) {
    this.storageKey = options.storageKey ?? "akflix.people.v1";
    this.budget = options.budget ?? 200_000;
    this.now = options.now ?? Date.now;
    this.storage = options.storage ?? (() => (typeof localStorage === "undefined" ? undefined : localStorage));
  }

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = this.storage()?.getItem(this.storageKey);
      const saved = raw ? (JSON.parse(raw) as Record<string, CacheEntry<unknown>>) : {};
      for (const [key, entry] of Object.entries(saved)) {
        if (entry && typeof entry.savedAt === "number" && !this.memory.has(key)) this.memory.set(key, entry);
      }
    } catch {
      // A corrupt or unavailable store only means a cold cache.
    }
  }

  get<T>(key: string, maxAge: number, allowStale = false): T | undefined {
    this.load();
    const entry = this.memory.get(key) as CacheEntry<T> | undefined;
    if (!entry) return undefined;
    if (!allowStale && this.now() - entry.savedAt > maxAge) return undefined;
    return entry.value;
  }

  set<T>(key: string, value: T) {
    this.load();
    this.memory.delete(key);
    this.memory.set(key, { savedAt: this.now(), value });
    this.persist();
  }

  private persist() {
    const store = this.storage();
    if (!store) return;
    // Newest first, until the budget is spent.
    const entries = [...this.memory.entries()].sort((a, b) => b[1].savedAt - a[1].savedAt);
    const kept: Record<string, CacheEntry<unknown>> = {};
    let size = 2;
    for (const [key, entry] of entries) {
      const length = JSON.stringify(key).length + JSON.stringify(entry).length + 1;
      if (size + length > this.budget) continue;
      kept[key] = entry;
      size += length;
    }
    try {
      store.setItem(this.storageKey, JSON.stringify(kept));
    } catch {
      // Full storage: the session cache still works.
    }
  }
}

const DAY = 24 * 60 * 60 * 1000;
const CREDITS_MAX_AGE = 7 * DAY;
const PERSON_MAX_AGE = 3 * DAY;

// ── Client ─────────────────────────────────────────────────────────────────

export class PeopleClient {
  private inflight = new Map<string, Promise<unknown>>();

  constructor(readonly cache = new PeopleCache()) {}

  private async sparql(query: string, signal?: AbortSignal): Promise<SparqlResponse> {
    const url = `${SPARQL_URL}?format=json&query=${encodeURIComponent(query)}`;
    return httpJson<SparqlResponse>(url, {
      signal,
      headers: {
        Accept: "application/sparql-results+json",
        ...(isTauri() ? { "User-Agent": USER_AGENT } : {}),
      },
    });
  }

  /** One request per key at a time; a fresh cached value answers at once. */
  private async cached<T>(key: string, maxAge: number, load: () => Promise<T>): Promise<T> {
    const fresh = this.cache.get<T>(key, maxAge);
    if (fresh !== undefined) return fresh;
    const running = this.inflight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const request = load()
      .then((value) => {
        this.cache.set(key, value);
        return value;
      })
      .catch((reason) => {
        const stale = this.cache.get<T>(key, maxAge, true);
        if (stale !== undefined) return stale;
        throw reason;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, request);
    return request;
  }

  /** Names Cinemeta already has, before anything loads. */
  fallbackCredits(meta: Pick<StremioMeta, "type" | "cast" | "director" | "writer">): TitleCredits {
    return mergeCredits(meta);
  }

  /** Cached credits, without a request (for an instant first paint). */
  cachedCredits(meta: Pick<StremioMeta, "id">): TitleCredits | undefined {
    return this.cache.get<TitleCredits>(`credits:${meta.id}`, CREDITS_MAX_AGE);
  }

  async credits(meta: StremioMeta): Promise<TitleCredits> {
    if (!IMDB_TITLE.test(meta.id)) return mergeCredits(meta);
    return this.cached(`credits:${meta.id}`, CREDITS_MAX_AGE, async () => {
      const [wikidata, billing] = await Promise.allSettled([
        this.sparql(titleCreditsQuery(meta.id)).then(parseWikidataCredits),
        meta.type === "series" ? this.tvmazeCast(meta.id) : Promise.resolve([]),
      ]);
      // Neither source answered: don't cache Cinemeta's short list as the result.
      if (wikidata.status === "rejected" && (meta.type !== "series" || billing.status === "rejected")) {
        throw wikidata.reason;
      }
      return mergeCredits(
        meta,
        wikidata.status === "fulfilled" ? wikidata.value : [],
        billing.status === "fulfilled" ? billing.value : []
      );
    });
  }

  private async tvmazeCast(titleId: string): Promise<string[]> {
    const show = await httpJson<{ id?: number }>(`${TVMAZE_URL}/lookup/shows?imdb=${titleId}`);
    if (!show?.id) return [];
    return parseTvmazeCast(await httpJson<TvmazeCastEntry[]>(`${TVMAZE_URL}/shows/${show.id}/cast`));
  }

  /** Find the person behind a name, preferring the one credited on `titleId`. */
  async resolve(ref: PersonRef): Promise<PersonRef> {
    if (ref.imdbId || ref.wikidataId) return ref;
    const name = ref.name?.trim();
    if (!name) throw new Error("No person to look up.");
    const key = `resolve:${nameKey(name)}:${ref.titleId ?? ""}`;
    return this.cached(key, PERSON_MAX_AGE, async () => {
      const row = bindings(await this.sparql(resolvePersonQuery(name, ref.titleId)))[0];
      const nm = row?.nm?.value;
      const wikidataId = entityId(row?.person?.value);
      if (!row || !wikidataId) throw new Error(`Couldn't find ${name}.`);
      return { name, titleId: ref.titleId, wikidataId, ...(nm && IMDB_PERSON.test(nm) ? { imdbId: nm } : {}) };
    });
  }

  async person(ref: PersonRef): Promise<PersonInfo> {
    const resolved = await this.resolve(ref);
    const key = `person:${resolved.imdbId ?? resolved.wikidataId}`;
    return this.cached(key, PERSON_MAX_AGE, async () => {
      const info = parsePersonInfo(await this.sparql(personInfoQuery(resolved)), ref.name ?? "");
      if (!info) throw new Error(`Couldn't find ${ref.name ?? "this person"}.`);
      if (!info.wikipediaUrl) return info;
      // The bio is optional: Wikidata's description and photo still show.
      const title = info.wikipediaUrl.split("/wiki/")[1];
      const summary = title
        ? await httpJson<WikipediaSummary>(`${WIKIPEDIA_SUMMARY_URL}${title}`).catch(() => null)
        : null;
      return applySummary(info, summary);
    });
  }

  async filmography(ref: PersonRef): Promise<PersonWork[]> {
    const resolved = await this.resolve(ref);
    const key = `works:${resolved.imdbId ?? resolved.wikidataId}`;
    return this.cached(key, PERSON_MAX_AGE, async () =>
      parseFilmography(await this.sparql(filmographyQuery(resolved)))
    );
  }
}

export const people = new PeopleClient();
