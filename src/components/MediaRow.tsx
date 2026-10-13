/**
 * Horizontal scrolling row with edge arrows — the core browse layout unit.
 * Catalog rows (DiscoverRow) share the same scroller and arrows.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import MediaCard from "@/components/MediaCard";
import type { BaseItem } from "@/types/jellyfin";

/** Tracks whether a row can scroll either way and pages it by ~80%. */
export function useRowScroller(items: unknown[]) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const updateEdges = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    const left = row.scrollLeft > 8;
    const right = row.scrollLeft + row.clientWidth < row.scrollWidth - 8;
    setEdges((current) => (current.left === left && current.right === right ? current : { left, right }));
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(updateEdges);
    const observer = new ResizeObserver(updateEdges);
    if (rowRef.current) observer.observe(rowRef.current);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [items, updateEdges]);
  const scroll = (direction: 1 | -1) => {
    const row = rowRef.current;
    if (!row) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    row.scrollBy({ left: direction * row.clientWidth * 0.8, behavior: reduce ? "auto" : "smooth" });
  };
  return { rowRef, edges, updateEdges, scroll };
}

interface Props {
  title: string;
  items: BaseItem[];
  variant?: "poster" | "landscape";
}

export default function MediaRow({ title, items, variant = "poster" }: Props) {
  const { rowRef, edges, updateEdges, scroll } = useRowScroller(items);
  if (!items.length) return null;

  return (
    <section aria-label={title} className="group/row relative mb-8 md:mb-10">
      <div className="ak-gutter mb-3 flex items-baseline gap-3">
        <h2 className="ak-section-title">{title}</h2>
        <span className="hidden text-xs text-zinc-500 sm:inline">Jellyfin</span>
      </div>

      <div className="relative">
        <button
          type="button"
          aria-label={`Scroll ${title} left`}
          onClick={() => scroll(-1)}
          disabled={!edges.left}
          className="ak-row-arrow ak-row-arrow--left"
        >
          <span><ChevronLeft size={18} aria-hidden="true" /></span>
        </button>

        <div ref={rowRef} onScroll={updateEdges} className="ak-row-scroller no-scrollbar">
          {items.map((item) => (
            <MediaCard key={item.Id} item={item} variant={variant} />
          ))}
        </div>

        <button
          type="button"
          aria-label={`Scroll ${title} right`}
          onClick={() => scroll(1)}
          disabled={!edges.right}
          className="ak-row-arrow ak-row-arrow--right"
        >
          <span><ChevronRight size={18} aria-hidden="true" /></span>
        </button>
      </div>
    </section>
  );
}
