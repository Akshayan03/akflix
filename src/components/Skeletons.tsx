/**
 * Loading skeletons — shimmer placeholders matching the real layout so the
 * page doesn't jump when data arrives.
 */

export function CardSkeleton({ variant = "poster" }: { variant?: "poster" | "landscape" }) {
  return (
    <div
      className={`skeleton shrink-0 ${
        variant === "landscape"
          ? "aspect-video w-[82vw] max-w-[340px] md:w-[300px] xl:w-[340px]"
          : "aspect-[2/3] w-[138px] md:w-[164px] xl:w-[184px] 2xl:w-[204px]"
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
    <section className="mb-8 md:mb-10" aria-hidden="true">
      <div className="ak-gutter mb-3">
        <div className="skeleton h-5 w-44 !rounded-md" />
      </div>
      <div className="ak-row-scroller no-scrollbar !overflow-hidden">
        {Array.from({ length: cards }).map((_, i) => (
          <CardSkeleton key={i} variant={variant} />
        ))}
      </div>
    </section>
  );
}

/** Hero placeholder: a quiet surface (no full-screen shimmer) and copy blocks. */
export function HeroSkeleton() {
  return (
    <div className="relative h-[min(80vh,860px)] min-h-[540px] w-full overflow-hidden bg-[radial-gradient(120%_80%_at_70%_20%,#161616_0%,#0a0a0a_55%,#000_100%)]" aria-hidden="true">
      <div className="ak-gutter absolute inset-x-0 bottom-[clamp(104px,15vh,156px)]">
        <div className="skeleton mb-5 h-3 w-28 !rounded-md" />
        <div className="skeleton mb-3 h-14 w-[min(520px,70vw)] !rounded-lg" />
        <div className="skeleton mb-5 h-4 w-56 !rounded-md" />
        <div className="skeleton mb-2 h-4 w-[min(560px,70vw)] !rounded-md" />
        <div className="skeleton mb-7 h-4 w-[min(420px,55vw)] !rounded-md" />
        <div className="skeleton h-[42px] w-36 !rounded-full" />
      </div>
    </div>
  );
}

/** Title details placeholder with the same hero, copy and control geometry. */
export function TitleSkeleton() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-surface">
      <div className="relative h-[min(86vh,880px)] min-h-[580px] bg-[radial-gradient(120%_80%_at_70%_20%,#161616_0%,#0a0a0a_55%,#000_100%)]" aria-hidden="true">
        <div className="ak-gutter absolute inset-x-0 bottom-0 pb-[clamp(36px,6vh,64px)]">
          <div className="skeleton mb-4 h-3 w-16 !rounded-md" />
          <div className="skeleton mb-4 h-16 w-[min(560px,75vw)] !rounded-lg" />
          <div className="skeleton mb-5 h-4 w-64 !rounded-md" />
          <div className="skeleton mb-2 h-4 w-[min(600px,75vw)] !rounded-md" />
          <div className="skeleton mb-7 h-4 w-[min(440px,60vw)] !rounded-md" />
          <div className="flex gap-3">
            <div className="skeleton h-[42px] w-[148px] !rounded-full" />
            <div className="skeleton h-[42px] w-40 !rounded-full" />
          </div>
        </div>
      </div>
      <p role="status" className="sr-only">Loading title details</p>
    </div>
  );
}

/** Full home-page skeleton: hero + a few rows. */
export function HomeSkeleton() {
  return (
    <div className="pb-16" role="status" aria-label="Loading catalog">
      <HeroSkeleton />
      <div className="relative z-10 -mt-8 md:-mt-20">
        <RowSkeleton />
        <RowSkeleton />
        <RowSkeleton />
      </div>
    </div>
  );
}

/** Catalog placeholder with the same geometry as Movies and Shows pages. */
export function CatalogSkeleton() {
  return (
    <div role="status" aria-label="Loading catalog" className="min-h-screen pb-20 pt-[calc(env(safe-area-inset-top,0px)+4.75rem)] md:pt-0">
      <div className="skeleton mx-4 aspect-[16/11] rounded-[28px] md:hidden" />
      <div className="hidden md:block"><HeroSkeleton /></div>
      <div className="relative z-10 mt-7 md:-mt-20">
        <RowSkeleton />
        <RowSkeleton />
      </div>
    </div>
  );
}
