import { ChevronLeft, ChevronRight } from "lucide-react";
import { useRef } from "react";
import { motion } from "framer-motion";
import DiscoverCard from "@/components/DiscoverCard";
import type { DiscoverCardState } from "@/components/DiscoverCard";
import type { StremioMeta } from "@/types/stremio";

export default function DiscoverRow({
  title,
  items,
  tagline = "Curated for you",
  cardState,
  variant = "poster",
  id,
}: {
  title: string;
  items: StremioMeta[];
  tagline?: string;
  cardState?: Record<string, DiscoverCardState>;
  variant?: "poster" | "landscape";
  id?: string;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  if (!items.length) return null;
  const scroll = (direction: number) =>
    rowRef.current?.scrollBy({ left: direction * rowRef.current.clientWidth * 0.8, behavior: "smooth" });

  return (
    <motion.section
      id={id}
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-70px" }}
      transition={{ duration: 0.48, ease: [0.22, 1, 0.36, 1] }}
      className="group/row relative mb-8 pl-4 md:mb-11 md:pl-12 lg:pl-16"
    >
      <div className="mb-3 flex items-end gap-3 pr-4 md:mb-4">
        <h2 className="text-[19px] font-black tracking-[-0.03em] md:text-xl md:font-bold">{title}</h2>
        <span className="mb-0.5 hidden text-[10px] font-bold uppercase tracking-[0.17em] text-zinc-600 sm:inline">{tagline}</span>
      </div>
      <button
        onClick={() => scroll(-1)}
        aria-label="Scroll left"
        className="absolute bottom-3 left-0 top-10 z-20 hidden w-11 items-center justify-center bg-gradient-to-r from-surface to-transparent opacity-0 transition group-hover/row:opacity-100 md:flex"
      >
        <ChevronLeft />
      </button>
      <div ref={rowRef} className="no-scrollbar flex snap-x snap-proximity gap-3 overflow-x-auto pb-4 pr-4 md:gap-4 md:pb-5 md:pr-12 lg:pr-16">
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
    </motion.section>
  );
}
