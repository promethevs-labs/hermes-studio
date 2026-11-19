import { asset, assetIngredients as ingredientsTable, type OwnerScope } from "@hermes/schema";
import { and, asc, eq, sql } from "drizzle-orm";

import { bytewise } from "../sql-order";
import { cacheKey, ownedBy } from "../content/scope";
import type { CatalogDatabase } from "../db";
import { IndexError } from "./errors";

/**
 * What a video was made of (`asset_ingredients`): the one writer of that
 * table, and its two readers.
 *
 * Here, under `index/`, because the row is derived from the video's source
 * the way an import's rows are derived from files, and
 * `test/content-writes.test.ts` allows content and index writes only under
 * `content/` and `index/`. A scanner (a later change) computes the values;
 * this file stores them, one row per asset, replaced on every scan.
 */

/** One scan's result, as the writer takes it. `computedAt` defaults to now. */
export interface IngredientsInput {
  assetId: string;
  tool: string;
  scannerVersion: number;
  sourceHash: string;
  sceneCount: number | null;
  durationSeconds: number | null;
  /** Helper or call name to how many times the source made it. */
  calls: Record<string, number>;
  metrics: Record<string, unknown>;
  computedAt?: Date;
}

/** One stored row, as both readers return it. */
export interface StoredIngredients {
  assetId: string;
  ownerId: string;
  tool: string;
  scannerVersion: number;
  sourceHash: string;
  sceneCount: number | null;
  durationSeconds: number | null;
  calls: Record<string, number>;
  metrics: Record<string, unknown>;
  /** ISO 8601. */
  computedAt: string;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasTable = new WeakMap<object, true>();

/** Whether this database has `asset_ingredients` (0005). Only a yes is kept. */
async function ingredientsExist(db: CatalogDatabase): Promise<boolean> {
  const key = cacheKey(db);
  if (hasTable.has(key)) return true;
  const { rows } = await db.execute<{ present: number }>(
    sql`select exists(select 1 from sqlite_master where type = 'table' and name = 'asset_ingredients') as present`,
  );
  const present = rows[0]?.present === 1;
  if (present) hasTable.set(key, true);
  return present;
}

function toStored(row: typeof ingredientsTable.$inferSelect): StoredIngredients {
  return {
    assetId: row.assetId,
    ownerId: row.ownerId,
    tool: row.tool,
    scannerVersion: row.scannerVersion,
    sourceHash: row.sourceHash,
    sceneCount: row.sceneCount,
    durationSeconds: row.durationSeconds,
    calls: row.calls,
    metrics: row.metrics,
    computedAt: row.computedAt.toISOString(),
  };
}

/**
 * Store one scan of one video, replacing the row a scan before it wrote.
 * The owner is the asset's, read here, so the row is scoped exactly as the
 * video is; a missing asset is an `IndexError` naming it, never a skipped row.
 * `calls` must map names to whole counts, and `metrics` must be an object:
 * the table holds both as JSON objects and checks only that much.
 */
export async function upsertAssetIngredients(db: CatalogDatabase, row: IngredientsInput): Promise<StoredIngredients> {
  if (!isPlainObject(row.calls) || !Object.values(row.calls).every((n) => Number.isInteger(n) && n >= 0)) {
    throw new IndexError(`ingredients for "${row.assetId}": calls must map each name to a whole count, 0 or more.`);
  }
  if (!isPlainObject(row.metrics)) {
    throw new IndexError(`ingredients for "${row.assetId}": metrics must be an object.`);
  }
  const [owner] = await db.select({ ownerId: asset.ownerId }).from(asset).where(eq(asset.id, row.assetId)).limit(1);
  if (owner === undefined) throw new IndexError(`ingredients for "${row.assetId}": no such asset.`);

  const values = {
    assetId: row.assetId,
    ownerId: owner.ownerId,
    tool: row.tool,
    scannerVersion: row.scannerVersion,
    sourceHash: row.sourceHash,
    sceneCount: row.sceneCount,
    durationSeconds: row.durationSeconds,
    calls: row.calls,
    metrics: row.metrics,
    computedAt: row.computedAt ?? new Date(),
  };
  const [stored] = await db
    .insert(ingredientsTable)
    .values(values)
    .onConflictDoUpdate({
      target: ingredientsTable.assetId,
      set: { ...values, updatedAt: sql`cast(unixepoch('subsec') * 1000 as integer)` },
    })
    .returning();
  return toStored(stored!);
}

/** One video's ingredients, or null when there is no scan or the reader cannot read the video. */
export async function assetIngredients(
  db: CatalogDatabase,
  scope: OwnerScope,
  assetId: string,
): Promise<StoredIngredients | null> {
  if (!(await ingredientsExist(db))) return null;
  const [row] = await db
    .select()
    .from(ingredientsTable)
    .where(and(eq(ingredientsTable.assetId, assetId), ownedBy(ingredientsTable.ownerId, scope.readable)))
    .limit(1);
  return row === undefined ? null : toStored(row);
}

/** Every scanned video the reader can read, by asset id. */
export async function listAssetIngredients(db: CatalogDatabase, scope: OwnerScope): Promise<StoredIngredients[]> {
  if (!(await ingredientsExist(db))) return [];
  const rows = await db
    .select()
    .from(ingredientsTable)
    .where(ownedBy(ingredientsTable.ownerId, scope.readable))
    .orderBy(asc(bytewise(ingredientsTable.assetId)));
  return rows.map(toStored);
}
