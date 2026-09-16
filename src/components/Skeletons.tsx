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

/** Title details placeholder that keeps the poster, copy, and controls stable. */
export function TitleSkeleton() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-surface">
      <div className="skeleton absolute inset-x-0 top-0 h-[78vh] !rounded-none opacity-70" />
      <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/55 to-black/30" />
      <div className="absolute bottom-20 left-6 right-6 flex items-end gap-8 md:left-12">
        <div className="skeleton hidden aspect-[2/3] w-44 shrink-0 rounded-2xl lg:block" />
        <div className="w-full max-w-2xl">
          <div className="skeleton mb-5 h-3 w-36" />
          <div className="skeleton mb-4 h-16 w-[min(560px,80vw)]" />
          <div className="mb-5 flex gap-2">
            <div className="skeleton h-7 w-16 rounded-full" />
            <div className="skeleton h-7 w-20 rounded-full" />
            <div className="skeleton h-7 w-24 rounded-full" />
          </div>
          <div className="skeleton mb-2 h-4 w-full" />
          <div className="skeleton mb-7 h-4 w-3/4" />
          <div className="flex gap-3">
            <div className="skeleton h-12 w-36 rounded-2xl" />
            <div className="skeleton h-12 w-40 rounded-2xl" />
          </div>
        </div>
      </div>
      <p className="absolute bottom-8 left-0 right-0 text-center text-xs font-medium text-zinc-500">
        Loading title details
      </p>
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

/** Catalog placeholder with the same geometry as Movies and Shows pages. */
export function CatalogSkeleton() {
  return (
    <div className="min-h-screen pb-20 pt-[calc(env(safe-area-inset-top,0px)+4.75rem)] md:pt-0">
      <div className="skeleton mx-4 aspect-[16/11] rounded-[28px] md:mx-0 md:h-[72vh] md:min-h-[520px] md:aspect-auto md:!rounded-none" />
      <div className="relative z-10 mt-7 md:-mt-20">
        <RowSkeleton />
        <RowSkeleton />
      </div>
    </div>
  );
}
