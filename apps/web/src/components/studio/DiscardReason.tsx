"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { RatingDetails } from "@/components/RatingDetails";
import { Button } from "@/components/ui/Button";
import { cx } from "@/components/ui/classes";
import { ErrorText } from "@/components/ui/ErrorText";
import { FADE_IN } from "@/components/ui/motion";
import { cleanDraft, discardReason, discardTagsFor, toggleTag } from "@/lib/rating-draft";
import type { JobReview, RatingTagDown } from "@hermes/schema/shared";

/** What a discard that gives a reason sends: the body of the runner's discard endpoint. */
export interface DiscardBody {
  tags: RatingTagDown[];
  note: string | null;
}

/**
 * Why a job's output is being thrown away: the card a Discard press opens in
 * place of the old "Discard it / Keep it" question, on a video job and on a
 * diagram job alike.
 *
 * Two ways out that discard, and one that does not. Skip discards with no
 * reason, exactly as the old confirm did. Discard sends the tags and the
 * note the person chose (`{ tags, note }`, tags from `RATING_TAGS_DOWN`).
 * Keep it closes the card and discards nothing; so does Escape. The card
 * never discards on its own: the press that opened it only asked.
 *
 * The tags and the note are the same `RatingDetails` the rating card under a
 * library video draws. The draft is cleaned by `cleanRating` (through
 * `cleanDraft`) before it is sent, so the runner is not the first to refuse a
 * note that is too long. A refusal from the runner (a 400 with its words)
 * comes back as `error`, and shows here with the card still open: nothing was
 * discarded.
 */
export function DiscardReasonCard({
  subject,
  discarding,
  disabled,
  error,
  onSkip,
  onDiscard,
  onKeep,
  compact = false,
  className,
}: {
  /** What is being discarded, for the question: "video" or "diagram". */
  subject: "video" | "diagram";
  /** A discard is in flight: the press that sent it says so. */
  discarding: boolean;
  /** Something else is in flight, or this is: every press waits. */
  disabled: boolean;
  /** The runner's refusal, or any other sentence to show under the buttons. */
  error?: string | null;
  onSkip: () => void;
  onDiscard: (reason: DiscardBody) => void;
  onKeep: () => void;
  /** The side panel's density: small chips, a 32px field, 28px buttons. */
  compact?: boolean;
  className?: string;
}) {
  const [tags, setTags] = useState<RatingTagDown[]>([]);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [pressed, setPressed] = useState<"skip" | "discard" | null>(null);
  const group = useRef<HTMLDivElement | null>(null);
  const headingId = useId();
  const offered = discardTagsFor(subject);

  // The press that opened the card took the trigger off the page, so focus
  // goes to the first tag: the next thing to decide.
  useEffect(() => {
    group.current?.querySelector("button")?.focus();
  }, []);

  const send = () => {
    const cleaned = cleanDraft(-1, tags, note);
    if (!cleaned.ok) {
      setProblem(cleaned.reason);
      return;
    }
    setProblem(null);
    setPressed("discard");
    onDiscard({ tags: cleaned.rating.tags as RatingTagDown[], note: cleaned.rating.note });
  };
  const skip = () => {
    setPressed("skip");
    onSkip();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    // Not the dialog or panel around it: Escape here is Keep it.
    event.preventDefault();
    event.stopPropagation();
    onKeep();
  };

  const size = compact ? "xs" : "sm";
  const words = (own: "skip" | "discard", label: string) => (discarding && pressed === own ? "Discarding" : label);

  return (
    <section
      aria-labelledby={headingId}
      onKeyDown={onKeyDown}
      className={cx("flex min-w-0 flex-col gap-3", FADE_IN, className)}
    >
      <h3 id={headingId} className={cx("font-semibold text-text", compact ? "text-xs" : "text-[14px]")}>
        Why discard this {subject}?
      </h3>
      <RatingDetails
        tags={offered}
        chosen={tags}
        note={note}
        onToggle={(tag) => setTags((held) => toggleTag(held, tag as RatingTagDown, offered))}
        onNote={setNote}
        onSubmit={send}
        label="What was wrong"
        groupRef={group}
        compact={compact}
        disabled={disabled}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size={size} disabled={disabled} onClick={skip}>
          {words("skip", "Skip")}
        </Button>
        <Button variant="warn" size={size} disabled={disabled} onClick={send}>
          {words("discard", "Discard")}
        </Button>
        <Button variant="ghost" size={size} onClick={onKeep}>
          Keep it
        </Button>
      </div>
      <ErrorText>{problem ?? error}</ErrorText>
    </section>
  );
}

/**
 * The open and shut of the card, with focus going back to the Discard press
 * that opened it once the card is put away without discarding.
 */
export function useDiscardAsk() {
  const [asking, setAsking] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const was = useRef(false);
  useEffect(() => {
    if (was.current && !asking) {
      const at = document.activeElement;
      if (at === null || at === document.body) trigger.current?.focus();
    }
    was.current = asking;
  }, [asking]);
  const open = useCallback(() => setAsking(true), []);
  const close = useCallback(() => setAsking(false), []);
  /** Passed as the Discard press's `ref`: a callback, so the hook's result holds no ref object. */
  const catchTrigger = useCallback((node: HTMLButtonElement | null) => {
    trigger.current = node;
  }, []);
  return { asking, open, close, catchTrigger };
}

/**
 * The reason a discarded job was discarded, where its panel already says it
 * was: the tag labels and the note. Nothing for a job with no review, a
 * review that was not a discard, a Skip, or a runner that sends no `review`.
 */
export function DiscardedReason({ review, className }: { review: JobReview | null | undefined; className?: string }) {
  const reason = discardReason(review);
  if (reason === null) return null;
  return (
    <p className={className}>
      {reason.tags.length > 0 && <span className="block">Reason: {reason.tags.join(", ")}.</span>}
      {reason.note !== null && <span className="block whitespace-pre-line">{reason.note}</span>}
    </p>
  );
}
