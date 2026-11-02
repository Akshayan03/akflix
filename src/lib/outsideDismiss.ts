/**
 * Closes the player's open panel (Audio & subtitles, speed, episodes) when the
 * viewer clicks or taps anywhere else, the way a popover should. That first
 * press only closes it: it is swallowed in the capture phase, before the video
 * surface, the play button or the timeline can see it, so it never also
 * pauses, seeks or toggles fullscreen.
 */

type Listener = (event: Event) => void;

export interface DismissTarget {
  addEventListener(type: string, listener: Listener, options?: AddEventListenerOptions | boolean): void;
  removeEventListener(type: string, listener: Listener, options?: EventListenerOptions | boolean): void;
}

/** Events of one press after pointerdown; the click (or a stray double click) ends it. */
const FOLLOW_UPS = ["mousedown", "pointerup", "mouseup", "click", "dblclick", "touchstart", "touchend"] as const;

/**
 * Installs the capture listeners while a panel is open; returns the cleanup.
 * `isInside(event)`: the press belongs to the panel (or to a control that
 * switches panels), so it goes through untouched.
 */
export function installOutsideDismiss(
  target: DismissTarget,
  isInside: (event: Event) => boolean,
  dismiss: () => void,
  now: () => number = Date.now,
): () => void {
  // Time the swallowing started; a press that never sends its click (dragged
  // off the window) stops counting after a moment.
  let swallowingSince: number | null = null;
  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };
  const onPointerDown: Listener = (event) => {
    if (isInside(event)) return;
    swallow(event);
    swallowingSince = now();
    dismiss();
  };
  const onFollowUp: Listener = (event) => {
    if (swallowingSince === null) return;
    if (now() - swallowingSince > 1500) {
      swallowingSince = null;
      return;
    }
    swallow(event);
    if (event.type === "click") swallowingSince = null;
  };
  const options = { capture: true };
  target.addEventListener("pointerdown", onPointerDown, options);
  for (const type of FOLLOW_UPS) target.addEventListener(type, onFollowUp, options);
  return () => {
    target.removeEventListener("pointerdown", onPointerDown, options);
    const remove = () => {
      for (const type of FOLLOW_UPS) target.removeEventListener(type, onFollowUp, options);
    };
    // The closing press's click arrives after the panel is gone: keep
    // swallowing it (onFollowUp goes quiet after it) before letting go.
    if (swallowingSince === null) remove();
    else setTimeout(remove, 1500);
  };
}

/** The press is in an open panel or on a control marked `data-panel-toggle`. */
export function pressIsInPanel(event: Event): boolean {
  const node = event.target as { closest?: (selector: string) => unknown } | null;
  if (!node || typeof node.closest !== "function") return false;
  return Boolean(node.closest(".ak-pop, .ak-episodes--open, [data-panel-toggle]"));
}
