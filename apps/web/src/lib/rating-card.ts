import type { RatingTag, RatingValue } from "@hermes/schema/shared";

import { keepOffered, toggleTag, tagsOffered, type ViewRating } from "@/lib/rating-draft";

/**
 * The state machine of the rating card under a library video, without React:
 * what a press on a thumb does, what the watched crossing does, and what
 * closing does. The hook that drives it (`useAssetRating`) writes to the
 * server around these transitions; the transitions themselves are pure, so
 * each rule is a test of a function.
 *
 * The rules:
 *
 * - A press on a thumb (or a choice in the card) sets that value at once, drops
 *   the tags the other choice offered, and opens the card, unless it is the
 *   active choice, which takes the rating back (value 0) and closes the card.
 * - The watched crossing opens the card on its own only when the asset has no
 *   current rating, the prompt was never dismissed, and the card has not
 *   already opened by itself. Once per asset, however it ends.
 * - Dismissing and saving both close the card and remember the prompt as
 *   dismissed (the hook writes the preference). A learner who dismissed it
 *   can still rate from the thumbs.
 */

export interface CardState {
  /** The choice the thumbs show: -1, 0 or 1. Optimistic until the write answers. */
  value: RatingValue;
  /** The tags chosen in the card. */
  tags: RatingTag[];
  /** The note typed in the card. */
  note: string;
  open: boolean;
  /** How the card came open: a thumb press (focus goes to the first tag) or the watched crossing (focus stays put). */
  openedBy: "thumb" | "watched" | null;
  /** The prompt was dismissed or answered, now or on an earlier visit. */
  dismissed: boolean;
  /** The card has opened on its own. Never again. */
  prompted: boolean;
  /** What the server last said it holds, for the Details row: null for no rating. */
  stored: ViewRating | null;
}

export function initialCard(rating: ViewRating | null, dismissed: boolean): CardState {
  const held = rating !== null && rating.value !== 0 ? rating : null;
  return {
    value: held?.value ?? 0,
    tags: held === null ? [] : [...held.tags],
    note: held?.note ?? "",
    open: false,
    openedBy: null,
    dismissed,
    prompted: false,
    stored: held,
  };
}

export type CardAction =
  | { type: "choose"; value: -1 | 1 }
  | { type: "clear" }
  | { type: "watched" }
  | { type: "toggle"; tag: RatingTag }
  | { type: "note"; text: string }
  | { type: "close" }
  | { type: "stored"; rating: ViewRating | null }
  | { type: "restore"; state: CardState };

export function cardReducer(state: CardState, action: CardAction): CardState {
  switch (action.type) {
    case "choose":
      return {
        ...state,
        value: action.value,
        tags: keepOffered(state.tags, action.value),
        open: true,
        openedBy: state.open ? state.openedBy : "thumb",
      };
    case "clear":
      return { ...state, value: 0, tags: [], note: "", open: false, openedBy: null };
    case "watched":
      if (state.open || state.dismissed || state.prompted || state.value !== 0) return state;
      return { ...state, open: true, openedBy: "watched", prompted: true };
    case "toggle":
      return { ...state, tags: toggleTag(state.tags, action.tag, tagsOffered(state.value)) };
    case "note":
      return { ...state, note: action.text };
    case "close":
      return { ...state, open: false, openedBy: null, dismissed: true };
    case "stored":
      return { ...state, stored: action.rating };
    case "restore":
      return action.state;
  }
}
