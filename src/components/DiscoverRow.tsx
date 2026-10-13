import { ChevronLeft, ChevronRight } from "lucide-react";
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
}: {
  title: string;
  items: StremioMeta[];
  /** Only for a real fact about the row ("Based on your ratings"). */
  tagline?: string;
  cardState?: Record<string, DiscoverCardState>;
  variant?: "poster" | "landscape";
  id?: string;
}) {
  const { rowRef, edges, updateEdges, scroll } = useRowScroller(items);
  if (!items.length) return null;

  return (
    <section id={id} aria-label={title} className="group/row relative mb-8 scroll-mt-24 md:mb-10">
      <div className="ak-gutter mb-3 flex items-baseline gap-3">
        <h2 className="ak-section-title">{title}</h2>
        {tagline && <span className="hidden text-xs text-zinc-500 sm:inline">{tagline}</span>}
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
