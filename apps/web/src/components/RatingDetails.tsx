"use client";

import type { Ref } from "react";

import { RATING_LIMITS, type RatingTag } from "@hermes/schema/shared";

import { Chip } from "@/components/ui/Chip";
import { cx } from "@/components/ui/classes";
import { Input } from "@/components/ui/Input";
import { tagLabel } from "@/lib/rating-draft";

/**
 * The tags and the note under a rating: a row of toggle chips (several may be
 * on) and one optional line of words. The rating card under a library video
 * and the studio's "why discard" card draw the same thing, so they draw it
 * from here; what differs is which tags they offer.
 *
 * Controlled: the caller holds `chosen` and `note`, and the toggling and the
 * cleaning are plain functions in `@/lib/rating-draft` (`toggleTag`,
 * `cleanDraft`), so a server component can import them too. `compact` is the
 * studio's side-panel density: small chips and the 32px field.
 *
 * The chips are buttons with `aria-pressed`, in a labelled group.
 */
export function RatingDetails({
  tags,
  chosen,
  note,
  onToggle,
  onNote,
  onSubmit,
  label,
  groupRef,
  compact = false,
  disabled = false,
  className,
}: {
  /** The tags on offer, in order. */
  tags: readonly RatingTag[];
  chosen: readonly RatingTag[];
  note: string;
  onToggle: (tag: RatingTag) => void;
  onNote: (text: string) => void;
  /** Enter in the note field. */
  onSubmit?: () => void;
  /** The group's accessible name. */
  label: string;
  /** The chip group, for a card that opened from a press to put focus on its first chip. */
  groupRef?: Ref<HTMLDivElement>;
  compact?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={cx("flex min-w-0 flex-col gap-3", className)}>
      <div ref={groupRef} role="group" aria-label={label} className="flex flex-wrap gap-2">
        {tags.map((tag) => (
          <Chip
            key={tag}
            size={compact ? "sm" : "md"}
            tone="tint"
            active={chosen.includes(tag)}
            disabled={disabled}
            onClick={() => onToggle(tag)}
          >
            {tagLabel(tag)}
          </Chip>
        ))}
      </div>
      <Input
        size={compact ? "compact" : "sm"}
        aria-label="Note"
        placeholder="Anything else? (optional)"
        maxLength={RATING_LIMITS.maxNoteChars}
        value={note}
        disabled={disabled}
        onChange={(event) => onNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && onSubmit !== undefined) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
    </div>
  );
}
