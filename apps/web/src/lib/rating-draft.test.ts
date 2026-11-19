import { RATING_LIMITS, RATING_TAGS_DOWN, RATING_TAGS_UP, type JobReview, type RatingTag } from "@hermes/schema/shared";
import { describe, expect, it } from "vitest";

import {
  cleanDraft,
  describeRating,
  discardReason,
  discardTagsFor,
  keepOffered,
  parseRatingPrompt,
  ratingPromptValue,
  tagLabel,
  tagsOffered,
  toggleTag,
  verdictWords,
} from "./rating-draft";

/**
 * The pure half of the rating card and the discard card: which tags a choice
 * offers, toggling, cleaning a draft the way the route will, and the words
 * for a stored rating or review.
 */

describe("tagsOffered", () => {
  it("offers down tags for Not good, up tags for Good, and none for a cleared rating", () => {
    expect(tagsOffered(-1)).toEqual(RATING_TAGS_DOWN);
    expect(tagsOffered(1)).toEqual(RATING_TAGS_UP);
    expect(tagsOffered(0)).toEqual([]);
  });
});

describe("discardTagsFor", () => {
  it("offers a video every down tag", () => {
    expect(discardTagsFor("video")).toEqual(RATING_TAGS_DOWN);
  });

  it("offers a diagram only the reasons a still picture can have", () => {
    expect(discardTagsFor("diagram")).toEqual(["same-look", "too-much-text", "wrong"]);
    for (const tag of discardTagsFor("diagram")) expect(RATING_TAGS_DOWN).toContain(tag);
  });
});

describe("toggleTag", () => {
  it("adds a tag, removes it again, and keeps the order chosen", () => {
    const one = toggleTag([], "too-slow", RATING_TAGS_DOWN);
    const two = toggleTag(one, "voice", RATING_TAGS_DOWN);
    expect(two).toEqual(["too-slow", "voice"]);
    expect(toggleTag(two, "too-slow", RATING_TAGS_DOWN)).toEqual(["voice"]);
  });

  it("does not add a tag the choice does not offer, and can take every offered one", () => {
    expect(toggleTag<RatingTag>([], "clear", RATING_TAGS_DOWN)).toEqual([]);
    // The down list is as long as the limit, so choosing all of it is allowed.
    expect(RATING_TAGS_DOWN).toHaveLength(RATING_LIMITS.maxTags);
    const all = RATING_TAGS_DOWN.reduce<RatingTag[]>((held, tag) => toggleTag(held, tag, RATING_TAGS_DOWN), []);
    expect(all).toEqual([...RATING_TAGS_DOWN]);
  });

  it("does not change the list it was given", () => {
    const held = ["voice"] as const;
    toggleTag(held, "too-slow", RATING_TAGS_DOWN);
    expect(held).toEqual(["voice"]);
  });
});

describe("keepOffered", () => {
  it("drops the tags the other choice offered", () => {
    expect(keepOffered(["clear", "good-pacing"], -1)).toEqual([]);
    expect(keepOffered(["clear", "good-pacing"], 1)).toEqual(["clear", "good-pacing"]);
    expect(keepOffered(["voice"], 0)).toEqual([]);
  });
});

describe("cleanDraft", () => {
  it("cleans through cleanRating: tags once each, the note trimmed", () => {
    expect(cleanDraft(-1, ["too-slow", "too-slow"], "  slow start  ")).toEqual({
      ok: true,
      rating: { value: -1, tags: ["too-slow"], note: "slow start" },
    });
  });

  it("says why a tag does not belong to the choice, and why a note is too long", () => {
    const wrong = cleanDraft(1, ["voice"], "");
    expect(wrong.ok).toBe(false);
    const long = cleanDraft(-1, [], "x".repeat(RATING_LIMITS.maxNoteChars + 1));
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.reason).toContain(String(RATING_LIMITS.maxNoteChars));
  });
});

describe("the words", () => {
  it("names the choices and the tags", () => {
    expect(verdictWords(1)).toBe("Good");
    expect(verdictWords(-1)).toBe("Not good");
    expect(verdictWords(0)).toBeNull();
    expect(tagLabel("too-much-text")).toBe("Too much text");
    expect(tagLabel("from-a-newer-build")).toBe("from-a-newer-build");
  });

  it("describes a rating for the Details row, and nothing for none", () => {
    expect(describeRating({ value: -1, tags: ["too-slow", "voice"], note: "dull" })).toEqual({
      verdict: "Not good",
      tags: ["Too slow", "Voice"],
      note: "dull",
    });
    expect(describeRating({ value: 1, tags: [], note: null })).toEqual({ verdict: "Good", tags: [], note: null });
    expect(describeRating({ value: 0, tags: [], note: null })).toBeNull();
    expect(describeRating(null)).toBeNull();
  });
});

describe("discardReason", () => {
  const review = (patch: Partial<JobReview>): JobReview => ({
    verdict: "discard",
    tags: [],
    note: null,
    at: "2026-11-20T10:00:00.000Z",
    ...patch,
  });

  it("gives the tag labels and the note of a discard that had a reason", () => {
    expect(discardReason(review({ tags: ["too-slow", "voice"], note: "dull" }))).toEqual({
      tags: ["Too slow", "Voice"],
      note: "dull",
    });
    expect(discardReason(review({ note: "just the note" }))).toEqual({ tags: [], note: "just the note" });
  });

  it("gives nothing for a Skip, another verdict, no review, or a runner that sends no field", () => {
    expect(discardReason(review({}))).toBeNull();
    expect(discardReason(review({ verdict: "accept", tags: ["too-slow"] }))).toBeNull();
    expect(discardReason(null)).toBeNull();
    expect(discardReason(undefined)).toBeNull();
  });
});

describe("the dismissal preference", () => {
  it("writes { at } and reads only what it wrote", () => {
    const value = ratingPromptValue(new Date("2026-11-20T10:00:00.000Z"));
    expect(value).toEqual({ at: "2026-11-20T10:00:00.000Z" });
    expect(parseRatingPrompt(value)).toBe(true);
    for (const other of [undefined, null, true, "x", {}, { at: "not a date" }, { at: 3 }]) {
      expect(parseRatingPrompt(other), JSON.stringify(other)).toBe(false);
    }
  });
});
