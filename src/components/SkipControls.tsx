/**
 * Skip Intro / Skip Recap, the "Intro skipped" notice and the credits card
 * (Next Episode with its countdown ring + Watch Credits; for a movie, Back to
 * browse + Watch Credits), over the expanded player. They stay up while the
 * playback controls hide; the controls only lift them clear of the timeline.
 * Plain CSS motion (see index.css .ak-skip-*): this re-renders on every
 * time update, and Reduce Motion turns the entrances off.
 */

import { ArrowLeft, ChevronsRight, Play, RotateCcw } from "lucide-react";
import type { SkipButtonView, SkippableKind } from "@/lib/skip/markers";

export interface SkipNotice {
  kind: SkippableKind;
  /** Where the skipped part starts (Watch it goes back there). */
  from: number;
}

export interface CreditsCardView {
  kind: "next" | "movie";
  /** The next episode ("S2 E3 · Title"). */
  title?: string;
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

const RING_RADIUS = 15;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** The countdown ring around the play glyph: fills as the next episode comes. */
function CountdownRing({ progress }: { progress: number }) {
  return (
    <span className="ak-next-ring" aria-hidden="true">
      <svg viewBox="0 0 36 36" width="34" height="34">
        <circle cx="18" cy="18" r={RING_RADIUS} className="ak-next-ring__track" />
        <circle
          cx="18"
          cy="18"
          r={RING_RADIUS}
          className="ak-next-ring__fill"
          style={{ strokeDasharray: RING_LENGTH, strokeDashoffset: RING_LENGTH * (1 - Math.min(1, Math.max(0, progress))) }}
        />
      </svg>
      <Play size={13} fill="currentColor" className="ak-next-ring__glyph" />
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

export default function SkipControls({
  button,
  notice,
  card,
  raised,
  touch,
  onSkip,
  onUndo,
  onNext,
  onWatchCredits,
  onBack,
}: Props) {
  if (!button && !notice && !card) return null;
  return (
    <div
      className={`ak-skip-layer ${raised ? "ak-skip-layer--raised" : ""} ${touch ? "ak-skip-layer--touch" : ""}`}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {notice && !button && (
        <div key={`notice:${notice.kind}`} role="status" className="ak-skip-notice">
          <span className="ak-skip-notice__text">{notice.kind === "intro" ? "Intro skipped" : "Recap skipped"}</span>
          <button type="button" onClick={onUndo} className="ak-skip-notice__undo">
            <RotateCcw size={14} aria-hidden="true" /> Watch it
          </button>
        </div>
      )}

      {button && (
        <button
          key={`skip:${button.kind}`}
          type="button"
          onClick={onSkip}
          aria-label={`${button.label}, ${Math.ceil(button.remaining)} seconds`}
          aria-keyshortcuts={touch ? undefined : "S"}
          className="ak-skip-button"
        >
          <span>{button.label}</span>
          <ChevronsRight size={19} strokeWidth={2.4} aria-hidden="true" />
          {!touch && <Key>S</Key>}
          <span
            aria-hidden="true"
            className="ak-skip-button__progress"
            style={{ transform: `scaleX(${Math.max(0, 1 - button.progress)})` }}
          />
        </button>
      )}

      {card && !button && card.kind === "next" && (
        <section key="up-next" aria-label={card.stillWatching ? "Are you still watching?" : "Up next"} className="ak-next-card">
          <div className="min-w-0">
            <p className="ak-next-card__eyebrow">{card.stillWatching ? "Are you still watching?" : "Up next"}</p>
            {card.title && <p className="ak-next-card__title">{card.title}</p>}
            <p className="ak-next-card__hint" aria-live="polite">
              {card.countdown
                ? `Starts in ${Math.ceil(card.countdown.left)} s`
                : card.stillWatching
                  ? "Autoplay paused after three episodes"
                  : "Autoplay is off"}
            </p>
          </div>
          <div className="ak-next-card__actions">
            <button
              type="button"
              onClick={onNext}
              aria-label={
                card.countdown
                  ? `Next Episode, starts in ${Math.ceil(card.countdown.left)} seconds`
                  : "Next Episode"
              }
              aria-keyshortcuts={touch ? undefined : "Enter"}
              className="desktop-control desktop-primary ak-next-card__primary"
            >
              {card.countdown ? (
                <CountdownRing progress={card.countdown.progress} />
              ) : (
                <Play size={16} fill="currentColor" aria-hidden="true" />
              )}
              Next Episode
              {!touch && <Key>↩</Key>}
            </button>
            <button
              type="button"
              onClick={onWatchCredits}
              aria-keyshortcuts={touch ? undefined : "Escape"}
              className="desktop-control desktop-ghost ak-next-card__secondary"
            >
              Watch Credits
              {!touch && <Key>esc</Key>}
            </button>
          </div>
        </section>
      )}

      {card && !button && card.kind === "movie" && (
        <section key="credits" aria-label="Credits" className="ak-next-card">
          <div className="min-w-0">
            <p className="ak-next-card__eyebrow">Credits</p>
            <p className="ak-next-card__title">Thanks for watching</p>
          </div>
          <div className="ak-next-card__actions">
            <button
              type="button"
              onClick={onBack}
              aria-keyshortcuts={touch ? undefined : "Enter"}
              className="desktop-control desktop-primary ak-next-card__primary"
            >
              <ArrowLeft size={16} aria-hidden="true" /> Back to browse
              {!touch && <Key>↩</Key>}
            </button>
            <button
              type="button"
              onClick={onWatchCredits}
              aria-keyshortcuts={touch ? undefined : "Escape"}
              className="desktop-control desktop-ghost ak-next-card__secondary"
            >
              Watch Credits
              {!touch && <Key>esc</Key>}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
