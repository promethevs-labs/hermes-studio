import { SHOT_TYPE_LABELS, SHOT_TYPE_USE, SHOT_TYPES } from "@hermes/schema/shared";

/**
 * What the video agent is told about a brief's shot plan
 * (docs/STUDIO-VIDEOS.md, "The shot plan"), the same for all three tools: a
 * manual section listing the shot types, and one step in the first prompt
 * when the brief carries shots.
 *
 * The section is generated from `SHOT_TYPES`, `SHOT_TYPE_LABELS` and
 * `SHOT_TYPE_USE`, so a change to the vocabulary changes every manual and so
 * its hash.
 */

/** The manual's "Shot types" section, ending in a blank line. */
export function shotTypesSection(): string {
  return [
    "## Shot types",
    "",
    "A brief may carry a `shot` on every scene: the picture plan the person approved on the card, with a `type` from this list, a `layout` (where things sit in the frame), a `motion` (the one motion idea that carries the scene) and an `emphasis` (what the eye must land on, and how it is marked).",
    "",
    ...SHOT_TYPES.map((type) => `- \`${type}\` (${SHOT_TYPE_LABELS[type]}): ${SHOT_TYPE_USE[type]}.`),
    "",
    "",
  ].join("\n");
}

/** The first prompt's step for a brief with shots. */
export const SHOT_PLAN_STEP =
  "Each scene's `shot` is the picture plan the person approved: its type, layout, motion and emphasis (your manual's \"Shot types\"). Build each scene to it; each beat's `show` says what changes within that picture. Two scenes with different shot types must not end up with the same layout.";
