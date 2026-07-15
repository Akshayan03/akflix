import { ChevronLeft, ChevronRight } from "lucide-react";
import { useRef } from "react";
import DiscoverCard from "@/components/DiscoverCard";
import type { DiscoverCardState } from "@/components/DiscoverCard";
import type { StremioMeta } from "@/types/stremio";

export default function DiscoverRow({
  title,
  items,
  tagline = "Curated for you",
  cardState,
  variant = "poster",
}: {
  title: string;
  items: StremioMeta[];
  tagline?: string;
  cardState?: Record<string, DiscoverCardState>;
  variant?: "poster" | "landscape";
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  if (!items.length) return null;
  const scroll = (direction: number) =>
    rowRef.current?.scrollBy({ left: direction * rowRef.current.clientWidth * 0.8, behavior: "smooth" });

  return (
    <section className="group/row relative mb-11 pl-6 md:pl-12 lg:pl-16">
      <div className="mb-4 flex items-end gap-3">
        <h2 className="text-xl font-bold tracking-[-0.025em]">{title}</h2>
        <span className="mb-0.5 text-[10px] font-bold uppercase tracking-[0.17em] text-zinc-600">{tagline}</span>
      </div>
      <button
        onClick={() => scroll(-1)}
        aria-label="Scroll left"
        className="absolute bottom-3 left-0 top-10 z-20 hidden w-11 items-center justify-center bg-gradient-to-r from-surface to-transparent opacity-0 transition group-hover/row:opacity-100 md:flex"
      >
        <ChevronLeft />
      </button>
      <div ref={rowRef} className="no-scrollbar flex gap-4 overflow-x-auto pb-5 pr-6 md:pr-12 lg:pr-16">
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
        onClick={() => scroll(1)}
        aria-label="Scroll right"
        className="absolute bottom-3 right-0 top-10 z-20 hidden w-14 items-center justify-center bg-gradient-to-l from-surface to-transparent opacity-0 transition group-hover/row:opacity-100 md:flex"
      >
        <ChevronRight />
      </button>
    </section>
  );
}
