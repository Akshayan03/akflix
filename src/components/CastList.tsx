/**
 * The cast and director/creator under a title's name. Each name opens the
 * person's page. Cinemeta's names show at once; the fuller billed list (with
 * IMDb person ids, so namesakes open the right person) replaces them when it
 * loads, and a failed lookup simply leaves Cinemeta's names.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { people, personPath, type CreditPerson, type TitleCredits } from "@/api/people";
import type { StremioMeta } from "@/types/stremio";

const VISIBLE = { desktop: 5, mobile: 5 } as const;
/** The desktop hero has a fixed height, so "More" stops at three rows' worth. */
const EXPANDED = { desktop: 15, mobile: 24 } as const;

export default function CastList({ meta, variant }: { meta: StremioMeta; variant: "desktop" | "mobile" }) {
  const [credits, setCredits] = useState<TitleCredits>(() => people.cachedCredits(meta) ?? people.fallbackCredits(meta));
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setCredits(people.cachedCredits(meta) ?? people.fallbackCredits(meta));
    setExpanded(false);
    let current = true;
    people
      .credits(meta)
      .then((value) => current && setCredits(value))
      .catch(() => {});
    return () => {
      current = false;
    };
    // The credits belong to the title; a refreshed meta object keeps them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.id]);

  const crew = meta.type === "series" ? credits.creators : credits.directors;
  if (!credits.cast.length && !crew.length) return null;

  const limit = VISIBLE[variant];
  const cast = credits.cast.slice(0, EXPANDED[variant]);
  const shown = expanded ? cast : cast.slice(0, limit);
  const hidden = cast.length - limit;
  const crewLabel = meta.type === "series" ? "Created by" : crew.length > 1 ? "Directors" : "Director";
  const mobile = variant === "mobile";

  const chip = (person: CreditPerson, index: number) => (
    <Link
      key={person.imdbId ?? person.wikidataId ?? person.name}
      to={personPath(person, meta.id)}
      role="listitem"
      className={mobile ? "ak-person-chip ak-person-chip--mobile" : "ak-chip ak-person-chip"}
      // Names revealed by "More" follow each other in.
      style={index >= limit ? { animationDelay: `${Math.min(index - limit, 12) * 22}ms` } : undefined}
      data-revealed={index >= limit ? "true" : undefined}
    >
      {person.name}
    </Link>
  );

  return (
    <div className={mobile ? "mt-5 space-y-2.5" : "mt-4 space-y-2"}>
      {cast.length > 0 && (
        <div className="ak-cast-row">
          <span className="ak-cast-label" id={`cast-${meta.id}`}>Starring</span>
          <div role="list" aria-labelledby={`cast-${meta.id}`} className="flex min-w-0 flex-1 flex-wrap gap-1.5">
            {shown.map(chip)}
            {hidden > 0 && (
              <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                aria-expanded={expanded}
                className={mobile ? "ak-person-chip ak-person-chip--mobile ak-person-chip--more" : "ak-chip ak-person-chip ak-person-chip--more"}
              >
                {expanded ? "Less" : `+${hidden} more`}
              </button>
            )}
          </div>
        </div>
      )}
      {crew.length > 0 && (
        <div className="ak-cast-row">
          <span className="ak-cast-label" id={`crew-${meta.id}`}>{crewLabel}</span>
          <div role="list" aria-labelledby={`crew-${meta.id}`} className="flex min-w-0 flex-1 flex-wrap gap-1.5">
            {crew.map(chip)}
          </div>
        </div>
      )}
    </div>
  );
}
