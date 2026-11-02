/**
 * Skip Intro / Skip Recap, the "Intro skipped" notice and the credits card
 * (Up Next with its countdown + Watch credits; for a movie, Back to browse +
 * Watch credits), over the expanded player. They stay up while the playback
 * controls hide; the controls only lift them clear of the timeline.
 *
 * Design "A — Glass" (2026-11-02, the owner's pick): frosted white-glass pills,
 * black and white only. Skip leads with a countdown ring whose arc drains
 * while the part plays (skip icon on a dark disc inside). Up Next is one pill
 * holding a rounded still, "Up next · S8 E12" and the title, and a white Play
 * pill whose black ring fills as the countdown runs; a small "Watch credits"
 * chip sits above it. The shortcuts (S, Return, Esc) are in the tooltips and
 * aria. Plain CSS motion (see index.css .ak-skip-*): this re-renders on every
 * time update. Leaving elements stay mounted for their exit animation; Reduce
 * Motion turns both off.
 */

import { forwardRef, useEffect, useRef, useState, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
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

/** The countdown ring: a track, an arc covering `progress` (0..1) from the top, and an icon on a disc. */
function Ring({ progress, tone, icon }: { progress: number | null; tone: "glass" | "solid"; icon: "skip" | "play" | "back" }) {
  const fill = progress === null ? 0 : Math.min(1, Math.max(0, progress));
  return (
    <span aria-hidden="true" className={`ak-ring ak-ring--${tone}`}>
      <svg viewBox="0 0 38 38" className="ak-ring__svg">
        <circle className="ak-ring__track" cx="19" cy="19" r="17.5" />
        {progress !== null && (
          <circle
            className="ak-ring__arc"
            cx="19"
            cy="19"
            r="17.5"
            pathLength={100}
            strokeDasharray="100 100"
            style={{ strokeDashoffset: 100 * (1 - fill) }}
          />
        )}
        <circle className="ak-ring__disc" cx="19" cy="19" r="16" />
        {icon === "skip" && <path className="ak-ring__icon" d="M14 13.5l7 5.5-7 5.5z M22.5 13.5h2v11h-2z" />}
        {icon === "play" && <path className="ak-ring__icon" d="M15 13.5l9 5.5-9 5.5z" />}
        {icon === "back" && <path className="ak-ring__icon ak-ring__icon--line" d="M21.5 13.5L16 19l5.5 5.5" />}
      </svg>
    </span>
  );
}

function CardShell({
  label,
  still,
  eyebrow,
  title,
  status,
  leaving,
  chip,
  children,
}: {
  label: string;
  still?: string;
  eyebrow: string;
  title?: string;
  /** Why nothing counts down (autoplay off, still watching). */
  status?: string;
  leaving: boolean;
  /** The small glass chip above the pill (Watch credits). */
  chip: ReactNode;
  /** The white pill at the end (Play / Back to browse). */
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="ak-next-card" data-leaving={leaving || undefined}>
      {chip}
      <div className={`ak-next-card__pill ${still ? "" : "ak-next-card__pill--text"}`}>
        {still && <img className="ak-next-card__still" src={still} alt="" draggable={false} />}
        <div className="ak-next-card__heading">
          <p className="ak-next-card__eyebrow">{eyebrow}</p>
          {title && <p className="ak-next-card__title">{title}</p>}
          {status && (
            <p className="ak-next-card__status" aria-live="polite">
              {status}
            </p>
          )}
        </div>
        {children}
      </div>
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
  const shortcut = (key: string) => (touch ? undefined : key);
  const watchCredits = (
    <button
      type="button"
      onClick={onWatchCredits}
      disabled={cardShown.leaving}
      aria-keyshortcuts={shortcut("Escape")}
      title={touch ? undefined : "Watch credits (Esc)"}
      className="ak-next-card__chip"
    >
      Watch credits
    </button>
  );

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
          aria-keyshortcuts={shortcut("S")}
          title={touch ? undefined : `${skip.shown.label} (S)`}
          className="ak-skip-button"
        >
          <Ring progress={1 - skip.shown.progress} tone="glass" icon="skip" />
          <span className="ak-skip-button__label">{skip.shown.label}</span>
        </button>
      )}

      {view && view.kind === "next" && (
        <CardShell
          key="up-next"
          label={view.stillWatching ? "Are you still watching?" : "Up next"}
          still={view.still}
          eyebrow={view.stillWatching ? "Are you still watching?" : view.label ? `Up next · ${view.label}` : "Up next"}
          title={view.title}
          status={
            view.countdown
              ? undefined
              : view.stillWatching
                ? "Autoplay paused after three episodes"
                : "Autoplay is off"
          }
          leaving={cardShown.leaving}
          chip={watchCredits}
        >
          <button
            type="button"
            onClick={onNext}
            disabled={cardShown.leaving}
            aria-label={
              view.countdown
                ? `Play next episode, starts in ${Math.ceil(view.countdown.left)} seconds`
                : "Play next episode"
            }
            aria-keyshortcuts={shortcut("Enter")}
            title={touch ? undefined : "Next episode (Return)"}
            className="ak-next-card__play"
          >
            <Ring progress={view.countdown ? view.countdown.progress : null} tone="solid" icon="play" />
            <span>Play</span>
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
          chip={watchCredits}
        >
          <button
            type="button"
            onClick={onBack}
            disabled={cardShown.leaving}
            aria-keyshortcuts={shortcut("Enter")}
            title={touch ? undefined : "Back to browse (Return)"}
            className="ak-next-card__play"
          >
            <Ring progress={null} tone="solid" icon="back" />
            <span>Back to browse</span>
          </button>
        </CardShell>
      )}
    </div>
  );
});

export default SkipControls;
