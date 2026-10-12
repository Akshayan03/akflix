import logo from "@/brand/logo.json";

interface BrandProps {
  /** Mark only (the play-counter "a"); otherwise the full "akflix" wordmark. */
  compact?: boolean;
  /** Rendered height in CSS pixels. */
  height?: number;
  className?: string;
}

const aspect = (viewBox: string) => {
  const [, , width, height] = viewBox.split(" ").map(Number);
  return width / height;
};

/**
 * Akflix's monochrome identity: a geometric lowercase "a" whose counter is a
 * play triangle, and a wordmark drawn from the same construction. Rendered
 * from vector path data (src/brand/logo.json) so it is identical in the app,
 * the app icons and the website, and inherits `currentColor`.
 */
export default function Brand({ compact = false, height, className = "" }: BrandProps) {
  const shape = compact ? logo.mark : logo.wordmark;
  const h = height ?? (compact ? 28 : 20);
  return (
    <svg
      role="img"
      aria-label="Akflix"
      viewBox={shape.viewBox}
      height={h}
      width={Math.round(h * aspect(shape.viewBox) * 100) / 100}
      className={`block shrink-0 select-none fill-current ${className}`}
    >
      <path d={shape.path} />
    </svg>
  );
}
