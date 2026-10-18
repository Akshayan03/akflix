import { AnimatePresence, motion } from "framer-motion";
import { Check, Plus } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/stores/authStore";
import { isSaved, useMyList } from "@/stores/listStore";
import type { HistoryTitle } from "@/stores/historyStore";

/** Saves a catalog title to My List (synced to the Akflix account when signed in). */
export default function MyListButton({ media, variant = "stacked" }: { media: HistoryTitle; variant?: "stacked" | "pill" }) {
  const profileId = useAuth((state) => state.activeProfileId) ?? "akflix-local";
  const saved = useMyList((state) => isSaved(state.items, profileId, media));
  const toggle = useMyList((state) => state.toggle);

  const onClick = () => {
    const nowSaved = toggle(media);
    toast(nowSaved ? "Added to My List" : "Removed from My List", { description: media.name, duration: 1800 });
  };

  const icon = (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={saved ? "saved" : "add"}
        initial={{ scale: 0.4, opacity: 0, rotate: saved ? -45 : 45 }}
        animate={{ scale: 1, opacity: 1, rotate: 0 }}
        exit={{ scale: 0.4, opacity: 0 }}
        transition={{ type: "spring", stiffness: 520, damping: 26 }}
        className="grid place-items-center"
      >
        {saved ? <Check size={20} strokeWidth={2.6} /> : <Plus size={20} strokeWidth={2.2} />}
      </motion.span>
    </AnimatePresence>
  );

  if (variant === "pill") {
    return (
      <motion.button
        type="button"
        whileTap={{ scale: 0.95 }}
        onClick={onClick}
        aria-pressed={saved}
        className="glass-panel flex items-center gap-2 rounded-2xl px-5 py-3.5 text-sm font-semibold transition hover:-translate-y-0.5 hover:bg-white/[0.10]"
      >
        {icon}
        {saved ? "In My List" : "My List"}
      </motion.button>
    );
  }

  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.92 }}
      onClick={onClick}
      aria-pressed={saved}
      aria-label={saved ? `Remove ${media.name} from My List` : `Add ${media.name} to My List`}
      className="flex shrink-0 flex-col items-center gap-1.5 pb-1 text-[10px] font-semibold text-zinc-300"
    >
      <span
        className={`grid h-11 w-11 place-items-center rounded-full border transition-colors ${
          saved ? "border-white bg-white text-black" : "border-white/25 bg-black/40 text-white"
        }`}
      >
        {icon}
      </span>
      My List
    </motion.button>
  );
}
