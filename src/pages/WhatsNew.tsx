/**
 * What's New — everything recently released, newest first, filterable to
 * movies or series: new episodes and scheduled ones for shows you watch,
 * this week's releases, new seasons, the last 30 days and the last 3 months.
 * Dates are the catalogue's own release and air dates.
 */
import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, ChevronDown, RefreshCw } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import DiscoverCard, { type DiscoverCardState } from "@/components/DiscoverCard";
import DiscoverRow from "@/components/DiscoverRow";
import { useHistory } from "@/stores/historyStore";
import { useAuth } from "@/stores/authStore";
import { planWhatsNew, type NewFilter, type NewSection } from "@/lib/discovery/rows";
import { useDiscoveryData, useDiscoverySignals } from "@/lib/discovery/useDiscovery";

const FILTERS: { value: NewFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "movie", label: "Movies" },
  { value: "series", label: "Series" },
];

const PAGE = 24;

export default function WhatsNew() {
  const [params, setParams] = useSearchParams();
  const filter: NewFilter = params.get("type") === "movie" ? "movie" : params.get("type") === "series" ? "series" : "all";
  const signals = useDiscoverySignals();
  const discovery = useDiscoveryData(signals);
  const sections = useMemo(() => (discovery.data ? planWhatsNew(signals, discovery.data, filter) : null), [signals, discovery.data, filter]);
  const profileId = useAuth((state) => state.activeProfileId) ?? "akflix-local";
  const entries = useHistory((state) => state.entries);
  const ratings = useHistory((state) => state.ratings);
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

  const choose = (value: NewFilter) => {
    const next = new URLSearchParams(params);
    if (value === "all") next.delete("type");
    else next.set("type", value);
    setParams(next, { replace: true });
  };

  return (
    <motion.main
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="min-h-screen bg-[radial-gradient(circle_at_30%_-10%,rgba(255,255,255,.05),transparent_34rem)] pb-20 pt-[calc(var(--ak-nav-h)+44px)]"
    >
      <header className="ak-gutter mb-10 flex flex-wrap items-end gap-x-8 gap-y-5">
        <div className="min-w-0 flex-1">
          <p className="ak-eyebrow mb-3">Just released</p>
          <h1 className="ak-page-title">What's New</h1>
          <p className="mt-3 max-w-xl text-sm text-zinc-400">
            New films, series and seasons, newest first, with new episodes of the shows you watch.
          </p>
        </div>
        <div className="ak-segmented" role="group" aria-label="Show">
          {FILTERS.map((option) => (
            <button key={option.value} type="button" aria-pressed={filter === option.value} onClick={() => choose(option.value)}>
              {option.label}
            </button>
          ))}
        </div>
      </header>

      {discovery.failed && !sections ? (
        <div className="ak-gutter">
          <div role="alert" className="ak-notice ak-notice--error max-w-2xl">
            <AlertTriangle size={18} aria-hidden="true" />
            <div className="min-w-0">
              <p><strong>New releases didn't load.</strong> Check your internet connection, then try again.</p>
              <button onClick={discovery.retry} className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-full bg-black px-4 text-xs font-bold text-white">
                <RefreshCw size={14} aria-hidden="true" /> Try again
              </button>
            </div>
          </div>
        </div>
      ) : !sections ? (
        <div role="status" aria-label="Loading new releases" className="ak-gutter">
          <div className="skeleton mb-4 h-5 w-40 !rounded-md" />
          <div className="ak-poster-grid">
            {Array.from({ length: 12 }).map((_, index) => (
              <div key={index} className="skeleton aspect-[2/3] w-full" />
            ))}
          </div>
        </div>
      ) : sections.length ? (
        sections.map((section) =>
          section.variant === "landscape" ? (
            <DiscoverRow
              key={section.id}
              id={`new-${section.id}`}
              title={section.title}
              tagline={section.tagline}
              items={section.items}
              variant="landscape"
              cardState={withBadges(section, cardState)}
            />
          ) : (
            <PosterSection key={`${filter}:${section.id}`} section={section} cardState={withBadges(section, cardState)} />
          )
        )
      ) : (
        <p className="ak-gutter text-sm text-zinc-400">Nothing new here right now. New releases appear as soon as the catalogue lists them.</p>
      )}
    </motion.main>
  );
}

function withBadges(section: NewSection, base: Record<string, DiscoverCardState>) {
  const state: Record<string, DiscoverCardState> = {};
  for (const item of section.items) {
    const key = `${item.type}:${item.id}`;
    // On a show's news card the last episode's progress would read as the new one's.
    state[key] = { ...base[key], progress: section.variant === "landscape" ? undefined : base[key]?.progress, badge: section.badges[key] };
  }
  return state;
}

function PosterSection({ section, cardState }: { section: NewSection; cardState: Record<string, DiscoverCardState> }) {
  const [shown, setShown] = useState(PAGE);
  const items = section.items.slice(0, shown);
  return (
    <section aria-labelledby={`new-${section.id}`} className="ak-gutter ak-lazy-row mb-12">
      <div className="mb-4 flex items-baseline gap-3">
        <h2 id={`new-${section.id}`} className="ak-section-title">{section.title}</h2>
        <span className="text-xs text-zinc-500">{section.items.length} {section.items.length === 1 ? "title" : "titles"}</span>
      </div>
      <div className="ak-poster-grid">
        {items.map((item) => (
          <DiscoverCard key={`${item.type}:${item.id}`} item={item} state={cardState[`${item.type}:${item.id}`]} fluid caption />
        ))}
      </div>
      {section.items.length > shown && (
        <button type="button" onClick={() => setShown((value) => value + PAGE)} className="desktop-control desktop-control--sm desktop-secondary mt-6">
          <ChevronDown size={15} aria-hidden="true" /> Show more
        </button>
      )}
    </section>
  );
}
