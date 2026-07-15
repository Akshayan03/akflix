import { isTauri } from "@/lib/http";

/** Safari can request a desktop user agent on iPad, so include touch points. */
export const isAppleMobile = (): boolean => {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
};

export const isDesktopMac = (): boolean =>
  isTauri() && !isAppleMobile() && /Mac/i.test(navigator.userAgent);

/** Mobile Akflix intentionally accepts hosted/direct sources only. */
export const supportsEmbeddedPlayback = (): boolean => isTauri() && !isAppleMobile();
