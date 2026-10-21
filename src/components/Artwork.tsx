import { useEffect, useState, type ImgHTMLAttributes } from "react";
import Brand from "@/components/Brand";
import { artworkSrcSet } from "@/lib/artwork";

type ArtworkVariant = "poster" | "landscape" | "backdrop" | "compact";

interface ArtworkProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "title" | "srcSet"> {
  src?: string | null;
  title: string;
  variant?: ArtworkVariant;
  fallbackClassName?: string;
  /** CSS width the image is drawn at; with it the browser loads the size this screen needs. */
  sizes?: string;
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
      className={`relative isolate overflow-hidden bg-[radial-gradient(120%_90%_at_20%_0%,#262626_0%,#101010_55%,#050505_100%)] ${className}`}
    >
      <div className="absolute inset-[1px] rounded-[inherit] ring-1 ring-inset ring-white/[0.08]" />

      <div className={`relative flex h-full w-full flex-col items-center justify-center text-center ${compact ? "p-1" : "p-5"}`}>
        {compact ? (
          <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/20 bg-black/30 text-xs font-black tracking-wide text-white">
            {initials(title)}
          </span>
        ) : (
          <>
            <Brand compact height={variant === "backdrop" ? 44 : 34} className="text-white/85" />
            <p className={`mt-3 max-w-[90%] font-display leading-tight text-zinc-100 ${variant === "backdrop" ? "text-xl" : "text-[15px]"}`}>
              {title}
            </p>
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
  sizes,
  ...imageProps
}: ArtworkProps) {
  // 0: the size for this screen, 1: the URL as the catalogue gave it, 2: failed.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => setAttempt(0), [src]);

  const srcSet = sizes && attempt === 0 ? artworkSrcSet(src) : undefined;

  if (!src || attempt === 2) {
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
      key={`${src}#${attempt}`}
      {...imageProps}
      src={src}
      srcSet={srcSet}
      sizes={srcSet ? sizes : undefined}
      alt={alt}
      decoding={imageProps.decoding ?? "async"}
      className={`akflix-artwork ${className}`}
      onError={() => setAttempt(srcSet ? 1 : 2)}
    />
  );
}
