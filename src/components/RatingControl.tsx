import { useState } from "react";
import { Star, X } from "lucide-react";

const LABELS = ["", "Not for me", "Disliked", "It was okay", "Liked it", "Loved it"];

export default function RatingControl({
  value,
  onChange,
  compact = false,
}: {
  value?: number;
  onChange: (value: number | null) => void;
  /** Inline stars without the panel (desktop title pages). */
  compact?: boolean;
}) {
  const [hovered, setHovered] = useState(0);
  const displayed = hovered || value || 0;

  if (compact) {
    return (
      <div className="flex items-center gap-1.5">
        <div className="flex items-center" role="group" aria-label="Rate this title" onMouseLeave={() => setHovered(0)}>
          {[1, 2, 3, 4, 5].map((rating) => (
            <button
              key={rating}
              type="button"
              aria-label={`${rating} star${rating === 1 ? "" : "s"}: ${LABELS[rating]}`}
              aria-pressed={value === rating}
              title={LABELS[rating]}
              onMouseEnter={() => setHovered(rating)}
              onFocus={() => setHovered(rating)}
              onBlur={() => setHovered(0)}
              onClick={() => onChange(rating)}
              className={`rounded-md p-1 transition duration-100 active:scale-90 ${
                rating <= displayed ? "text-white" : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <Star size={17} fill={rating <= displayed ? "currentColor" : "none"} />
            </button>
          ))}
        </div>
        <span aria-live="polite" className="min-w-[88px] text-xs font-medium text-zinc-400">
          {displayed ? LABELS[displayed] : "Rate it"}
        </span>
        {value && (
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label="Clear rating"
            title="Clear rating"
            className="ak-icon-button !h-7 !w-7 text-zinc-400"
          >
            <X size={13} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/[0.1] bg-black/30 px-4 py-3 backdrop-blur-xl">
      <div>
        <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-zinc-400">Your rating</p>
        <p className="mt-0.5 min-w-20 text-xs font-semibold text-zinc-200">
          {displayed ? LABELS[displayed] : "Rate this title"}
        </p>
      </div>
      <div className="flex items-center gap-1" role="group" aria-label="Rate this title" onMouseLeave={() => setHovered(0)}>
        {[1, 2, 3, 4, 5].map((rating) => (
          <button
            key={rating}
            type="button"
            aria-label={`${rating} star${rating === 1 ? "" : "s"}: ${LABELS[rating]}`}
            aria-pressed={value === rating}
            title={LABELS[rating]}
            onMouseEnter={() => setHovered(rating)}
            onFocus={() => setHovered(rating)}
            onBlur={() => setHovered(0)}
            onClick={() => onChange(rating)}
            className={`rounded-lg p-1.5 transition duration-150 hover:scale-110 active:scale-95 ${
              rating <= displayed ? "text-white" : "text-zinc-500 hover:text-zinc-300"
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
          className="ml-auto rounded-lg p-1.5 text-zinc-400 transition hover:bg-white/[0.08] hover:text-white"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
