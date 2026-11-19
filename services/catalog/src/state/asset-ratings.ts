import { randomUUID } from "node:crypto";

import { asset, assetJob, assetRating, blobObject, ownerScope } from "@hermes/schema";
import {
  cleanRating,
  RATING_SURFACES,
  type RatingSurface,
  type RatingTag,
  type RatingValue,
} from "@hermes/schema/shared";
import { and, desc, eq, sql } from "drizzle-orm";

import { cacheKey } from "../content/scope";
import type { CatalogDatabase } from "../db";
import { assetsByIds } from "./assets";
import { StateError } from "./errors";
import { ensureLearner } from "./learner";

/**
 * A learner's ratings of assets (`asset_rating`): a thumbs up or down, the
 * tags and note that say why, and where it was given.
 *
 * The one writer of that table, and it only appends: a change of mind is a
 * new row, a clear (value 0) included, and the current rating is the newest
 * row per learner and asset. Every function takes its learner explicitly, as
 * `./asset-names.ts` does: a rating is one learner's, and a default here
 * would file a web request's rating under whoever the default is.
 */

/** One stored rating, as every reader returns it. */
export interface StoredRating {
  id: string;
  assetId: string;
  /** -1 down, 1 up, 0 a rating taken back. */
  value: RatingValue;
  tags: RatingTag[];
  note: string | null;
  surface: RatingSurface;
  /** The studio job that made the asset when it was rated, or null for none. */
  jobId: string | null;
  /** The bytes that were rated: the asset's content hash, else its blob's sha256; null when neither was known. */
  assetHash: string | null;
  /** When it was rated, ISO 8601. */
  at: string;
}

/** What `rateAsset` takes. `value`, `tags` and `note` are checked by `cleanRating`. */
export interface RateAssetInput {
  learnerId: string;
  assetId: string;
  value: number;
  tags?: readonly string[];
  note?: string | null;
  surface: string;
}

const hasRatings = new WeakMap<object, true>();

/** Whether this database has `asset_rating` (0005). Only a yes is kept, as for `asset_name`. */
async function ratingsExist(db: CatalogDatabase): Promise<boolean> {
  const key = cacheKey(db);
  if (hasRatings.has(key)) return true;
  const { rows } = await db.execute<{ present: number }>(
    sql`select exists(select 1 from sqlite_master where type = 'table' and name = 'asset_rating') as present`,
  );
  const present = rows[0]?.present === 1;
  if (present) hasRatings.set(key, true);
  return present;
}

function toStored(row: typeof assetRating.$inferSelect): StoredRating {
  return {
    id: row.id,
    assetId: row.assetId,
    value: row.value as RatingValue,
    tags: JSON.parse(row.tags) as RatingTag[],
    note: row.note,
    surface: row.surface as RatingSurface,
    jobId: row.jobId,
    assetHash: row.assetHash,
    at: row.at.toISOString(),
  };
}

/** Newest first: by `at`, then by rowid for two rows written in one millisecond. */
const NEWEST_FIRST = [desc(assetRating.at), desc(sql`${assetRating}.rowid`)] as const;

/**
 * Rate an asset: append one row. Refuses an asset the learner cannot read,
 * or that does not exist, with the same `StateError` (as `writeAssetName`
 * does), and a value, tag, note or surface that `cleanRating` and
 * `RATING_SURFACES` do not take, with a `RangeError` naming why.
 *
 * Snapshots, read in the same call: `job_id` is the newest `asset_job` row
 * naming the asset, and `asset_hash` the asset's `content_hash`, else the
 * sha256 of the blob it points at.
 */
export async function rateAsset(db: CatalogDatabase, input: RateAssetInput): Promise<StoredRating> {
  const { learnerId, assetId } = input;
  const cleaned = cleanRating({ value: input.value, tags: input.tags, note: input.note });
  if (!cleaned.ok) throw new RangeError(cleaned.reason);
  if (!(RATING_SURFACES as readonly string[]).includes(input.surface)) {
    throw new RangeError(`"${input.surface}" is not a surface a rating is given on. Known: ${RATING_SURFACES.join(", ")}.`);
  }
  if (!(await ratingsExist(db))) {
    throw new StateError("This database predates asset ratings: run `npm run catalog -- migrate`.");
  }
  if ((await assetsByIds(db, [assetId], ownerScope(learnerId))).length === 0) {
    throw new StateError(`No asset "${assetId}" to rate.`);
  }

  const [hashes] = await db
    .select({ contentHash: asset.contentHash, blobHash: blobObject.sha256 })
    .from(asset)
    .leftJoin(blobObject, eq(blobObject.key, asset.blobKey))
    .where(eq(asset.id, assetId))
    .limit(1);
  const [made] = await db
    .select({ jobId: assetJob.jobId })
    .from(assetJob)
    .where(eq(assetJob.assetId, assetId))
    .orderBy(desc(assetJob.writtenAt), desc(assetJob.jobId))
    .limit(1);

  await ensureLearner(db, learnerId);
  const [row] = await db
    .insert(assetRating)
    .values({
      id: randomUUID(),
      learnerId,
      assetId,
      value: cleaned.rating.value,
      tags: JSON.stringify(cleaned.rating.tags),
      note: cleaned.rating.note,
      surface: input.surface,
      jobId: made?.jobId ?? null,
      assetHash: hashes?.contentHash ?? hashes?.blobHash ?? null,
    })
    .returning();
  return toStored(row!);
}

/**
 * The learner's current rating of one asset: the newest row, or null when
 * they never rated it. A newest row with `value` 0 is a rating taken back,
 * which reads as no rating; it is returned rather than null so a page can
 * tell "cleared" from "never rated".
 */
export async function currentRating(db: CatalogDatabase, learnerId: string, assetId: string): Promise<StoredRating | null> {
  if (!(await ratingsExist(db))) return null;
  const [row] = await db
    .select()
    .from(assetRating)
    .where(and(eq(assetRating.learnerId, learnerId), eq(assetRating.assetId, assetId)))
    .orderBy(...NEWEST_FIRST)
    .limit(1);
  return row === undefined ? null : toStored(row);
}

/** Every rating the learner gave one asset, newest first, clears included. */
export async function ratingHistory(db: CatalogDatabase, learnerId: string, assetId: string): Promise<StoredRating[]> {
  if (!(await ratingsExist(db))) return [];
  const rows = await db
    .select()
    .from(assetRating)
    .where(and(eq(assetRating.learnerId, learnerId), eq(assetRating.assetId, assetId)))
    .orderBy(...NEWEST_FIRST);
  return rows.map(toStored);
}

/**
 * The learner's current rating of every asset they rated, newest first: one
 * row per asset, its newest. A cleared one (value 0) is included, for a
 * report to count or leave out; an asset that has since been pruned is
 * included too, since the rating outlives it by design.
 */
export async function listCurrentRatings(db: CatalogDatabase, learnerId: string): Promise<StoredRating[]> {
  if (!(await ratingsExist(db))) return [];
  const rows = await db
    .select()
    .from(assetRating)
    .where(
      and(
        eq(assetRating.learnerId, learnerId),
        sql`${assetRating}.rowid = (
          select newer.rowid from asset_rating newer
          where newer.learner_id = ${assetRating.learnerId} and newer.asset_id = ${assetRating.assetId}
          order by newer.at desc, newer.rowid desc
          limit 1
        )`,
      ),
    )
    .orderBy(...NEWEST_FIRST);
  return rows.map(toStored);
}
