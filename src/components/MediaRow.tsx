/**
 * Horizontal scrolling row with edge chevrons — the core Netflix layout unit.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import MediaCard from "@/components/MediaCard";
import type { BaseItem } from "@/types/jellyfin";

interface Props {
  title: string;
  items: BaseItem[];
  variant?: "poster" | "landscape";
}

export default function MediaRow({ title, items, variant = "poster" }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const updateEdges = useCallback(() => {
    const row = scroller.current;
    if (!row) return;
    setEdges({
      left: row.scrollLeft > 8,
      right: row.scrollLeft + row.clientWidth < row.scrollWidth - 8,
    });
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(updateEdges);
    const observer = new ResizeObserver(updateEdges);
    if (scroller.current) observer.observe(scroller.current);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [items, updateEdges]);
  if (!items.length) return null;

  const scrollBy = (dir: 1 | -1) =>
    scroller.current?.scrollBy({
      left: dir * scroller.current.clientWidth * 0.9,
      behavior: "smooth",
    });

  return (
    <section className="group/row relative mb-11">
      <div className="mb-2 flex items-end gap-3 px-6 md:px-12 lg:px-16">
        <h2 className="text-xl font-bold tracking-[-0.025em] text-zinc-100">{title}</h2>
        <span className="mb-0.5 text-[10px] font-bold uppercase tracking-[0.17em] text-zinc-600">Your library</span>
      </div>

      <div className="relative">
        <button
          aria-label="Scroll left"
          onClick={() => scrollBy(-1)}
          disabled={!edges.left}
          className={`absolute left-0 top-0 z-20 hidden h-full w-12 items-center justify-center bg-gradient-to-r from-surface to-transparent transition md:flex ${edges.left ? "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100" : "pointer-events-none opacity-0"}`}
        >
          <ChevronLeft />
        </button>

        <div
          ref={scroller}
          onScroll={updateEdges}
          className="no-scrollbar flex gap-4 overflow-x-auto scroll-smooth px-6 py-3 md:px-12 lg:px-16"
        >
          {items.map((item) => (
            <MediaCard key={item.Id} item={item} variant={variant} />
          ))}
        </div>

        <button
          aria-label="Scroll right"
          onClick={() => scrollBy(1)}
          disabled={!edges.right}
          className={`absolute right-0 top-0 z-20 hidden h-full w-14 items-center justify-center bg-gradient-to-l from-surface to-transparent transition md:flex ${edges.right ? "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100" : "pointer-events-none opacity-0"}`}
        >
          <ChevronRight />
        </button>
      </div>
    </section>
  );
}
