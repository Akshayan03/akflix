/** The parts of TimeRanges a seek decision reads. */
export interface SeekableRanges {
  readonly length: number;
  start(index: number): number;
  end(index: number): number;
}

/**
 * Where a skip inside a compatibility (converted) stream can land without
 * restarting the converter, as a time on the current conversion's clock, or
 * null when the target is outside what it has produced.
 *
 * The conversion keeps every segment, so anything already produced is an
 * ordinary seek. WebKit's seekable end trails the newest segment, so stay
 * inside it. Right after a stream loads WebKit reports that end as Infinity,
 * which says nothing about what exists yet.
 */
export function convertedSeekTime(
  seekable: SeekableRanges,
  conversionStart: number,
  target: number
): number | null {
  if (!seekable.length) return null;
  const end = seekable.end(seekable.length - 1);
  const local = target - conversionStart;
  if (!Number.isFinite(end) || local < 0 || local > end - 0.5) return null;
  return Math.max(local, seekable.start(0));
}
