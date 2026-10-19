/**
 * How the player shows captions: WebKit's native renderer draws the <track>
 * the viewer selected and nothing else, framed to the picture.
 */

export interface CaptionFrame {
  /** The picture inside the element, in CSS pixels from its top left. */
  top: number;
  left: number;
  width: number;
  /** From the picture's top to the bottom edge of the lowest caption line. */
  height: number;
  fontSize: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Where captions go in a <video> whose picture is letterboxed (object-fit:
 * contain). WebKit lays them out over the whole element, which put them in
 * the black bar at the window's bottom edge. Instead: over the picture, the
 * last line a little above its bottom edge, and above whatever covers the
 * bottom of the element (the visible controls), but never pushed up into the
 * top half of the picture. Null until the video's size is known.
 */
export function captionFrame(
  element: { width: number; height: number },
  picture: { width: number; height: number },
  coveredBottom = 0
): CaptionFrame | null {
  if (!(element.width > 0 && element.height > 0 && picture.width > 0 && picture.height > 0)) return null;
  const scale = Math.min(element.width / picture.width, element.height / picture.height);
  const width = picture.width * scale;
  const height = picture.height * scale;
  const left = (element.width - width) / 2;
  const top = (element.height - height) / 2;
  const margin = clamp(height * 0.06, 8, 64);
  const clearOfControls = coveredBottom > 0 ? element.height - coveredBottom - 12 : Infinity;
  const bottom = Math.max(top + height * 0.55, Math.min(top + height - margin, clearOfControls));
  return {
    top,
    left,
    width,
    height: bottom - top,
    // About today's size in an ordinary window, larger full screen, small in the mini player.
    fontSize: clamp(height * 0.026, height < 300 ? 12 : 16, 40),
  };
}

/**
 * Show only `selected` (null: captions off). Every other caption track is
 * disabled: ours, the file's own in-band ones and whatever WebKit's automatic
 * caption selection turned on when tracks were added. Metadata and chapter
 * tracks are not drawn and belong to their owners (hls.js), so they are left be.
 */
export function showOnlyCaptionTrack(
  tracks: ArrayLike<{ mode: TextTrackMode; kind: string }>,
  selected: { mode: TextTrackMode } | null
) {
  for (const track of Array.from(tracks)) {
    if ((track.kind === "metadata" || track.kind === "chapters") && track !== selected) continue;
    const mode: TextTrackMode = track === selected ? "showing" : "disabled";
    if (track.mode !== mode) track.mode = mode;
  }
}
