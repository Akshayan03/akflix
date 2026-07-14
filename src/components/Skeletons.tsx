/**
 * Loading skeletons — shimmer placeholders matching the real layout so the
 * page doesn't jump when data arrives.
 */

export function CardSkeleton({ variant = "poster" }: { variant?: "poster" | "landscape" }) {
  return (
    <div
      className={`skeleton shrink-0 ${
        variant === "landscape" ? "aspect-video w-64" : "aspect-[2/3] w-36 md:w-44"
      }`}
    />
  );
}

export function RowSkeleton({
  variant = "poster",
  cards = 8,
}: {
  variant?: "poster" | "landscape";
  cards?: number;
}) {
  return (
    <section className="mb-8">
      <div className="skeleton mx-6 mb-3 h-6 w-48 md:mx-12" />
      <div className="no-scrollbar flex gap-2 overflow-hidden px-6 py-2 md:px-12">
        {Array.from({ length: cards }).map((_, i) => (
          <CardSkeleton key={i} variant={variant} />
        ))}
      </div>
    </section>
  );
}

export function HeroSkeleton() {
  return (
    <div className="relative h-[72vh] min-h-[420px] w-full overflow-hidden">
      <div className="skeleton absolute inset-0 !rounded-none" />
      <div className="absolute inset-0 bg-gradient-to-t from-surface via-transparent to-transparent" />
      <div className="absolute bottom-[12%] left-6 md:left-12">
        <div className="skeleton mb-4 h-12 w-80" />
        <div className="skeleton mb-2 h-4 w-96 max-w-[70vw]" />
        <div className="skeleton mb-6 h-4 w-72" />
        <div className="flex gap-3">
          <div className="skeleton h-11 w-32" />
          <div className="skeleton h-11 w-36" />
        </div>
      </div>
    </div>
  );
}

/** Full home-page skeleton: hero + a few rows. */
export function HomeSkeleton() {
  return (
    <div className="pb-16">
      <HeroSkeleton />
      <div className="relative z-10 -mt-24">
        <RowSkeleton variant="landscape" cards={5} />
        <RowSkeleton />
        <RowSkeleton />
      </div>
    </div>
  );
}
