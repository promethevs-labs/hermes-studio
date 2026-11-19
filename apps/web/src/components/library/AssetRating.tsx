"use client";

import { createContext, useCallback, useContext, useEffect, useId, useReducer, useRef, useState } from "react";

import { RatingDetails } from "@/components/RatingDetails";
import { Button } from "@/components/ui/Button";
import { cardClasses, CARD_TITLE, cx, STATUS_TEXT } from "@/components/ui/classes";
import { Chip } from "@/components/ui/Chip";
import { Collapse } from "@/components/ui/Collapse";
import { ErrorText } from "@/components/ui/ErrorText";
import { Glyph } from "@/components/ui/Glyph";
import { IconButton } from "@/components/ui/IconButton";
import { dismissRatingPrompt, setRating } from "@/lib/asset-actions";
import { cardReducer, initialCard, type CardState } from "@/lib/rating-card";
import { cleanDraft, describeRating, tagsOffered, verdictWords, type ViewRating } from "@/lib/rating-draft";
import type { RatingTag } from "@hermes/schema/shared";

/**
 * Rating a library video: the thumbs in the action row, the card under the
 * player, and the Details row, all driven by one hook so they cannot disagree.
 *
 * The state machine is `cardReducer` (`@/lib/rating-card`, pure); this file
 * is the writes around it. A press on a thumb saves that value at once and
 * opens the card for the tags and a note; the same press on the active thumb
 * takes the rating back. The card also opens by itself once, when the video
 * is watched through (`crossed`, called by `LibraryVideo` on the save that
 * crossed the threshold), if the asset is unrated and the prompt was never
 * dismissed. Dismissing and saving both write `ratingPrompt:<asset id>`, so
 * it is never offered again; the thumbs always work.
 *
 * A write the route did not take puts the thumbs back and says so beside
 * them, as the star does.
 */

/** What the Details tab's "Your rating" row reads: the stored rating, or null. */
export const RatingContext = createContext<ViewRating | null>(null);

export function useAssetRating({
  assetId,
  rating,
  dismissed,
}: {
  assetId: string;
  /** What the store held when the page was rendered: null for no rating. */
  rating: ViewRating | null;
  /** Whether the prompt was dismissed or answered on an earlier visit. */
  dismissed: boolean;
}) {
  const [state, dispatch] = useReducer(cardReducer, undefined, () => initialCard(rating, dismissed));
  const [busy, setBusy] = useState(false);
  // Save in flight: the card's fields and Save wait. A thumb press in flight
  // does not disable them, or focus could not move to the first tag.
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const thumbs = useRef<Record<string, HTMLButtonElement | null>>({});
  // The thumb press still on its way, resolving to whether the route took it.
  // Save waits on it, so tags chosen while the press travels are not dropped.
  const pressing = useRef<Promise<boolean> | null>(null);

  /** The thumb that is on, else the first, for focus to return to when the card closes. */
  const focusThumb = () => (thumbs.current[String(state.value)] ?? thumbs.current["1"])?.focus();
  const thumbRef = useCallback((value: number) => (node: HTMLButtonElement | null) => {
    thumbs.current[String(value)] = node;
  }, []);

  /** Write `value` with nothing else, putting the card back as it was if the route refuses. */
  const press = async (next: -1 | 1) => {
    if (busy) return;
    const before: CardState = state;
    const taking = state.value === next;
    setFailed(false);
    setProblem(null);
    dispatch(taking ? { type: "clear" } : { type: "choose", value: next });
    setBusy(true);
    const request = setRating(assetId, { value: taking ? 0 : next });
    const took = request.then((sent) => sent.ok);
    pressing.current = took;
    const answer = await request;
    if (pressing.current === took) pressing.current = null;
    setBusy(false);
    if (!answer.ok) {
      dispatch({ type: "restore", state: before });
      setFailed(true);
      return;
    }
    dispatch({ type: "stored", rating: answer.value.value === 0 ? null : answer.value });
  };

  /** Save the tags and note with the chosen value and close the card. True when the route took it. */
  const save = async (): Promise<boolean> => {
    if (saving || state.value === 0) return false;
    const cleaned = cleanDraft(state.value, state.tags, state.note);
    if (!cleaned.ok) {
      setProblem(cleaned.reason);
      return false;
    }
    setProblem(null);
    setSaving(true);
    // A thumb press may still be travelling (the card opens before it
    // lands). Wait for it rather than drop this save; a press the route
    // refused has already put the card back and said so.
    if (pressing.current !== null && !(await pressing.current)) {
      setSaving(false);
      return false;
    }
    setBusy(true);
    const answer = await setRating(assetId, cleaned.rating);
    setBusy(false);
    setSaving(false);
    if (!answer.ok) {
      setProblem(answer.message);
      return false;
    }
    dispatch({ type: "stored", rating: answer.value });
    dispatch({ type: "close" });
    void dismissRatingPrompt(assetId);
    return true;
  };

  const dismiss = () => {
    setProblem(null);
    dispatch({ type: "close" });
    void dismissRatingPrompt(assetId);
  };

  /** The video was watched through: offer the card, once, if nothing says not to. */
  const crossed = useCallback(() => dispatch({ type: "watched" }), []);

  return {
    state,
    saving,
    failed,
    problem,
    press,
    save,
    dismiss,
    crossed,
    focusThumb,
    thumbRef,
    toggle: (tag: RatingTag) => dispatch({ type: "toggle", tag }),
    setNote: (text: string) => dispatch({ type: "note", text }),
  };
}

export type AssetRating = ReturnType<typeof useAssetRating>;

/**
 * The two thumbs, icon-only pills after Download and PDF. The chosen one is
 * drawn filled, as the star is; both are toggles (`aria-pressed`).
 */
export function RatingThumbs({ rating }: { rating: AssetRating }) {
  const { state, failed, press, thumbRef } = rating;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="inline-flex items-center gap-2">
        <Thumb value={1} on={state.value === 1} onPress={() => void press(1)} buttonRef={thumbRef(1)} />
        <Thumb value={-1} on={state.value === -1} onPress={() => void press(-1)} buttonRef={thumbRef(-1)} />
      </span>
      {failed && (
        <span role="status" className={cx(STATUS_TEXT, "animate-fade-in text-text2 motion-reduce:animate-none")}>
          Not saved. Try again.
        </span>
      )}
    </span>
  );
}

function Thumb({
  value,
  on,
  onPress,
  buttonRef,
}: {
  value: 1 | -1;
  on: boolean;
  onPress: () => void;
  buttonRef: (node: HTMLButtonElement | null) => void;
}) {
  const words = verdictWords(value) ?? "";
  return (
    <Button
      variant="secondary"
      size="sm"
      aria-pressed={on}
      aria-label={words}
      title={words}
      onClick={onPress}
      ref={buttonRef}
      className="px-3"
    >
      <Glyph
        name={value === 1 ? "thumbUp" : "thumbDown"}
        size={18}
        className={cx(
          "transition-[fill,color] duration-150 motion-reduce:transition-none",
          on ? "fill-current text-accent-text" : "text-text2",
        )}
      />
    </Button>
  );
}

/**
 * The card under the player: the question, the two choices, then (once one is
 * made) the tags for it, an optional note, Save, and a dismiss. It folds open
 * and shut like the Ask panel under the same player, not a dialog, and never
 * takes focus on its own: only a thumb press moves focus, to the first tag.
 */
export function RatingCard({ rating }: { rating: AssetRating }) {
  const { state, saving: waiting, problem, press, save, dismiss, focusThumb, toggle, setNote } = rating;
  const headingId = useId();
  const cardId = useId();
  const card = useRef<HTMLElement | null>(null);
  const tags = useRef<HTMLDivElement | null>(null);

  // A card that came open from a thumb puts the cursor where the next thing
  // to do is: the first tag. One that came open by itself leaves focus alone.
  useEffect(() => {
    if (state.open && state.openedBy === "thumb") tags.current?.querySelector("button")?.focus();
  }, [state.open, state.openedBy]);

  /** Closing from inside the card must not drop focus to the page: it goes back to the thumbs. */
  const dismissing = () => {
    if (card.current?.contains(document.activeElement)) focusThumb();
    dismiss();
  };
  const saving = async () => {
    const inside = card.current?.contains(document.activeElement) === true;
    if ((await save()) && inside) focusThumb();
  };

  return (
    <Collapse open={state.open} id={cardId}>
      <div className="pb-1">
        <section ref={card} aria-labelledby={headingId} className={cardClasses({ tight: true, gap: 3 })}>
          <div className="flex items-start justify-between gap-3">
            <h2 id={headingId} className={CARD_TITLE}>
              What did you think of this video?
            </h2>
            <IconButton label="Dismiss" size="sm" onClick={dismissing}>
              <Glyph name="close" size={16} />
            </IconButton>
          </div>
          <div role="group" aria-label="Your rating" className="flex flex-wrap gap-2">
            <Chip active={state.value === 1} onClick={() => void press(1)}>
              Good
            </Chip>
            <Chip active={state.value === -1} onClick={() => void press(-1)}>
              Not good
            </Chip>
          </div>
          {state.value !== 0 && (
            <>
              <RatingDetails
                tags={tagsOffered(state.value)}
                chosen={state.tags}
                note={state.note}
                onToggle={toggle}
                onNote={setNote}
                onSubmit={() => void saving()}
                label={state.value === 1 ? "What was good" : "What went wrong"}
                groupRef={tags}
                disabled={waiting}
              />
              <ErrorText>{problem}</ErrorText>
              <div className="flex">
                <Button size="sm" disabled={waiting} onClick={() => void saving()}>
                  {waiting ? "Saving" : "Save"}
                </Button>
              </div>
            </>
          )}
        </section>
      </div>
    </Collapse>
  );
}

/**
 * The Details tab's "Your rating" value: Good or Not good, then the labels of
 * its tags, then its note. Nothing at all for no rating, which the row hides
 * (it is empty), so an unrated video's Details has no such row.
 */
export function YourRating() {
  const described = describeRating(useContext(RatingContext));
  if (described === null) return null;
  return (
    <span aria-live="polite">
      <span className="font-semibold text-text">{described.verdict}</span>
      {described.tags.length > 0 && ` (${described.tags.join(", ")})`}
      {described.note !== null && <span className="block whitespace-pre-line">{described.note}</span>}
    </span>
  );
}
