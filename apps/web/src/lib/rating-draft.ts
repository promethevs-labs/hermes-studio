import {
  cleanRating,
  RATING_LIMITS,
  RATING_TAG_LABELS,
  RATING_TAGS_DOWN,
  ratingTagsFor,
  type CleanRating,
  type JobReview,
  type RatingTag,
  type RatingTagDown,
  type RatingValue,
} from "@hermes/schema/shared";

/**
 * The pure half of rating a video and of saying why a job was discarded:
 * which tags a choice offers, toggling one, cleaning a draft the way the
 * route will, the words for a stored rating or review, and the preference
 * value that remembers the prompt was dismissed.
 *
 * No React and no `"use client"`, so a server component (the library page)
 * and the client cards import the same functions. A `"use client"` module's
 * exports are client references on the server, functions included
 * (AGENTS.md, Gotchas), which is why none of this lives in a component file.
 */

/** A rating as the page and the cards hold it: value, tags and note, with no row id or time. */
export interface ViewRating {
  value: RatingValue;
  tags: RatingTag[];
  note: string | null;
}

/** The tags a choice offers: down tags for -1, up tags for 1, none for 0. */
export function tagsOffered(value: RatingValue): readonly RatingTag[] {
  return ratingTagsFor(value);
}

/** The tags a discard may carry. */
export const DISCARD_TAGS: readonly RatingTagDown[] = RATING_TAGS_DOWN;

/** The down tags that can be true of a still picture: no pacing, no voice, no length. */
const DIAGRAM_DISCARD_TAGS: readonly RatingTagDown[] = ["same-look", "too-much-text", "wrong"];

/**
 * The tags the discard card offers for a subject. A diagram has no pacing,
 * narration or running time, so it is offered the three reasons that can
 * apply to it; the runner takes any down tag for either kind.
 */
export function discardTagsFor(subject: "video" | "diagram"): readonly RatingTagDown[] {
  return subject === "diagram" ? DIAGRAM_DISCARD_TAGS : DISCARD_TAGS;
}

/** The words for a tag, falling back to the tag itself for one this build does not know. */
export function tagLabel(tag: string): string {
  return (RATING_TAG_LABELS as Record<string, string>)[tag] ?? tag;
}

/** `tag` added to `chosen` when absent, removed when present; one `allowed` does not list, or one past the limit, changes nothing. */
export function toggleTag<T extends RatingTag>(chosen: readonly T[], tag: T, allowed: readonly T[]): T[] {
  if (chosen.includes(tag)) return chosen.filter((entry) => entry !== tag);
  if (!allowed.includes(tag) || chosen.length >= RATING_LIMITS.maxTags) return [...chosen];
  return [...chosen, tag];
}

/** The tags of `chosen` a value still offers: switching from Good to Not good drops the up tags. */
export function keepOffered(chosen: readonly RatingTag[], value: RatingValue): RatingTag[] {
  const offered = tagsOffered(value);
  return chosen.filter((tag) => offered.includes(tag));
}

/** "Good", "Not good", or null for no rating. */
export function verdictWords(value: RatingValue): string | null {
  return value === 1 ? "Good" : value === -1 ? "Not good" : null;
}

/**
 * A draft as the route will take it, cleaned by `cleanRating`: the same check
 * the writer makes, so a card refuses on the page what the route would refuse.
 */
export function cleanDraft(
  value: RatingValue,
  tags: readonly RatingTag[],
  note: string,
): { ok: true; rating: CleanRating } | { ok: false; reason: string } {
  return cleanRating({ value, tags: [...tags], note });
}

/** What the Details tab says of a rating: "Good" or "Not good", then its tag labels. Null when there is no rating. */
export function describeRating(rating: ViewRating | null): { verdict: string; tags: string[]; note: string | null } | null {
  if (rating === null) return null;
  const verdict = verdictWords(rating.value);
  if (verdict === null) return null;
  return { verdict, tags: rating.tags.map(tagLabel), note: rating.note };
}

/**
 * What a job's stored review says when it was a discard with a reason: the tag
 * labels and the note. Null for a job with no review, a review that was not a
 * discard, or a discard with no reason (a Skip); a runner that sends no
 * `review` field at all reads the same as one that sends null.
 */
export function discardReason(review: JobReview | null | undefined): { tags: string[]; note: string | null } | null {
  if (review === null || review === undefined || review.verdict !== "discard") return null;
  const tags = Array.isArray(review.tags) ? review.tags.map(tagLabel) : [];
  const note = typeof review.note === "string" && review.note.trim() !== "" ? review.note : null;
  return tags.length === 0 && note === null ? null : { tags, note };
}

/** What the dismissal preference holds, as `favorite:` holds `{ at }`. */
export function ratingPromptValue(now: Date = new Date()): { at: string } {
  return { at: now.toISOString() };
}

/** Whether a stored `ratingPrompt:<asset>` value is a dismissal this code wrote. */
export function parseRatingPrompt(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const at = (value as { at?: unknown }).at;
  return typeof at === "string" && !Number.isNaN(Date.parse(at));
}
