import { ChevronLeft, ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import DiscoverCard from "@/components/DiscoverCard";
import type { DiscoverCardState } from "@/components/DiscoverCard";
import type { StremioMeta } from "@/types/stremio";
import { useRowScroller } from "@/components/MediaRow";

export default function DiscoverRow({
  title,
  items,
  tagline,
  cardState,
  variant = "poster",
  id,
  seeAll,
  className = "",
}: {
  title: string;
  items: StremioMeta[];
  /** Only for a real fact about the row ("Based on your ratings"). */
  tagline?: string;
  cardState?: Record<string, DiscoverCardState>;
  variant?: "poster" | "landscape";
  id?: string;
  /** Route of a page with everything in this row. */
  seeAll?: string;
  className?: string;
}) {
  const { rowRef, edges, updateEdges, scroll } = useRowScroller(items);
  if (!items.length) return null;

  return (
    <section id={id} aria-label={title} className={`group/row relative mb-8 scroll-mt-24 md:mb-10 ${className}`}>
      <div className="ak-gutter mb-3 flex items-baseline gap-3">
        <h2 className="ak-section-title min-w-0 truncate">{title}</h2>
        {tagline && <span className="hidden shrink-0 text-xs text-zinc-500 sm:inline">{tagline}</span>}
        {seeAll && (
          <Link to={seeAll} aria-label={`See all: ${title}`} className="ak-see-all ml-auto shrink-0">
            See all <ChevronRight size={14} aria-hidden="true" />
          </Link>
        )}
      </div>
      <div className="relative">
        <button
          type="button"
          onClick={() => scroll(-1)}
          disabled={!edges.left}
          aria-label={`Scroll ${title} left`}
          className="ak-row-arrow ak-row-arrow--left"
        >
          <span><ChevronLeft size={18} aria-hidden="true" /></span>
        </button>
        <div ref={rowRef} onScroll={updateEdges} className="ak-row-scroller no-scrollbar">
          {items.map((item) => (
            <DiscoverCard
              key={`${item.type}:${item.id}`}
              item={item}
              state={cardState?.[`${item.type}:${item.id}`]}
              variant={variant}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => scroll(1)}
          disabled={!edges.right}
          aria-label={`Scroll ${title} right`}
          className="ak-row-arrow ak-row-arrow--right"
        >
          <span><ChevronRight size={18} aria-hidden="true" /></span>
        </button>
      </div>
    </section>
  );
}
