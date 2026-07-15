import { useEffect, useState, type ImgHTMLAttributes } from "react";
import Brand from "@/components/Brand";

type ArtworkVariant = "poster" | "landscape" | "backdrop" | "compact";

interface ArtworkProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "title"> {
  src?: string | null;
  title: string;
  variant?: ArtworkVariant;
  fallbackClassName?: string;
}

function initials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "A";
  return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
}

export function ArtworkFallback({
  title,
  variant = "poster",
  className = "",
}: {
  title: string;
  variant?: ArtworkVariant;
  className?: string;
}) {
  const compact = variant === "compact";

  return (
    <div
      role="img"
      aria-label={`${title} artwork`}
      className={`relative isolate overflow-hidden bg-[#12100c] ${className}`}
    >
      <div className="absolute -left-[18%] -top-[22%] h-[70%] w-[70%] rounded-full bg-brand/20 blur-[38px]" />
      <div className="absolute -bottom-[24%] -right-[15%] h-[64%] w-[64%] rounded-full bg-accent/[0.08] blur-[34px]" />
      <div className="absolute inset-0 opacity-30 [background-image:linear-gradient(115deg,transparent_0%,rgba(255,255,255,.08)_48%,transparent_49%)]" />
      <div className="absolute inset-[1px] rounded-[inherit] ring-1 ring-inset ring-white/[0.07]" />

      <div className={`relative flex h-full w-full flex-col items-center justify-center text-center ${compact ? "p-1" : "p-5"}`}>
        {compact ? (
          <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-brand/25 bg-black/25 text-xs font-black tracking-wide text-brand-light">
            {initials(title)}
          </span>
        ) : (
          <>
            <Brand compact className="[&_svg]:!h-11 [&_svg]:!w-11" />
            <p className={`mt-3 max-w-[90%] font-bold leading-tight text-zinc-100 ${variant === "backdrop" ? "text-lg" : "text-sm"}`}>
              {title}
            </p>
            <span className="mt-2 text-[8px] font-bold uppercase tracking-[0.24em] text-brand-light/60">Akflix</span>
          </>
        )}
      </div>
    </div>
  );
}

export default function Artwork({
  src,
  title,
  variant = "poster",
  className = "",
  fallbackClassName,
  alt = "",
  ...imageProps
}: ArtworkProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [src]);

  if (!src || failed) {
    return (
      <ArtworkFallback
        title={title}
        variant={variant}
        className={fallbackClassName ?? className}
      />
    );
  }

  return (
    <img
      {...imageProps}
      src={src}
      alt={alt}
      className={className}
      onError={() => setFailed(true)}
    />
  );
}
