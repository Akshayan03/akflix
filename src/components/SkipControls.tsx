/**
 * Skip Intro / Skip Recap, the "Intro skipped" notice and the credits
 * "Next episode" card, over the expanded player. They stay up while the
 * playback controls hide; the controls only lift them clear of the timeline.
 * Plain CSS motion (see index.css .ak-skip-*): this re-renders on every
 * time update, and Reduce Motion turns the entrances off.
 */

import { ChevronsRight, Play, RotateCcw } from "lucide-react";
import { formatClock } from "@/lib/utils";
import type { SkipButtonView, SkippableKind } from "@/lib/skip/markers";

export interface SkipNotice {
  kind: SkippableKind;
  /** Where the skipped part starts (Watch it goes back there). */
  from: number;
}

interface Props {
  button: SkipButtonView | null;
  notice: SkipNotice | null;
  /** Credits are playing and there is a next episode. */
  upNext: { title?: string; endsIn: number; progress: number } | null;
  /** The playback controls are showing: sit above the timeline. */
  raised: boolean;
  /** Touch layout (no keyboard hints, larger targets). */
  touch: boolean;
  onSkip: () => void;
  onUndo: () => void;
  onNext: () => void;
  onWatchCredits: () => void;
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
  upNext,
  raised,
  touch,
  onSkip,
  onUndo,
  onNext,
  onWatchCredits,
}: Props) {
  if (!button && !notice && !upNext) return null;
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

      {upNext && !button && (
        <section key="up-next" aria-label="Up next" className="ak-next-card">
          <div className="min-w-0">
            <p className="ak-next-card__eyebrow">Up next</p>
            {upNext.title && <p className="ak-next-card__title">{upNext.title}</p>}
            <p className="ak-next-card__hint">
              Plays automatically in {formatClock(Math.max(0, upNext.endsIn))}
            </p>
          </div>
          <div className="ak-next-card__actions">
            <button
              type="button"
              onClick={onNext}
              aria-keyshortcuts={touch ? undefined : "N"}
              className="desktop-control desktop-primary ak-next-card__primary"
            >
              <Play size={16} fill="currentColor" aria-hidden="true" /> Next Episode
              {!touch && <Key>N</Key>}
            </button>
            <button type="button" onClick={onWatchCredits} className="desktop-control desktop-ghost">
              Watch credits
            </button>
          </div>
          <span
            aria-hidden="true"
            className="ak-next-card__progress"
            style={{ transform: `scaleX(${Math.min(1, Math.max(0, upNext.progress))})` }}
          />
        </section>
      )}
    </div>
  );
}
