/**
 * Skip Intro / Skip Recap, the "Intro skipped" notice and the credits card
 * (Next Episode with its countdown ring + Watch Credits; for a movie, Back to
 * browse + Watch Credits), over the expanded player. They stay up while the
 * playback controls hide; the controls only lift them clear of the timeline.
 *
 * Design (design/contact-sheet.png in the 2026-10-30 polish lane): the skip
 * button is a quiet outline whose light fill drains while the part plays; the
 * Up Next card shows the next episode's still, title and synopsis with the
 * countdown ring on Next Episode, and the picture keeps playing full size.
 * Plain CSS motion (see index.css .ak-skip-*): this re-renders on every time
 * update. Leaving elements stay mounted for their exit animation; Reduce
 * Motion turns both off.
 */

import { forwardRef, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronsRight, Play, RotateCcw } from "lucide-react";
import type { SkipButtonView, SkippableKind } from "@/lib/skip/markers";

export interface SkipNotice {
  kind: SkippableKind;
  /** Where the skipped part starts (Watch it goes back there). */
  from: number;
}

export interface CreditsCardView {
  kind: "next" | "movie";
  /** The next episode's title, its "S2 E3" label, still and synopsis. */
  title?: string;
  label?: string;
  still?: string;
  overview?: string;
  /** Seconds before the next episode starts, and 0..1 of the countdown run; null: no countdown. */
  countdown: { left: number; progress: number } | null;
  /** Three episodes started by themselves: ask before another one. */
  stillWatching: boolean;
}

interface Props {
  button: SkipButtonView | null;
  notice: SkipNotice | null;
  /** The credits card (the credits started, or the last seconds when they are unknown). */
  card: CreditsCardView | null;
  /** The playback controls are showing: sit above the timeline. */
  raised: boolean;
  /** Touch layout (no keyboard hints, larger targets). */
  touch: boolean;
  onSkip: () => void;
  onUndo: () => void;
  onNext: () => void;
  onWatchCredits: () => void;
  onBack: () => void;
}

/** How long a leaving element stays for its exit animation (index.css ak-skip-out). */
export const SKIP_EXIT_MS = 220;

const RING_RADIUS = 15;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** The countdown ring around the play glyph: fills as the next episode comes. */
function CountdownRing({ progress }: { progress: number }) {
  return (
    <span className="ak-next-ring" aria-hidden="true">
      <svg viewBox="0 0 36 36" className="ak-next-ring__svg">
        <circle cx="18" cy="18" r={RING_RADIUS} className="ak-next-ring__track" />
        <circle
          cx="18"
          cy="18"
          r={RING_RADIUS}
          className="ak-next-ring__fill"
          style={{ strokeDasharray: RING_LENGTH, strokeDashoffset: RING_LENGTH * (1 - Math.min(1, Math.max(0, progress))) }}
        />
      </svg>
      <Play size={11} fill="currentColor" className="ak-next-ring__glyph" />
    </span>
  );
}

function Key({ children }: { children: string }) {
  return (
    <kbd aria-hidden="true" className="ak-skip-key">
      {children}
    </kbd>
  );
}

/**
 * The value while it is set, then the last one for SKIP_EXIT_MS so it can
 * animate out. `leaving` is true during that time.
 */
function useExit<T>(value: T | null, key: (value: T) => string): { shown: T | null; leaving: boolean } {
  // The latest value shown, so a leaving countdown keeps its last state.
  const last = useRef<T | null>(value);
  const [, rerender] = useState(0);
  const current = value === null ? null : key(value);
  if (value !== null) last.current = value;

  useEffect(() => {
    if (current !== null || last.current === null) return;
    const timer = setTimeout(() => {
      last.current = null;
      rerender((tick) => tick + 1);
    }, SKIP_EXIT_MS);
    return () => clearTimeout(timer);
  }, [current]);

  if (value !== null) return { shown: value, leaving: false };
  return { shown: last.current, leaving: last.current !== null };
}

function CardShell({
  label,
  still,
  eyebrow,
  title,
  overview,
  leaving,
  children,
  hint,
}: {
  label: string;
  still?: string;
  eyebrow: string;
  title?: string;
  overview?: string;
  leaving: boolean;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className={`ak-next-card ${still ? "ak-next-card--still" : ""}`}
      data-leaving={leaving || undefined}
    >
      {still ? (
        <div className="ak-next-card__still">
          <img src={still} alt="" draggable={false} />
          <div className="ak-next-card__heading">
            <p className="ak-next-card__eyebrow">{eyebrow}</p>
            {title && <p className="ak-next-card__title">{title}</p>}
          </div>
        </div>
      ) : (
        <div className="ak-next-card__heading ak-next-card__heading--plain">
          <p className="ak-next-card__eyebrow">{eyebrow}</p>
          {title && <p className="ak-next-card__title">{title}</p>}
        </div>
      )}
      {overview && <p className="ak-next-card__overview">{overview}</p>}
      <div className="ak-next-card__actions">{children}</div>
      {hint && (
        <p className="ak-next-card__hint" aria-live="polite">
          {hint}
        </p>
      )}
    </section>
  );
}

const SkipControls = forwardRef<HTMLDivElement, Props>(function SkipControls(
  { button, notice, card, raised, touch, onSkip, onUndo, onNext, onWatchCredits, onBack },
  ref
) {
  const skip = useExit(button, (b) => `skip:${b.kind}`);
  const noticeShown = useExit(notice && !button ? notice : null, (n) => `notice:${n.kind}`);
  const cardShown = useExit(card && !button ? card : null, (c) => `card:${c.kind}`);
  if (!skip.shown && !noticeShown.shown && !cardShown.shown) return null;

  const view = cardShown.shown;
  const nextHint = (view: CreditsCardView) => {
    const status = view.countdown
      ? `Starts in ${Math.ceil(view.countdown.left)} s`
      : view.stillWatching
        ? "Autoplay paused after three episodes"
        : "Autoplay is off";
    return touch ? status : (
      <>
        {status}
        <span className="ak-next-card__keys">
          <Key>↩</Key> next <Key>esc</Key> credits
        </span>
      </>
    );
  };

  return (
    <div
      ref={ref}
      className={`ak-skip-layer ${raised ? "ak-skip-layer--raised" : ""} ${touch ? "ak-skip-layer--touch" : ""}`}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {noticeShown.shown && (
        <div
          key={`notice:${noticeShown.shown.kind}`}
          role="status"
          className="ak-skip-notice"
          data-leaving={noticeShown.leaving || undefined}
        >
          <span className="ak-skip-notice__text">{noticeShown.shown.kind === "intro" ? "Intro skipped" : "Recap skipped"}</span>
          <button type="button" onClick={onUndo} className="ak-skip-notice__undo" disabled={noticeShown.leaving}>
            <RotateCcw size={14} aria-hidden="true" /> Watch it
          </button>
        </div>
      )}

      {skip.shown && (
        <button
          key={`skip:${skip.shown.kind}`}
          type="button"
          onClick={onSkip}
          disabled={skip.leaving}
          data-leaving={skip.leaving || undefined}
          aria-label={`${skip.shown.label}, ${Math.ceil(skip.shown.remaining)} seconds`}
          aria-keyshortcuts={touch ? undefined : "S"}
          className="ak-skip-button"
        >
          <span
            aria-hidden="true"
            className="ak-skip-button__fill"
            style={{ transform: `scaleX(${Math.max(0, 1 - skip.shown.progress)})` }}
          />
          <span className="ak-skip-button__label">{skip.shown.label}</span>
          <ChevronsRight size={18} strokeWidth={2.4} aria-hidden="true" />
          {!touch && <Key>S</Key>}
        </button>
      )}

      {view && view.kind === "next" && (
        <CardShell
          key="up-next"
          label={view.stillWatching ? "Are you still watching?" : "Up next"}
          still={view.still}
          eyebrow={
            view.stillWatching
              ? "Are you still watching?"
              : `Next episode${view.label ? ` · ${view.label}` : ""}`
          }
          title={view.stillWatching && view.label ? `${view.label} · ${view.title ?? ""}` : view.title}
          overview={view.stillWatching ? undefined : view.overview}
          leaving={cardShown.leaving}
          hint={nextHint(view)}
        >
          <button
            type="button"
            onClick={onNext}
            disabled={cardShown.leaving}
            aria-label={
              view.countdown
                ? `Next Episode, starts in ${Math.ceil(view.countdown.left)} seconds`
                : "Next Episode"
            }
            aria-keyshortcuts={touch ? undefined : "Enter"}
            className="ak-next-card__primary"
          >
            {view.countdown ? (
              <CountdownRing progress={view.countdown.progress} />
            ) : (
              <Play size={15} fill="currentColor" aria-hidden="true" />
            )}
            Next Episode
          </button>
          <button
            type="button"
            onClick={onWatchCredits}
            disabled={cardShown.leaving}
            aria-keyshortcuts={touch ? undefined : "Escape"}
            className="ak-next-card__secondary"
          >
            Watch Credits
          </button>
        </CardShell>
      )}

      {view && view.kind === "movie" && (
        <CardShell
          key="credits"
          label="Credits"
          eyebrow="Credits"
          title="Thanks for watching"
          leaving={cardShown.leaving}
          hint={touch ? undefined : (
            <span className="ak-next-card__keys">
              <Key>↩</Key> browse <Key>esc</Key> credits
            </span>
          )}
        >
          <button
            type="button"
            onClick={onBack}
            disabled={cardShown.leaving}
            aria-keyshortcuts={touch ? undefined : "Enter"}
            className="ak-next-card__primary"
          >
            <ArrowLeft size={15} aria-hidden="true" /> Back to browse
          </button>
          <button
            type="button"
            onClick={onWatchCredits}
            disabled={cardShown.leaving}
            aria-keyshortcuts={touch ? undefined : "Escape"}
            className="ak-next-card__secondary"
          >
            Watch Credits
          </button>
        </CardShell>
      )}
    </div>
  );
});

export default SkipControls;
