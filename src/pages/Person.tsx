/**
 * A person's page: name, photo and short bio, then their movies and shows as
 * poster cards (filter movies or shows, sort by popularity or recency). The
 * name shows at once from the link; the bio and the credits load separately,
 * so a failed credits lookup still leaves the person with a Retry.
 */
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, ChevronDown, RefreshCw } from "lucide-react";
import { useParams, useSearchParams } from "react-router-dom";
import { people, sortWorks, workAsMeta, type PersonInfo, type PersonRef, type PersonWork, type WorkSort } from "@/api/people";
import Artwork from "@/components/Artwork";
import DiscoverCard, { type DiscoverCardState } from "@/components/DiscoverCard";
import { isAppleMobile } from "@/lib/platform";
import { useAuth } from "@/stores/authStore";
import { useHistory } from "@/stores/historyStore";

type WorkFilter = "all" | "movie" | "series";

const FILTERS: { value: WorkFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "movie", label: "Movies" },
  { value: "series", label: "Shows" },
];
const SORTS: { value: WorkSort; label: string }[] = [
  { value: "popular", label: "Popular" },
  { value: "recent", label: "Recent" },
];
const PAGE = 30;

type Load<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "failed" };

function personRef(id: string | undefined, params: URLSearchParams): PersonRef {
  const name = params.get("name") ?? undefined;
  const titleId = params.get("title") ?? undefined;
  if (id && /^nm\d+$/.test(id)) return { imdbId: id, name, titleId };
  if (id && /^Q\d+$/.test(id)) return { wikidataId: id, name, titleId };
  return { name, titleId };
}

function lifeLine(info?: PersonInfo): string | undefined {
  const year = (date?: string) => date?.slice(0, 4);
  if (info?.born && info.died) return `${year(info.born)}–${year(info.died)}`;
  if (info?.born) return `Born ${year(info.born)}`;
  return undefined;
}

/** Mark the credits that aren't acting, but only for someone who mostly acts. */
function roleBadges(works: PersonWork[]): Record<string, string> {
  const acting = works.filter((work) => work.roles.includes("cast")).length;
  if (acting * 2 < works.length) return {};
  const badges: Record<string, string> = {};
  for (const work of works) {
    if (work.type === "movie" && work.roles.includes("director")) badges[work.id] = "Director";
    else if (work.type === "series" && work.roles.includes("creator")) badges[work.id] = "Creator";
  }
  return badges;
}

export default function Person() {
  const mobileApple = isAppleMobile();
  const { personId } = useParams<{ personId: string }>();
  const [params, setParams] = useSearchParams();
  const ref = personRef(personId, params);
  const refKey = `${personId}|${ref.name ?? ""}|${ref.titleId ?? ""}`;
  const filter: WorkFilter = params.get("type") === "movie" ? "movie" : params.get("type") === "series" ? "series" : "all";
  const sort: WorkSort = params.get("sort") === "recent" ? "recent" : "popular";
  const [info, setInfo] = useState<Load<PersonInfo>>({ status: "loading" });
  const [works, setWorks] = useState<Load<PersonWork[]>>({ status: "loading" });
  const [infoAttempt, setInfoAttempt] = useState(0);
  const [worksAttempt, setWorksAttempt] = useState(0);
  const [shown, setShown] = useState(PAGE);
  const [bioOpen, setBioOpen] = useState(false);

  useEffect(() => {
    let current = true;
    setInfo({ status: "loading" });
    people
      .person(ref)
      .then((value) => current && setInfo({ status: "ready", value }))
      .catch(() => current && setInfo({ status: "failed" }));
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refKey, infoAttempt]);

  useEffect(() => {
    let current = true;
    setWorks({ status: "loading" });
    people
      .filmography(ref)
      .then((value) => current && setWorks({ status: "ready", value }))
      .catch(() => current && setWorks({ status: "failed" }));
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refKey, worksAttempt]);

  /** Retry what failed; a bio that loaded stays. */
  const retry = () => {
    setWorksAttempt((value) => value + 1);
    if (info.status === "failed") setInfoAttempt((value) => value + 1);
  };

  useEffect(() => {
    setShown(PAGE);
    setBioOpen(false);
  }, [refKey, filter, sort]);

  const profileId = useAuth((state) => state.activeProfileId) ?? "akflix-local";
  const entries = useHistory((state) => state.entries);
  const ratings = useHistory((state) => state.ratings);
  const allWorks = works.status === "ready" ? works.value : [];
  const badges = useMemo(() => roleBadges(allWorks), [allWorks]);
  const cardState = useMemo(() => {
    const state: Record<string, DiscoverCardState> = {};
    for (const entry of entries) {
      if (entry.profileId !== profileId || entry.media.source !== "discover") continue;
      state[`${entry.media.type}:${entry.media.id}`] = { progress: entry.progress, watched: entry.completed };
    }
    for (const rating of ratings) {
      if (rating.profileId !== profileId || rating.media.source !== "discover") continue;
      const key = `${rating.media.type}:${rating.media.id}`;
      state[key] = { ...state[key], rating: rating.value };
    }
    return state;
  }, [entries, ratings, profileId]);

  const counts = {
    all: allWorks.length,
    movie: allWorks.filter((work) => work.type === "movie").length,
    series: allWorks.filter((work) => work.type === "series").length,
  };
  const visible = useMemo(
    () => sortWorks(allWorks.filter((work) => filter === "all" || work.type === filter), sort),
    [allWorks, filter, sort]
  );

  const setParam = (key: "type" | "sort", value: string, fallback: string) => {
    const next = new URLSearchParams(params);
    if (value === fallback) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const person = info.status === "ready" ? info.value : undefined;
  const name = person?.name || ref.name || "Unknown";
  const life = lifeLine(person);
  const bio = person?.bio;
  const longBio = !!bio && bio.length > 320;

  const pill = (pressed: boolean) =>
    mobileApple
      ? `min-h-10 rounded-full border px-3.5 text-xs font-semibold transition-colors ${
          pressed ? "border-white bg-white text-black" : "border-white/15 text-zinc-300"
        }`
      : undefined;

  const controls = (
    <div className={mobileApple ? "no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-1" : "flex flex-wrap items-center gap-3"}>
      <div className={mobileApple ? "flex gap-2" : "ak-segmented"} role="group" aria-label="Show">
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={filter === option.value}
            onClick={() => setParam("type", option.value, "all")}
            className={pill(filter === option.value)}
          >
            {option.label}
            {works.status === "ready" && <span className="ml-1 opacity-60">{counts[option.value]}</span>}
          </button>
        ))}
      </div>
      {mobileApple && <span className="w-px shrink-0 bg-white/10" aria-hidden="true" />}
      <div className={mobileApple ? "flex gap-2" : "ak-segmented"} role="group" aria-label="Sort by">
        {SORTS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={sort === option.value}
            onClick={() => setParam("sort", option.value, "popular")}
            className={pill(sort === option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );

  const grid = mobileApple ? "grid grid-cols-3 gap-2.5" : "ak-poster-grid";

  return (
    <motion.main
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className={`min-h-screen bg-[radial-gradient(circle_at_30%_-10%,rgba(255,255,255,.05),transparent_34rem)] ${
        mobileApple ? "px-4 pb-32 pt-24" : "ak-gutter pb-20 pt-[calc(var(--ak-nav-h)+44px)]"
      }`}
    >
      <header className={mobileApple ? "flex flex-col items-center text-center" : "mb-12 flex items-end gap-8"}>
        <div
          className={`ak-rise-in shrink-0 overflow-hidden bg-surface-raised ring-1 ring-white/15 shadow-[0_24px_70px_rgba(0,0,0,.6)] ${
            mobileApple ? "h-28 w-28 rounded-full" : "aspect-[3/4] w-[168px] rounded-2xl"
          }`}
        >
          {info.status === "loading" ? (
            <div className="skeleton h-full w-full !rounded-none" />
          ) : (
            <Artwork
              src={person?.photo}
              title={name}
              variant="poster"
              alt=""
              className="h-full w-full object-cover object-top"
              draggable={false}
            />
          )}
        </div>
        <div className={`ak-rise-in min-w-0 ${mobileApple ? "mt-5" : "max-w-[760px] flex-1"}`}>
          <p className={`ak-eyebrow ${mobileApple ? "mb-2 !text-[9px]" : "mb-3"}`}>
            {person?.description ? person.description : "Cast & crew"}
          </p>
          <h1 className={mobileApple ? "font-display text-4xl tracking-[-0.03em]" : "ak-page-title"}>{name}</h1>
          {(life || works.status === "ready") && (
            <div className={`ak-meta mt-3 ${mobileApple ? "justify-center !text-xs" : ""}`}>
              {life && <span>{life}</span>}
              {works.status === "ready" && (
                <span>
                  {counts.all} {counts.all === 1 ? "title" : "titles"}
                </span>
              )}
            </div>
          )}
          {info.status === "loading" && (
            <div className={`mt-4 space-y-2 ${mobileApple ? "flex flex-col items-center" : ""}`} aria-hidden="true">
              <div className="skeleton h-3 w-[86%] max-w-[560px] !rounded-md" />
              <div className="skeleton h-3 w-[64%] max-w-[420px] !rounded-md" />
            </div>
          )}
          {bio && (
            <div className="mt-4">
              <p
                className={`text-zinc-300 ${mobileApple ? "text-[13px] leading-[1.6]" : "max-w-[680px] text-[14px] leading-[1.65]"} ${
                  bioOpen ? "" : mobileApple ? "line-clamp-4" : "line-clamp-3"
                }`}
              >
                {bio}
              </p>
              <p className={`mt-2 flex items-center gap-3 text-[11px] text-zinc-500 ${mobileApple ? "justify-center" : ""}`}>
                {longBio && (
                  <button
                    type="button"
                    onClick={() => setBioOpen((value) => !value)}
                    aria-expanded={bioOpen}
                    className="font-semibold text-zinc-200 underline-offset-4 hover:underline"
                  >
                    {bioOpen ? "Less" : "Read more"}
                  </button>
                )}
                <span>From Wikipedia</span>
              </p>
            </div>
          )}
        </div>
      </header>

      <section aria-labelledby="person-works" className={mobileApple ? "mt-8" : ""}>
        <div className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-3">
          <h2 id="person-works" className={mobileApple ? "text-[22px] font-black tracking-[-0.04em]" : "ak-section-title"}>
            Movies and shows
          </h2>
          {!mobileApple && controls}
        </div>
        {mobileApple && <div className="mb-4">{controls}</div>}

        {works.status === "failed" ? (
          <div role="alert" className="ak-notice ak-notice--error max-w-2xl">
            <AlertTriangle size={18} aria-hidden="true" />
            <div className="min-w-0">
              <p>
                <strong>Couldn't load their titles.</strong> Check your internet connection, then try again.
              </p>
              <button
                type="button"
                onClick={retry}
                className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-full bg-black px-4 text-xs font-bold text-white"
              >
                <RefreshCw size={14} aria-hidden="true" /> Retry
              </button>
            </div>
          </div>
        ) : works.status === "loading" ? (
          <div role="status" aria-label="Loading their titles" className={grid}>
            {Array.from({ length: mobileApple ? 9 : 12 }).map((_, index) => (
              <div key={index} className="skeleton aspect-[2/3] w-full" />
            ))}
          </div>
        ) : visible.length ? (
          <>
            <div key={`${filter}:${sort}`} className={`ak-page-in ${grid}`}>
              {visible.slice(0, shown).map((work) => {
                const key = `${work.type}:${work.id}`;
                return (
                  <DiscoverCard
                    key={key}
                    item={workAsMeta(work)}
                    state={{ ...cardState[key], badge: badges[work.id] }}
                    fluid
                    caption
                  />
                );
              })}
            </div>
            {visible.length > shown && (
              <button
                type="button"
                onClick={() => setShown((value) => value + PAGE)}
                className={
                  mobileApple
                    ? "mx-auto mt-6 flex min-h-11 items-center gap-2 rounded-full border border-white/15 px-5 text-xs font-semibold text-zinc-200"
                    : "desktop-control desktop-control--sm desktop-secondary mt-6"
                }
              >
                <ChevronDown size={15} aria-hidden="true" /> Show more
              </button>
            )}
          </>
        ) : (
          <p className="text-sm text-zinc-400">
            {allWorks.length
              ? `No ${filter === "series" ? "shows" : "movies"} here. Try All.`
              : `No movies or shows found for ${name}.`}
          </p>
        )}
      </section>
    </motion.main>
  );
}
