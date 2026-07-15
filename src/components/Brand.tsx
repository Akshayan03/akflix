interface BrandProps {
  compact?: boolean;
  className?: string;
}

/** Akflix's original prism mark: an A silhouette with a play aperture. */
export default function Brand({ compact = false, className = "" }: BrandProps) {
  return (
    <span className={`inline-flex select-none items-center gap-2.5 ${className}`} aria-label="Akflix">
      <svg viewBox="0 0 48 48" className="h-9 w-9 shrink-0 drop-shadow-[0_0_18px_rgba(214,178,94,.25)]" aria-hidden="true">
        <defs>
          <linearGradient id="akflix-prism" x1="8" y1="7" x2="41" y2="42" gradientUnits="userSpaceOnUse">
            <stop stopColor="#FFF0C7" />
            <stop offset="0.5" stopColor="#D6B25E" />
            <stop offset="1" stopColor="#98752F" />
          </linearGradient>
          <linearGradient id="akflix-shell" x1="4" y1="4" x2="44" y2="44" gradientUnits="userSpaceOnUse">
            <stop stopColor="#1F1B14" />
            <stop offset="1" stopColor="#090806" />
          </linearGradient>
        </defs>
        <rect x="2" y="2" width="44" height="44" rx="13" fill="url(#akflix-shell)" stroke="rgba(255,255,255,.12)" />
        <path d="M11.5 35.5 20.6 12a3.65 3.65 0 0 1 6.8 0l9.1 23.5h-7l-1.85-5.35h-7.4l-1.8 5.35h-6.95Z" fill="url(#akflix-prism)" />
        <path d="m21.25 19.2 8.2 5.2-8.2 5.2V19.2Z" fill="#090806" />
      </svg>
      {!compact && (
        <span className="text-[18px] font-black uppercase tracking-[0.13em] text-white">
          AK<span className="font-medium text-zinc-400">FLIX</span>
        </span>
      )}
    </span>
  );
}
