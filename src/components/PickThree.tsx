/**
 * Optional start for a profile with no history: pick a few titles you like
 * and the home personalises right away. Picks are saved as "Liked it" (4 of
 * 5) ratings, so they sync like any rating; Skip hides the panel for good.
 */
import { useState } from "react";
import { Check, X } from "lucide-react";
import Artwork from "@/components/Artwork";
import { useHistory } from "@/stores/historyStore";
import type { StremioMeta } from "@/types/stremio";

const storageKey = (profileId: string) => `akflix.discovery.start.${profileId}`;

export function pickThreeDismissed(profileId: string): boolean {
  try {
    return !!localStorage.getItem(storageKey(profileId));
  } catch {
    return false;
  }
}

export default function PickThree({
  profileId,
  items,
  onDone,
}: {
  profileId: string;
  items: StremioMeta[];
  onDone: () => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const close = (reason: "done" | "skipped") => {
    try {
      localStorage.setItem(storageKey(profileId), reason);
    } catch {
      // Without storage the panel may simply come back next launch.
    }
    onDone();
  };
  const finish = () => {
    const setRating = useHistory.getState().setRating;
    for (const item of items) {
      if (!picked.includes(item.id)) continue;
      setRating(
        {
          source: "discover",
          id: item.id,
          type: item.type,
          name: item.name,
          poster: item.poster,
          background: item.background,
          description: item.description,
          releaseInfo: item.releaseInfo,
          year: item.year,
          imdbRating: item.imdbRating,
          genres: item.genres,
        },
        4
      );
    }
    close("done");
  };
  const toggle = (id: string) =>
    setPicked((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));

  return (
    <section aria-labelledby="pick-three-title" className="ak-gutter mb-10">
      <div className="ak-pick-three">
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <div className="min-w-0 flex-1">
            <h2 id="pick-three-title" className="ak-section-title">Pick 3 you like</h2>
            <p className="mt-1 text-sm text-zinc-400">
              Your picks start your recommendations. You can skip this; what you watch and rate does the same.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" onClick={() => close("skipped")} className="desktop-control desktop-control--sm desktop-ghost">
              <X size={15} aria-hidden="true" /> Skip
            </button>
            <button type="button" onClick={finish} disabled={!picked.length} className="desktop-control desktop-control--sm desktop-primary">
              <Check size={15} aria-hidden="true" /> {picked.length >= 3 ? "Done" : picked.length ? `Done · ${picked.length} picked` : "Pick a few"}
            </button>
          </div>
        </div>
        <div role="group" aria-label="Titles to pick from" className="ak-pick-grid mt-5">
          {items.map((item) => {
            const on = picked.includes(item.id);
            return (
              <button
                key={`${item.type}:${item.id}`}
                type="button"
                aria-pressed={on}
                aria-label={`${item.name}${on ? ", picked" : ""}`}
                onClick={() => toggle(item.id)}
                className="ak-pick-card"
              >
                <Artwork src={item.poster} title={item.name} variant="poster" sizes="(min-width: 640px) 160px, 25vw" alt="" loading="lazy" className="h-full w-full object-cover" draggable={false} />
                {on && (
                  <span className="ak-pick-check" aria-hidden="true">
                    <Check size={18} strokeWidth={3} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
