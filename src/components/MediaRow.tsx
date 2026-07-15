/**
 * Horizontal scrolling row with edge chevrons — the core Netflix layout unit.
 */

import { useRef } from "react";
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
          className="absolute left-0 top-0 z-20 hidden h-full w-12 items-center justify-center bg-gradient-to-r from-surface to-transparent opacity-0 transition group-hover/row:opacity-100 md:flex"
        >
          <ChevronLeft />
        </button>

        <div
          ref={scroller}
          className="no-scrollbar flex gap-4 overflow-x-auto scroll-smooth px-6 py-3 md:px-12 lg:px-16"
        >
          {items.map((item) => (
            <MediaCard key={item.Id} item={item} variant={variant} />
          ))}
        </div>

        <button
          aria-label="Scroll right"
          onClick={() => scrollBy(1)}
          className="absolute right-0 top-0 z-20 hidden h-full w-14 items-center justify-center bg-gradient-to-l from-surface to-transparent opacity-0 transition group-hover/row:opacity-100 md:flex"
        >
          <ChevronRight />
        </button>
      </div>
    </section>
  );
}
