import { APPLE_MARK, GOOGLE_MARK } from "@/components/signInMarkPaths";

export function AppleLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox={APPLE_MARK.viewBox} aria-hidden="true" fill="currentColor">
      <path d={APPLE_MARK.path} />
    </svg>
  );
}

/** Google's "G" in Google's colours, as its sign-in branding requires. */
export function GoogleLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox={GOOGLE_MARK.viewBox} aria-hidden="true">
      {GOOGLE_MARK.paths.map(([fill, d]) => (
        <path key={fill} fill={fill} d={d} />
      ))}
    </svg>
  );
}
