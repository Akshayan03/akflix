import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PeopleCache,
  PeopleClient,
  applySummary,
  filmographyQuery,
  mergeCredits,
  nameKey,
  parseFilmography,
  parsePersonInfo,
  parseTvmazeCast,
  parseWikidataCredits,
  personPath,
  resolvePersonQuery,
  sortWorks,
  workAsMeta,
} from "../src/api/people";
import inceptionCredits from "./fixtures/people/wikidata-credits-tt1375666.json";
import breakingBadCredits from "./fixtures/people/wikidata-credits-tt0903747.json";
import breakingBadTvmaze from "./fixtures/people/tvmaze-cast-169.json";
import dicaprioInfo from "./fixtures/people/wikidata-person-nm0000138.json";
import dicaprioWorks from "./fixtures/people/wikidata-works-nm0000138.json";
import nolanWorks from "./fixtures/people/wikidata-works-nm0634240.json";
import chrisEvans from "./fixtures/people/wikidata-resolve-chris-evans-tt0848228.json";
import dicaprioSummary from "./fixtures/people/wikipedia-summary-leonardo-dicaprio.json";

const inception = {
  id: "tt1375666",
  type: "movie" as const,
  name: "Inception",
  cast: ["Leonardo DiCaprio", "Joseph Gordon-Levitt", "Elliot Page"],
  director: ["Christopher Nolan"],
  writer: ["Christopher Nolan"],
};
const breakingBad = {
  id: "tt0903747",
  type: "series" as const,
  name: "Breaking Bad",
  cast: ["Bryan Cranston", "Aaron Paul", "Anna Gunn"],
  writer: ["Vince Gilligan"],
};

function memoryStorage(seed: Record<string, string> = {}) {
  const items = new Map(Object.entries(seed));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, String(value)),
    removeItem: (key: string) => void items.delete(key),
  };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

async function withFetch<T>(handler: (url: string) => Response | Promise<Response>, run: (calls: string[]) => Promise<T>) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return handler(String(input));
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test("people: a movie's cast keeps Cinemeta's billing, then Wikidata's best known, with IMDb person ids", () => {
  const credits = mergeCredits(inception, parseWikidataCredits(inceptionCredits));
  assert.deepEqual(credits.cast.slice(0, 3).map((person) => person.name), inception.cast);
  assert.equal(credits.cast[0].imdbId, "nm0000138");
  assert.equal(credits.cast[2].imdbId, "nm0680983");
  const topEight = credits.cast.slice(0, 8).map((person) => person.name);
  for (const name of ["Michael Caine", "Marion Cotillard", "Tom Hardy", "Cillian Murphy"]) assert.ok(topEight.includes(name), name);
  assert.equal(new Set(credits.cast.map((person) => person.wikidataId)).size, credits.cast.length);
  assert.deepEqual(credits.directors, [{ name: "Christopher Nolan", imdbId: "nm0634240", wikidataId: "Q25191" }]);
  assert.deepEqual(credits.creators, []);
});

test("people: a series leads with TVmaze's main cast in order and credits its creator", () => {
  const credits = mergeCredits(breakingBad, parseWikidataCredits(breakingBadCredits), parseTvmazeCast(breakingBadTvmaze));
  assert.deepEqual(
    credits.cast.slice(0, 6).map((person) => person.name),
    ["Bryan Cranston", "Aaron Paul", "Anna Gunn", "RJ Mitte", "Dean Norris", "Betsy Brandt"]
  );
  assert.equal(credits.cast[3].imdbId, "nm2666409");
  assert.ok(credits.cast.length <= 24);
  assert.equal(credits.creators[0].name, "Vince Gilligan");
  assert.match(credits.creators[0].imdbId ?? "", /^nm\d+$/);
  assert.deepEqual(credits.directors, []);
});

test("people: with no sources answering, Cinemeta's names still show (no ids)", () => {
  const credits = mergeCredits(inception);
  assert.deepEqual(credits.cast, inception.cast.map((name) => ({ name })));
  assert.deepEqual(credits.directors, [{ name: "Christopher Nolan" }]);
});

test("people: unlabelled Wikidata items and malformed rows are skipped", () => {
  const credits = parseWikidataCredits({
    results: {
      bindings: [
        { person: { value: "http://www.wikidata.org/entity/Q1" }, personLabel: { value: "Q1" }, role: { value: "cast" } },
        { person: { value: "http://www.wikidata.org/entity/Q2" }, personLabel: { value: "Someone" }, role: { value: "producer" } },
        { person: { value: "http://www.wikidata.org/entity/Q3" }, personLabel: { value: "Real Name" }, role: { value: "cast" }, nm: { value: "bogus" } },
      ],
    },
  });
  assert.deepEqual(credits, [{ name: "Real Name", role: "cast", wikidataId: "Q3", imdbId: undefined, popularity: 0 }]);
  assert.deepEqual(parseWikidataCredits({}), []);
  assert.deepEqual(parseTvmazeCast(null), []);
});

test("people: names match across sources regardless of accents and punctuation", () => {
  assert.equal(nameKey("Penélope Cruz"), nameKey("Penelope Cruz"));
  assert.equal(nameKey("R.J. Mitte"), nameKey("RJ Mitte"));
});

test("people: a filmography maps to Cinemeta ids, kinds, dates and popularity", () => {
  const works = parseFilmography(dicaprioWorks);
  assert.equal(works.length, 44);
  assert.ok(works.every((work) => /^tt\d+$/.test(work.id)));
  const popular = sortWorks(works, "popular");
  assert.equal(popular[0].name, "Titanic");
  assert.equal(popular[0].id, "tt0120338");
  assert.ok(works.some((work) => work.type === "series" && work.name === "Growing Pains"));
  const recent = sortWorks(works, "recent");
  const dated = recent.filter((work) => work.released);
  assert.deepEqual(dated.map((work) => work.released), [...dated.map((work) => work.released)].sort().reverse());
  assert.ok(recent[0].released, "the newest dated title leads");
  assert.equal(recent.at(-1)?.released, undefined, "undated titles go last");
});

test("people: a director's credits carry the director role", () => {
  const works = parseFilmography(nolanWorks);
  const oppenheimer = works.find((work) => work.name === "Oppenheimer");
  assert.ok(oppenheimer?.roles.includes("director"));
  assert.equal(oppenheimer?.type, "movie");
});

test("people: a credit becomes a catalogue card with the metahub poster", () => {
  assert.deepEqual(workAsMeta({ id: "tt1375666", type: "movie", name: "Inception", released: "2010-07-08", popularity: 97, roles: ["cast"] }), {
    id: "tt1375666",
    type: "movie",
    name: "Inception",
    poster: "https://images.metahub.space/poster/small/tt1375666/img",
    releaseInfo: "2010",
    year: "2010",
  });
});

test("people: person info and the Wikipedia summary build the header", () => {
  const info = parsePersonInfo(dicaprioInfo);
  assert.equal(info?.name, "Leonardo DiCaprio");
  assert.equal(info?.imdbId, "nm0000138");
  assert.equal(info?.born, "1974-11-11");
  assert.match(info?.description ?? "", /American actor/);
  assert.match(info?.photo ?? "", /^https:\/\/commons\.wikimedia\.org\/wiki\/Special:FilePath\/.+\?width=480$/);
  const full = applySummary(info!, dicaprioSummary);
  assert.match(full.bio ?? "", /^Leonardo Wilhelm DiCaprio is an American actor/);
  assert.equal(full.photo, dicaprioSummary.thumbnail.source);
  assert.equal(applySummary(info!, { type: "disambiguation", extract: "may refer to" }).bio, undefined);
  assert.equal(parsePersonInfo({ results: { bindings: [] } }), null);
});

test("people: person links carry the IMDb id, the name and the title they came from", () => {
  assert.equal(
    personPath({ name: "Leonardo DiCaprio", imdbId: "nm0000138" }, "tt1375666"),
    "/person/nm0000138?name=Leonardo+DiCaprio&title=tt1375666"
  );
  assert.equal(personPath({ name: "Somebody", wikidataId: "Q42" }), "/person/Q42?name=Somebody");
  assert.equal(personPath({ name: "No Ids" }), "/person/name?name=No+Ids");
});

test("people: queries escape names and refuse a person without an id", () => {
  const query = resolvePersonQuery('Dwayne "The Rock" Johnson', "tt0000001");
  assert.ok(query.includes('"Dwayne \\"The Rock\\" Johnson"@en'));
  assert.ok(query.includes('wdt:P345 "tt0000001"'));
  assert.ok(!resolvePersonQuery("X", 'tt1" } DROP').includes("DROP"), "a malformed title id is ignored");
  assert.throws(() => filmographyQuery({ name: "Only a name" }), /no id/);
  assert.ok(filmographyQuery({ wikidataId: "Q38111" }).includes("BIND(wd:Q38111 AS ?person)"));
});

test("people cache: fresh entries answer, expired ones only as a fallback, and they persist", () => {
  let now = 1_000;
  const storage = memoryStorage();
  const cache = new PeopleCache({ storage: () => storage, now: () => now });
  cache.set("a", { value: 1 });
  assert.deepEqual(cache.get("a", 100), { value: 1 });
  now += 101;
  assert.equal(cache.get("a", 100), undefined);
  assert.deepEqual(cache.get("a", 100, true), { value: 1 });
  const reopened = new PeopleCache({ storage: () => storage, now: () => now });
  assert.deepEqual(reopened.get("a", 1_000), { value: 1 });
});

test("people cache: stays within its storage budget, keeping the newest", () => {
  let now = 0;
  const storage = memoryStorage();
  const cache = new PeopleCache({ storage: () => storage, now: () => ++now, budget: 400 });
  for (let index = 0; index < 10; index += 1) cache.set(`key${index}`, "x".repeat(60));
  const saved = JSON.parse(storage.items.get("akflix.people.v1")!);
  assert.ok(storage.items.get("akflix.people.v1")!.length <= 400);
  assert.ok("key9" in saved);
  assert.ok(!("key0" in saved));
  // The session copy keeps everything.
  assert.equal(cache.get("key0", 1_000), "x".repeat(60));
});

test("people cache: a corrupt or failing store is a cold cache, not an error", () => {
  const corrupt = new PeopleCache({ storage: () => memoryStorage({ "akflix.people.v1": "{not json" }) });
  assert.equal(corrupt.get("a", 1_000), undefined);
  const full = new PeopleCache({
    storage: () => ({ getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); }, removeItem: () => {} }),
  });
  full.set("a", 1);
  assert.equal(full.get("a", 1_000), 1);
});

test("people client: credits load once, then come from the cache", async () => {
  const client = new PeopleClient(new PeopleCache({ storage: () => memoryStorage() }));
  await withFetch(
    (url) => {
      if (url.startsWith("https://query.wikidata.org/sparql")) return json(inceptionCredits);
      return json({}, 404);
    },
    async (calls) => {
      const [first, second] = await Promise.all([client.credits(inception), client.credits(inception)]);
      assert.equal(first, second);
      assert.equal(calls.length, 1, "concurrent requests share one fetch");
      assert.ok(decodeURIComponent(calls[0]).includes('wdt:P345 "tt1375666"'));
      await client.credits(inception);
      assert.equal(calls.length, 1);
      assert.equal(client.cachedCredits(inception)?.cast[0].imdbId, "nm0000138");
    }
  );
});

test("people client: series credits use TVmaze's lookup and cast", async () => {
  const client = new PeopleClient(new PeopleCache({ storage: () => memoryStorage() }));
  await withFetch(
    (url) => {
      if (url.startsWith("https://query.wikidata.org/sparql")) return json(breakingBadCredits);
      if (url === "https://api.tvmaze.com/lookup/shows?imdb=tt0903747") return json({ id: 169 });
      if (url === "https://api.tvmaze.com/shows/169/cast") return json(breakingBadTvmaze);
      return json({}, 404);
    },
    async () => {
      const credits = await client.credits(breakingBad);
      assert.equal(credits.cast[3].name, "RJ Mitte");
    }
  );
});

test("people client: when every source fails, credits reject and nothing is cached", async () => {
  const client = new PeopleClient(new PeopleCache({ storage: () => memoryStorage() }));
  await withFetch(
    () => new Response("down", { status: 503 }),
    async () => {
      await assert.rejects(client.credits(inception), /503/);
      assert.equal(client.cachedCredits(inception), undefined);
      assert.deepEqual(client.fallbackCredits(inception).cast.map((person) => person.name), inception.cast);
    }
  );
});

test("people client: a failed filmography rejects (Retry), then a retry succeeds and is cached", async () => {
  const client = new PeopleClient(new PeopleCache({ storage: () => memoryStorage() }));
  let up = false;
  await withFetch(
    () => (up ? json(dicaprioWorks) : new Response("timeout", { status: 504 })),
    async (calls) => {
      await assert.rejects(client.filmography({ imdbId: "nm0000138", name: "Leonardo DiCaprio" }));
      up = true;
      const works = await client.filmography({ imdbId: "nm0000138", name: "Leonardo DiCaprio" });
      assert.equal(works.length, 44);
      await client.filmography({ imdbId: "nm0000138" });
      assert.equal(calls.length, 2);
    }
  );
});

test("people client: a stale filmography answers when the network is down", async () => {
  let now = 0;
  const storage = memoryStorage();
  const seed = new PeopleCache({ storage: () => storage, now: () => now });
  seed.set("works:nm0000138", parseFilmography(dicaprioWorks));
  now = 10 * 24 * 60 * 60 * 1000;
  const client = new PeopleClient(new PeopleCache({ storage: () => storage, now: () => now }));
  await withFetch(
    () => new Response("down", { status: 503 }),
    async () => assert.equal((await client.filmography({ imdbId: "nm0000138" })).length, 44)
  );
});

test("people client: a name alone resolves to the namesake credited on the title", async () => {
  const client = new PeopleClient(new PeopleCache({ storage: () => memoryStorage() }));
  await withFetch(
    () => json(chrisEvans),
    async (calls) => {
      const ref = await client.resolve({ name: "Chris Evans", titleId: "tt0848228" });
      assert.equal(ref.imdbId, "nm0262635");
      assert.equal(ref.wikidataId, "Q178348");
      assert.ok(decodeURIComponent(calls[0]).includes('?work wdt:P345 "tt0848228"'));
    }
  );
  // A known IMDb id needs no lookup.
  assert.deepEqual(await client.resolve({ imdbId: "nm0000138" }), { imdbId: "nm0000138" });
});

test("people client: person info adds the Wikipedia bio, and survives the summary failing", async () => {
  const client = new PeopleClient(new PeopleCache({ storage: () => memoryStorage() }));
  await withFetch(
    (url) => {
      if (url.startsWith("https://query.wikidata.org/sparql")) return json(dicaprioInfo);
      if (url === "https://en.wikipedia.org/api/rest_v1/page/summary/Leonardo_DiCaprio") return json(dicaprioSummary);
      return json({}, 404);
    },
    async () => {
      const info = await client.person({ imdbId: "nm0000138", name: "Leonardo DiCaprio" });
      assert.match(info.bio ?? "", /American actor/);
    }
  );
  const offline = new PeopleClient(new PeopleCache({ storage: () => memoryStorage() }));
  await withFetch(
    (url) => (url.startsWith("https://query.wikidata.org/sparql") ? json(dicaprioInfo) : new Response("down", { status: 503 })),
    async () => {
      const info = await offline.person({ imdbId: "nm0000138" });
      assert.equal(info.bio, undefined);
      assert.equal(info.name, "Leonardo DiCaprio");
    }
  );
});
