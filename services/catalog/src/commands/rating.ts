import { RATING_SURFACES, RATING_TAG_LABELS, type RatingTag } from "@hermes/schema/shared";

import { CLI_OWNER } from "../content/scope";
import { withDatabase } from "../db";
import { listCurrentRatings, rateAsset, ratingHistory, type StoredRating } from "../state/asset-ratings";

/**
 * `catalog rating`: a learner's ratings of assets, at a terminal. Thin
 * wrappers over `state/asset-ratings.ts`, so a rating written here is the
 * row a page would write, checked the same way.
 */

/** A refusal the caller can fix: a value that is not up, down or clear. */
export class RatingUsage extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RatingUsage";
  }
}

/** The words `--value` takes, and the stored value each means. */
export const RATING_WORDS = { up: 1, down: -1, clear: 0 } as const;

export interface RatingAddResult {
  ok: true;
  command: "rating add";
  rating: StoredRating;
}

export interface RatingListResult {
  ok: true;
  command: "rating ls";
  owner: string;
  /** The asset `--asset` named, whose whole history this is, or null for every asset's current rating. */
  asset: string | null;
  ratings: StoredRating[];
}

export type RatingResult = RatingAddResult | RatingListResult;

export interface RatingAddOptions {
  assetId: string;
  value: string;
  tags?: readonly string[];
  note?: string;
  /** Where it was given. Default: `library`. */
  surface?: string;
  /** Whose rating. Default: the CLI's owner. */
  owner?: string;
}

/** `rating add`: append one rating. */
export async function runRatingAdd(options: RatingAddOptions): Promise<RatingAddResult> {
  if (!Object.hasOwn(RATING_WORDS, options.value)) {
    throw new RatingUsage(`--value is one of ${Object.keys(RATING_WORDS).join(", ")}, not "${options.value}".`);
  }
  const surface = options.surface ?? "library";
  if (!(RATING_SURFACES as readonly string[]).includes(surface)) {
    throw new RatingUsage(`--surface is one of ${RATING_SURFACES.join(", ")}, not "${surface}".`);
  }
  const value = RATING_WORDS[options.value as keyof typeof RATING_WORDS];
  return withDatabase(async ({ db }) => ({
    ok: true as const,
    command: "rating add" as const,
    rating: await rateAsset(db, {
      learnerId: options.owner ?? CLI_OWNER,
      assetId: options.assetId,
      value,
      tags: options.tags,
      note: options.note ?? null,
      surface,
    }),
  }));
}

/** `rating ls`: every asset's current rating, or one asset's whole history with `--asset`. */
export async function runRatingList(options: { assetId?: string; owner?: string }): Promise<RatingListResult> {
  const owner = options.owner ?? CLI_OWNER;
  return withDatabase(async ({ db }) => ({
    ok: true as const,
    command: "rating ls" as const,
    owner,
    asset: options.assetId ?? null,
    ratings:
      options.assetId === undefined
        ? await listCurrentRatings(db, owner)
        : await ratingHistory(db, owner, options.assetId),
  }));
}

const WORD_FOR = { "1": "up", "-1": "down", "0": "clear" } as const;

function ratingLine(rating: StoredRating): string {
  const tags = rating.tags.map((tag: RatingTag) => RATING_TAG_LABELS[tag]).join(", ");
  return [
    `${rating.at}  ${WORD_FOR[`${rating.value}` as keyof typeof WORD_FOR].padEnd(5)} ${rating.assetId}`,
    tags === "" ? "" : `  ${tags}`,
    rating.note === null ? "" : `  "${rating.note}"`,
  ].join("");
}

export function formatRating(result: RatingResult): string {
  if (result.command === "rating add") return `rated ${result.rating.assetId}\n  ${ratingLine(result.rating)}`;
  if (result.ratings.length === 0) return result.asset === null ? "no ratings" : `no ratings of ${result.asset}`;
  return result.ratings.map(ratingLine).join("\n");
}
