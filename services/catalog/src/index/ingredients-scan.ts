import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { asset, video as videoTable, type OwnerScope } from "@hermes/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { ownedBy } from "../content/scope";
import type { CatalogDatabase } from "../db";
import {
  pythonPublicNames,
  scanSources,
  type Ingredients,
  type IngredientsTool,
  type SourceFile,
} from "../ingredients/scan";
import { assetIngredients, upsertAssetIngredients } from "./ingredients";
import { type TopicsReport, type VideoTool, videoToolAssetId } from "./video-tool";

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
 */

/** The library files whose public names a star-importing manimkc scene can call. */
const MANIMKC_LIBRARY_FILES = ["cslib.py", "lesson.py", "pipechart.py"] as const;

/** Files a TypeScript tool's topic folder is scanned for, and the folders it never enters. */
const TS_SOURCE = /\.tsx?$/;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist"]);
/** A topic folder with more source than this is cut off, and says so. */
const MAX_SOURCE_FILES = 500;

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
 * The public names of manimkc's library, read from the checkout's `lib/`.
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
      for (const name of pythonPublicNames(text)) names.add(name);
    } catch {
      // A missing file is a smaller library, not a failure.
    }
  }
  return found === 0 ? null : [...names].sort();
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

/** One `KEY=value` line of a dotenv file, as the tools' own CLIs read it. */
async function dotenvValue(file: string, key: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return "";
  }
  for (const line of text.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match === null || match[1] !== key) continue;
    return (match[2] ?? "").replace(/^(["'])(.*)\1$/, "$2").trim();
  }
  return "";
}

/**
 * Where a tool's topic folders are. The report names it when it can
 * (`topicsRoot`, manimkc). The other tools' CLIs resolve it the same way
 * among themselves: `$<TOOL>_TOPICS` from the environment, else the same
 * line in the checkout's `.env`, else `<checkout>/topics`; a value must be
 * absolute after `~/` is expanded.
 */
export async function resolveTopicsRoot(
  tool: VideoTool,
  report: TopicsReport & { topicsRoot?: unknown },
  checkout: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ dir: string } | { problem: string }> {
  if (typeof report.topicsRoot === "string" && report.topicsRoot.trim() !== "") {
    return { dir: path.resolve(report.topicsRoot) };
  }
  const variable = `${tool.name.toUpperCase()}_TOPICS`;
  let value = (env[variable] ?? "").trim();
  let from = "the environment";
  if (value === "") {
    value = await dotenvValue(path.join(checkout, ".env"), variable);
    from = path.join(checkout, ".env");
  }
  if (value === "") return { dir: path.join(checkout, "topics") };
  const expanded = expandHome(value);
  if (!path.isAbsolute(expanded)) {
    return { problem: `${variable} must be an absolute path, got ${JSON.stringify(value)} (from ${from})` };
  }
  return { dir: path.resolve(expanded) };
}

/** Every `.ts` and `.tsx` under `dir`, skipping node_modules, dist and dot folders; sorted, relative, `/`-separated. */
async function walkTypeScript(dir: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (current: string, prefix: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (found.length >= MAX_SOURCE_FILES) return;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) continue;
        await visit(path.join(current, entry.name), rel);
      } else if (entry.isFile() && TS_SOURCE.test(entry.name)) {
        found.push(rel);
      }
    }
  };
  await visit(dir, "");
  return found;
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/** True when `child` is inside `parent`, so a report cannot point the scan at a file elsewhere. */
function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

interface SectionLike {
  deliverable?: { path?: unknown; exists?: unknown; duration?: unknown } | null;
  files?: unknown;
}

/** The scenes a section's files name, summed, or undefined when none do. */
function reportedSceneCount(files: unknown): number | undefined {
  if (!Array.isArray(files)) return undefined;
  let total = 0;
  for (const file of files as Array<{ scenes?: unknown }>) {
    if (Array.isArray(file?.scenes)) total += file.scenes.length;
  }
  return total > 0 ? total : undefined;
}

/**
 * The ingredients of every rendered video in a tool's report. Source files
 * per video: manimkc and blenderkc, the section's own files under the topic
 * folder; remotionkc and revideokc, every `.ts` and `.tsx` in the topic
 * folder. A video whose source cannot be read is skipped with the reason,
 * and nothing here throws for one topic.
 */
export async function computeIngredientsForTool(
  tool: VideoTool,
  report: TopicsReport & { topicsRoot?: unknown },
  checkout: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<ToolComputation> {
  const result: ToolComputation = { tool: tool.name, videos: [], skipped: [], notes: [] };
  const topics = await resolveTopicsRoot(tool, report, checkout, options.env);
  if ("problem" in topics) {
    result.notes.push(topics.problem);
    result.skipped.push({ id: tool.name, reason: topics.problem });
    return result;
  }

  let libraryNames: string[] | undefined;
  if (tool.name === "manimkc") {
    const names = await manimkcLibraryNames(checkout);
    if (names === null) {
      result.notes.push(`manimkc's library was not found under ${path.join(checkout, "lib")}; star-imported helpers are not counted`);
    } else {
      libraryNames = names;
    }
  }
  const typeScript = tool.name === "remotionkc" || tool.name === "revideokc";

  for (const entry of Array.isArray(report.topics) ? report.topics : []) {
    const topicPath = str(entry?.path);
    if (topicPath === null) continue;
    const topicDir = path.join(topics.dir, topicPath);
    if (!inside(topicDir, topics.dir)) {
      result.skipped.push({ id: topicPath, reason: "the topic path leaves the topics folder" });
      continue;
    }
    let walked: string[] | null = null;

    for (const rawSection of Array.isArray(entry.sections) ? (entry.sections as SectionLike[]) : []) {
      const deliverable = rawSection?.deliverable;
      if (!deliverable || deliverable.exists !== true) continue;
      const videoPath = str(deliverable.path);
      if (videoPath === null) continue;
      const assetId = videoToolAssetId(tool, videoPath);
      try {
        let names: string[];
        if (typeScript) {
          walked ??= await walkTypeScript(topicDir);
          names = walked;
        } else {
          names = (Array.isArray(rawSection.files) ? (rawSection.files as Array<{ file?: unknown }>) : [])
            .map((f) => str(f?.file))
            .filter((f): f is string => f !== null);
        }
        if (names.length === 0) {
          result.skipped.push({ id: assetId, reason: `no source files for ${topicPath}` });
          continue;
        }
        const files: SourceFile[] = [];
        let unreadable: string | null = null;
        for (const name of names) {
          const file = path.join(topicDir, name);
          if (!inside(file, topicDir)) {
            unreadable = `${name} leaves the topic folder`;
            break;
          }
          try {
            files.push({ path: name, text: await readFile(file, "utf8") });
          } catch {
            unreadable = `${path.join(topicDir, name)} cannot be read`;
            break;
          }
        }
        if (unreadable !== null) {
          result.skipped.push({ id: assetId, reason: unreadable });
          continue;
        }
        const sceneCount = reportedSceneCount(rawSection.files);
        const ingredients = scanSources(tool.name, files, {
          ...(sceneCount === undefined ? {} : { sceneCount }),
          ...(libraryNames === undefined ? {} : { libraryNames }),
        });
        const duration = deliverable.duration;
        result.videos.push({
          assetId,
          topicPath,
          durationSeconds: typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : null,
          ingredients,
        });
      } catch (error) {
        result.skipped.push({ id: assetId, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  if (typeScript && result.videos.length > 0 && result.videos.some((v) => v.ingredients.metrics.files >= MAX_SOURCE_FILES)) {
    result.notes.push(`a topic folder held more than ${MAX_SOURCE_FILES} source files; the first ${MAX_SOURCE_FILES} were scanned`);
  }
  return result;
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
  /** Rewrite a row whose source hash, scanner version and duration have not moved. */
  force?: boolean;
}

interface Pending {
  assetId: string;
  tool: string;
  durationSeconds: number | null;
  ingredients: Ingredients;
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

async function storePending(
  db: CatalogDatabase,
  scope: OwnerScope,
  pending: Pending[],
  options: StoreOptions,
): Promise<StoreSummary> {
  const summary: StoreSummary = { scanned: pending.length, written: 0, unchanged: 0, skipped: [] };
  const known = await readableAssets(db, scope, pending.map((p) => p.assetId));
  for (const item of pending) {
    try {
      if (!known.has(item.assetId)) {
        summary.skipped.push({ id: item.assetId, reason: "no such video in the catalog for this owner" });
        continue;
      }
      if (options.force !== true) {
        const stored = await assetIngredients(db, scope, item.assetId);
        if (
          stored !== null &&
          stored.sourceHash === item.ingredients.sourceHash &&
          stored.scannerVersion === item.ingredients.scannerVersion &&
          stored.durationSeconds === item.durationSeconds
        ) {
          summary.unchanged += 1;
          continue;
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
      summary.written += 1;
    } catch (error) {
      summary.skipped.push({ id: item.assetId, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return summary;
}

/** Store a tool's computed ingredients. A video that is not in the catalog is skipped, never an error. */
export async function storeToolIngredients(
  db: CatalogDatabase,
  scope: OwnerScope,
  computation: ToolComputation,
  options: StoreOptions = {},
): Promise<StoreSummary> {
  const stored = await storePending(
    db,
    scope,
    computation.videos.map((v) => ({
      assetId: v.assetId,
      tool: computation.tool,
      durationSeconds: v.durationSeconds,
      ingredients: v.ingredients,
    })),
    options,
  );
  return { ...stored, skipped: [...computation.skipped, ...stored.skipped] };
}

/** The studio's videos the scope can read and has not archived. */
async function studioRows(db: CatalogDatabase, scope: OwnerScope, slug?: string) {
  return db
    .select({
      slug: videoTable.slug,
      source: videoTable.source,
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
  const rows = await studioRows(db, scope, options.slug);
  const pending: Pending[] = [];
  const skipped: IngredientsSkip[] = [];
  for (const row of rows) {
    const id = `video:${row.slug}`;
    const computed = computeStudioIngredients(row.source, row.durationSeconds, options.libraryNames);
    if ("problem" in computed) {
      skipped.push({ id, reason: computed.problem });
      continue;
    }
    pending.push({ assetId: id, tool: computed.tool, durationSeconds: computed.durationSeconds, ingredients: computed.ingredients });
  }
  const stored = await storePending(db, scope, pending, options);
  return { ...stored, scanned: rows.length, skipped: [...skipped, ...stored.skipped] };
}
