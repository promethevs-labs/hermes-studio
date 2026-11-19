import { rateAsset } from "@hermes/catalog/state";
import { cleanRating } from "@hermes/schema/shared";

import { BadRequest, handler, requireId } from "@/lib/learner-api";

/**
 * Rate a library asset: a thumbs up or down, the tags and note that say why.
 *
 * `{ assetId, value, tags, note }`: `value` is -1 (down), 1 (up) or 0 (a
 * rating taken back). `tags` must belong to the value (`RATING_TAGS_DOWN` with
 * -1, `RATING_TAGS_UP` with 1, none with 0) and `note` is trimmed, null when
 * blank, refused past `RATING_LIMITS.maxNoteChars`. Both are checked by
 * `cleanRating`, the check the writer makes too, so a 400 here says what the
 * writer would.
 *
 * `rateAsset` only appends: a change of mind is a new row, and the current
 * rating is the newest. The asset is looked up under the owner's scope, so a
 * rating can only land on a row the owner can read, and an id from a stale
 * page or another owner's asset is a 400. Every rating from this route is
 * given on the library surface; the studio's review writes its own records.
 * Answers the stored rating.
 */
export const POST = handler(
  "rating",
  (body) => {
    const assetId = requireId(body, "assetId");
    const cleaned = cleanRating({ value: body.value, tags: body.tags, note: body.note });
    if (!cleaned.ok) throw new BadRequest(cleaned.reason);
    return { assetId, rating: cleaned.rating };
  },
  async (db, { assetId, rating }, owner) => {
    const stored = await rateAsset(db, {
      learnerId: owner,
      assetId,
      value: rating.value,
      tags: rating.tags,
      note: rating.note,
      surface: "library",
    });
    return { assetId, value: stored.value, tags: stored.tags, note: stored.note, at: stored.at };
  },
);
