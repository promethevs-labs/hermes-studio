import { readFile } from "node:fs/promises";
import path from "node:path";

import { asset, video as videoTable, type OwnerScope } from "@hermes/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { ownedBy } from "../content/scope";
import { inTransaction, type CatalogDatabase } from "../db";
import { pythonPublicNames, scanSources, type Ingredients, type IngredientsTool, type SourceFile } from "../ingredients/scan";
import { assetIngredients, upsertAssetIngredients } from "./ingredients";

/**
 * Turning a video's source into its `asset_ingredients` row.
 *
 * Two halves. The compute half reads each video's scene source from disk
 * (a tool's topic folders) or from the `video` row (a studio video) and runs
 * the scanner over it; it never throws for one bad topic, it returns that
 * topic in `skipped` with the reason. The store half writes the rows through
 * `upsertAssetIngredients`, the one writer of the table, and leaves a row
 * alone when its source hash, scanner version and duration have not moved.
 *
 * Both `catalog import` (after each tool's rows land) and `catalog ingredients
 * scan` call the same two halves, so a row means the same whichever wrote it.
 *
 * The compute half for a tool's topic folders lives in `ingredients-tools.ts`,
 * not here: this module is reached from the web app (`content/videos.ts` scans
 * a studio video as it is put), and the folder walk's computed paths made
 * Turbopack trace the whole repository into the server bundle. Nothing in the
 * web app's graph needs it.
 */

/** The library files whose public names a star-importing manimkc scene can call. */
const MANIMKC_LIBRARY_FILES = ["cslib.py", "lesson.py", "pipechart.py"] as const;

/** Files a TypeScript tool's topic folder is scanned for. */
export const TS_SOURCE = /\.tsx?$/;

export interface IngredientsSkip {
  /** The asset id when known, else the topic folder or studio slug. */
  id: string;
  reason: string;
}

export interface VideoIngredients {
  assetId: string;
  topicPath: string;
  durationSeconds: number | null;
  ingredients: Ingredients;
}

export interface ToolComputation {
  tool: IngredientsTool;
  videos: VideoIngredients[];
  skipped: IngredientsSkip[];
  notes: string[];
}

/**
 * The public callable names of manimkc's library, read from the checkout's `lib/`.
 * Null when the checkout has none of them, so a caller can say the library
 * was not found rather than report every star-imported helper as unused.
 */
export async function manimkcLibraryNames(checkout: string): Promise<string[] | null> {
  const names = new Set<string>();
  let found = 0;
  for (const file of MANIMKC_LIBRARY_FILES) {
    try {
      const text = await readFile(path.join(checkout, "lib", file), "utf8");
      found += 1;
      // Constants (`ACCENT`, `PANEL_BG`) are values, not helpers a scene calls.
      for (const name of pythonPublicNames(text)) if (!/^[A-Z][A-Z0-9_]*$/.test(name)) names.add(name);
    } catch {
      // A missing file is a smaller library, not a failure.
    }
  }
  return found === 0 ? null : [...names].sort();
}

/** The tool a studio video's brief names; manimkc when it names none. */
function studioTool(brief: unknown): IngredientsTool | null {
  const tool = (brief as { tool?: unknown } | null)?.tool;
  if (tool === undefined || tool === null || tool === "" || tool === "manimkc") return "manimkc";
  if (tool === "remotionkc" || tool === "revideokc" || tool === "blenderkc") return tool;
  return null;
}

export interface StudioIngredients {
  tool: IngredientsTool;
  durationSeconds: number | null;
  ingredients: Ingredients;
}

/**
 * The ingredients of one studio video, from its `video.source`
 * (`{ files: { name: text }, brief }`). Returns a reason instead of a result
 * when the source is not in that shape or names a tool the scanner does not
 * know.
 */
export function computeStudioIngredients(
  source: unknown,
  durationSeconds: number | null,
  libraryNames?: readonly string[],
): StudioIngredients | { problem: string } {
  const record = source as { files?: unknown; brief?: unknown } | null;
  const filesObject = record?.files;
  if (typeof filesObject !== "object" || filesObject === null || Array.isArray(filesObject)) {
    return { problem: "the video's source holds no files" };
  }
  const tool = studioTool(record?.brief);
  if (tool === null) return { problem: "the brief names a video tool the scanner does not know" };
  const wanted = tool === "manimkc" || tool === "blenderkc" ? /\.py$/ : TS_SOURCE;
  const files: SourceFile[] = Object.entries(filesObject as Record<string, unknown>)
    .filter(([name, text]) => wanted.test(name) && typeof text === "string")
    .map(([name, text]) => ({ path: name, text: text as string }));
  if (files.length === 0) return { problem: "the video's source holds no scene files" };
  const ingredients = scanSources(tool, files, libraryNames === undefined ? {} : { libraryNames });
  return { tool, durationSeconds, ingredients };
}

export interface StoreSummary {
  scanned: number;
  written: number;
  unchanged: number;
  skipped: IngredientsSkip[];
}

export interface StoreOptions {
  /** Rewrite a row whose source, scanner, library and duration have not moved. */
  force?: boolean;
}

interface Pending {
  assetId: string;
  tool: string;
  durationSeconds: number | null;
  ingredients: Ingredients;
}

/** What storing one video came to: written, left alone, or the reason it was skipped. */
type Stored = "written" | "unchanged" | { skipped: string };

/**
 * Store one video's scan. The row is left alone when its source hash,
 * scanner version, library hash and duration all match what this scan
 * computed: the library hash is in the key because a scan made while the
 * library was missing counts no helper, and must be redone when it is back.
 * A video the scope cannot read is skipped, not an error.
 */
async function storeOne(
  db: CatalogDatabase,
  scope: OwnerScope,
  item: Pending,
  options: StoreOptions,
): Promise<Stored> {
  try {
    if (!(await readableAssets(db, scope, [item.assetId])).has(item.assetId)) {
      return { skipped: "no such video in the catalog for this owner" };
    }
    if (options.force !== true) {
      const stored = await assetIngredients(db, scope, item.assetId);
      if (
        stored !== null &&
        stored.sourceHash === item.ingredients.sourceHash &&
        stored.scannerVersion === item.ingredients.scannerVersion &&
        stored.metrics["libraryHash"] === item.ingredients.metrics.libraryHash &&
        stored.durationSeconds === item.durationSeconds
      ) {
        return "unchanged";
      }
    }
    await upsertAssetIngredients(db, {
      assetId: item.assetId,
      tool: item.tool,
      scannerVersion: item.ingredients.scannerVersion,
      sourceHash: item.ingredients.sourceHash,
      sceneCount: item.ingredients.sceneCount,
      durationSeconds: item.durationSeconds,
      calls: item.ingredients.calls,
      metrics: { ...item.ingredients.metrics },
    });
    return "written";
  } catch (error) {
    return { skipped: error instanceof Error ? error.message : String(error) };
  }
}

/** The asset ids among `ids` the scope can read, in chunks the driver takes. */
async function readableAssets(db: CatalogDatabase, scope: OwnerScope, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let at = 0; at < ids.length; at += 400) {
    const rows = await db
      .select({ id: asset.id })
      .from(asset)
      .where(and(inArray(asset.id, ids.slice(at, at + 400)), ownedBy(asset.ownerId, scope.readable)));
    for (const row of rows) found.add(row.id);
  }
  return found;
}

function tally(summary: StoreSummary, id: string, stored: Stored): void {
  if (stored === "written") summary.written += 1;
  else if (stored === "unchanged") summary.unchanged += 1;
  else summary.skipped.push({ id, reason: stored.skipped });
}

/** Store a tool's computed ingredients. A video that is not in the catalog is skipped, never an error. */
export async function storeToolIngredients(
  db: CatalogDatabase,
  scope: OwnerScope,
  computation: ToolComputation,
  options: StoreOptions = {},
): Promise<StoreSummary> {
  const summary: StoreSummary = {
    scanned: computation.videos.length,
    written: 0,
    unchanged: 0,
    skipped: [...computation.skipped],
  };
  for (const v of computation.videos) {
    const stored = await storeOne(
      db,
      scope,
      { assetId: v.assetId, tool: computation.tool, durationSeconds: v.durationSeconds, ingredients: v.ingredients },
      options,
    );
    tally(summary, v.assetId, stored);
  }
  return summary;
}

/** The studio's videos the scope can read and has not archived. */
async function studioRows(db: CatalogDatabase, scope: OwnerScope, slug?: string) {
  return db
    .select({
      slug: videoTable.slug,
      source: videoTable.source,
      sourceHash: videoTable.sourceHash,
      durationSeconds: videoTable.durationSeconds,
    })
    .from(videoTable)
    .where(
      and(
        isNull(videoTable.archivedAt),
        ownedBy(videoTable.ownerId, scope.readable),
        slug === undefined ? undefined : eq(videoTable.slug, slug),
      ),
    );
}

/** What the read step of a studio scan saw: the computed rows, and the source each came from. */
export interface StudioPlan {
  entries: Array<{ slug: string; sourceHash: string; item: Pending }>;
  skipped: IngredientsSkip[];
  /** How many videos the read step looked at. */
  read: number;
}

/**
 * Step one of a studio scan: read each video's stored source and compute its
 * ingredients. Nothing is written. `sourceHash` is the identity of the source
 * that was read, which step two checks again before it writes.
 */
export async function readStudioScan(
  db: CatalogDatabase,
  scope: OwnerScope,
  options: { slug?: string; libraryNames?: readonly string[] } = {},
): Promise<StudioPlan> {
  const rows = await studioRows(db, scope, options.slug);
  const plan: StudioPlan = { entries: [], skipped: [], read: rows.length };
  for (const row of rows) {
    const id = `video:${row.slug}`;
    const computed = computeStudioIngredients(row.source, row.durationSeconds, options.libraryNames);
    if ("problem" in computed) {
      plan.skipped.push({ id, reason: computed.problem });
      continue;
    }
    plan.entries.push({
      slug: row.slug,
      sourceHash: row.sourceHash,
      item: { assetId: id, tool: computed.tool, durationSeconds: computed.durationSeconds, ingredients: computed.ingredients },
    });
  }
  return plan;
}

/**
 * Step two: write the plan, each video in its own transaction that first
 * reads the video's source hash as stored now. A video whose source moved
 * since step one (a `video put` landed in between) is skipped as "changed
 * during the scan": the put's own scan has the newer answer, and an older
 * copy must not overwrite it.
 */
export async function writeStudioScan(
  db: CatalogDatabase,
  scope: OwnerScope,
  plan: StudioPlan,
  options: StoreOptions = {},
): Promise<StoreSummary> {
  const summary: StoreSummary = { scanned: plan.read, written: 0, unchanged: 0, skipped: [...plan.skipped] };
  for (const entry of plan.entries) {
    let stored: Stored;
    try {
      stored = await inTransaction(db, async (tx) => {
        const [now] = await tx
          .select({ sourceHash: videoTable.sourceHash, archivedAt: videoTable.archivedAt })
          .from(videoTable)
          .where(and(eq(videoTable.slug, entry.slug), ownedBy(videoTable.ownerId, scope.readable)));
        if (now === undefined || now.archivedAt !== null || now.sourceHash !== entry.sourceHash) {
          return { skipped: "changed during the scan" } as Stored;
        }
        return storeOne(tx, scope, entry.item, options);
      });
    } catch (error) {
      stored = { skipped: error instanceof Error ? error.message : String(error) };
    }
    tally(summary, entry.item.assetId, stored);
  }
  return summary;
}

/**
 * Compute and store the ingredients of the studio's videos (`video:<slug>`
 * assets) the scope can read, or of one when `slug` is given.
 * `libraryNames` are manimkc's, for scenes that star-import its library.
 */
export async function scanStudioVideos(
  db: CatalogDatabase,
  scope: OwnerScope,
  options: StoreOptions & { slug?: string; libraryNames?: readonly string[] } = {},
): Promise<StoreSummary> {
  const plan = await readStudioScan(db, scope, options);
  return writeStudioScan(db, scope, plan, options);
}
