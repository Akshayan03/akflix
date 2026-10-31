/**
 * Windowed playback without black bands: when the player opens in a window,
 * the window takes the picture's shape (same width, or smaller when that is
 * too tall for the screen), once per title. The window's size and minimum
 * size come back when the player closes, unless the viewer resized it
 * meanwhile. Full screen and zoomed (maximized) windows are left alone.
 */
import { useEffect, useRef } from "react";
import { isTauri } from "@/lib/http";

export interface Size {
  width: number;
  height: number;
}

/** The browse UI's minimum (tauri.conf.json); the player allows a smaller window. */
export const BROWSE_MIN_SIZE: Size = { width: 960, height: 600 };
export const PLAYER_MIN_SIZE: Size = { width: 640, height: 360 };
/** Room left for the menu bar and Dock. */
const SCREEN_MARGIN = 48;

/** The window size (logical px) that fits `video` exactly, or null when it already does. */
export function fittedWindowSize(window: Size, video: Size, screen: Size, min: Size = PLAYER_MIN_SIZE): Size | null {
  if (!(video.width > 0 && video.height > 0 && window.width > 0 && window.height > 0)) return null;
  const aspect = video.width / video.height;
  const maxWidth = Math.max(min.width, screen.width - SCREEN_MARGIN);
  const maxHeight = Math.max(min.height, screen.height - SCREEN_MARGIN);
  let width = Math.min(window.width, maxWidth);
  let height = width / aspect;
  if (height > maxHeight) {
    height = maxHeight;
    width = height * aspect;
  }
  if (height < min.height) {
    height = min.height;
    width = Math.min(maxWidth, height * aspect);
  }
  if (width < min.width) {
    width = min.width;
    height = Math.min(maxHeight, width / aspect);
  }
  const fitted = { width: Math.round(width), height: Math.round(height) };
  if (Math.abs(fitted.width - window.width) <= 2 && Math.abs(fitted.height - window.height) <= 2) return null;
  return fitted;
}

/**
 * Fit the desktop window to the picture while `active` (the expanded player),
 * once per `titleKey`, and put it back afterwards.
 */
export function useWindowFit(active: boolean, titleKey: string | null, video: Size | null) {
  const saved = useRef<{ size: Size; applied: Size | null } | null>(null);
  const fittedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!isTauri() || !active || !titleKey || !video || fittedFor.current === titleKey) return;
    let cancelled = false;
    void (async () => {
      try {
        const { getCurrentWindow, currentMonitor, LogicalSize } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        if ((await win.isFullscreen()) || (await win.isMaximized())) return;
        const scale = await win.scaleFactor();
        const inner = (await win.innerSize()).toLogical(scale);
        const monitor = await currentMonitor();
        const area = monitor?.workArea.size.toLogical(monitor.scaleFactor) ?? { width: 1440, height: 900 };
        if (cancelled) return;
        // The viewer resized the window since the last fit: leave it.
        const previous = saved.current;
        if (previous?.applied && (Math.abs(previous.applied.width - inner.width) > 2 || Math.abs(previous.applied.height - inner.height) > 2)) {
          fittedFor.current = titleKey;
          return;
        }
        const target = fittedWindowSize(inner, video, area);
        fittedFor.current = titleKey;
        if (!saved.current) saved.current = { size: { width: inner.width, height: inner.height }, applied: null };
        await win.setMinSize(new LogicalSize(PLAYER_MIN_SIZE.width, PLAYER_MIN_SIZE.height));
        if (!target) return;
        await win.setSize(new LogicalSize(target.width, target.height));
        saved.current.applied = target;
      } catch (error) {
        console.warn("[window] could not fit the window to the picture", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, titleKey, video?.width, video?.height]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (active || !saved.current || !isTauri()) return;
    const restore = saved.current;
    saved.current = null;
    fittedFor.current = null;
    void (async () => {
      try {
        const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        if (await win.isFullscreen()) {
          await win.setMinSize(new LogicalSize(BROWSE_MIN_SIZE.width, BROWSE_MIN_SIZE.height));
          return;
        }
        const inner = (await win.innerSize()).toLogical(await win.scaleFactor());
        const untouched =
          !restore.applied ||
          (Math.abs(restore.applied.width - inner.width) <= 2 && Math.abs(restore.applied.height - inner.height) <= 2);
        if (untouched && restore.applied) {
          await win.setSize(new LogicalSize(restore.size.width, restore.size.height));
        } else if (inner.width < BROWSE_MIN_SIZE.width || inner.height < BROWSE_MIN_SIZE.height) {
          await win.setSize(
            new LogicalSize(Math.max(inner.width, BROWSE_MIN_SIZE.width), Math.max(inner.height, BROWSE_MIN_SIZE.height))
          );
        }
        await win.setMinSize(new LogicalSize(BROWSE_MIN_SIZE.width, BROWSE_MIN_SIZE.height));
      } catch (error) {
        console.warn("[window] could not restore the window size", error);
      }
    })();
  }, [active]);
}
