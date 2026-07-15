import { motion } from "framer-motion";
import { Play, Star } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { StremioMeta } from "@/types/stremio";
import Artwork from "@/components/Artwork";

export default function DiscoverCard({ item }: { item: StremioMeta }) {
  const navigate = useNavigate();
  const open = () => navigate(`/discover/${item.type}/${item.id}`);

  return (
    <motion.button
      whileHover={{ y: -7, scale: 1.018, zIndex: 10 }}
      transition={{ type: "spring", stiffness: 320, damping: 24 }}
      onClick={open}
      className="group relative aspect-[2/3] w-40 shrink-0 overflow-hidden rounded-[20px] border border-white/[0.08] bg-surface-raised text-left shadow-[0_14px_35px_rgba(0,0,0,.18)] md:w-48"
    >
      <Artwork
        src={item.poster}
        title={item.name}
        variant="poster"
        alt={item.name}
        loading="lazy"
        className="h-full w-full object-cover transition duration-700 group-hover:scale-[1.045] group-hover:saturate-[1.12]"
        draggable={false}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-[#090806] via-black/5 to-transparent opacity-90" />
      <div className="absolute inset-x-0 bottom-0 p-4">
        <p className="truncate text-sm font-bold tracking-tight">{item.name}</p>
        <div className="mt-1.5 flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-zinc-400">
          <span>{item.releaseInfo ?? item.year ?? item.type}</span>
          {item.imdbRating && <span className="flex items-center gap-1 text-accent"><Star size={9} fill="currentColor" /> {item.imdbRating}</span>}
        </div>
      </div>
      <span className="absolute right-3 top-3 flex h-9 w-9 translate-y-1 items-center justify-center rounded-xl bg-white text-black opacity-0 shadow-xl transition duration-300 group-hover:translate-y-0 group-hover:opacity-100">
        <Play size={14} fill="currentColor" />
      </span>
      <div className="absolute inset-0 rounded-[20px] ring-1 ring-inset ring-transparent transition group-hover:ring-brand-light/50" />
    </motion.button>
  );
}
