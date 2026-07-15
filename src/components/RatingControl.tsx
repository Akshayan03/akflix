import { useState } from "react";
import { Star, X } from "lucide-react";

const LABELS = ["", "Not for me", "Disliked", "It was okay", "Liked it", "Loved it"];

export default function RatingControl({
  value,
  onChange,
}: {
  value?: number;
  onChange: (value: number | null) => void;
}) {
  const [hovered, setHovered] = useState(0);
  const displayed = hovered || value || 0;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/[0.08] bg-black/20 px-4 py-3 backdrop-blur-xl">
      <div>
        <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-zinc-500">Your rating</p>
        <p className="mt-0.5 min-w-20 text-xs font-semibold text-zinc-200">
          {displayed ? LABELS[displayed] : "Rate this title"}
        </p>
      </div>
      <div className="flex items-center gap-1" onMouseLeave={() => setHovered(0)}>
        {[1, 2, 3, 4, 5].map((rating) => (
          <button
            key={rating}
            type="button"
            aria-label={`${rating} star${rating === 1 ? "" : "s"}`}
            title={LABELS[rating]}
            onMouseEnter={() => setHovered(rating)}
            onFocus={() => setHovered(rating)}
            onBlur={() => setHovered(0)}
            onClick={() => onChange(rating)}
            className={`rounded-lg p-1.5 transition hover:scale-110 ${
              rating <= displayed ? "text-accent" : "text-zinc-700 hover:text-zinc-400"
            }`}
          >
            <Star size={18} fill={rating <= displayed ? "currentColor" : "none"} />
          </button>
        ))}
      </div>
      {value && (
        <button
          type="button"
          onClick={() => onChange(null)}
          aria-label="Clear rating"
          title="Clear rating"
          className="ml-auto rounded-lg p-1.5 text-zinc-600 transition hover:bg-white/[0.06] hover:text-zinc-300"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
