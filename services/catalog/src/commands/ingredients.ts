import { ownerScope } from "@hermes/schema";

import { CLI_OWNER } from "../content/scope";
import { withDatabase } from "../db";
import { REPO_ROOT } from "../env";
import {
  manimkcLibraryNames,
  scanStudioVideos,
  storeToolIngredients,
  type IngredientsSkip,
  type StoreSummary,
} from "../index/ingredients-scan";
import { computeIngredientsForTool } from "../index/ingredients-tools";
import { hasToolCli, MANIMKC, readToolReport, toolCliPath, VIDEO_TOOLS } from "../index/video-tool";
import { assertMigrated } from "../migrations";

/**
 * `catalog ingredients scan`: what each video was made of, recorded in
 * `asset_ingredients`. It runs no import and writes no table but that one: it
 * reads each tool's `topics --json` and the studio's `video` rows, scans the
 * source, and upserts a row where the source, the scanner or the duration has
 * moved. It never prunes: a row for a video that is gone went with the
 * video, through the foreign key.
 */

export const INGREDIENT_SOURCES = ["manimkc", "remotionkc", "revideokc", "blenderkc", "studio"] as const;
export type IngredientSource = (typeof INGREDIENT_SOURCES)[number];

/** A wrong invocation: exit code 2. */
export class IngredientsUsage extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngredientsUsage";
  }
}

export interface IngredientsScanOptions {
  /** One source, or several joined with commas; default every source. */
  only?: string;
  owner?: string;
  force?: boolean;
  /** Where the tools' checkouts are looked for. Default: this repository. */
  repoRoot?: string;
}

export interface SourceScanResult {
  source: IngredientSource;
  /** False when the source was not run, with the reason in `notes`. */
  ran: boolean;
  scanned: number;
  written: number;
  unchanged: number;
  skipped: IngredientsSkip[];
  notes: string[];
}

export interface IngredientsScanResult {
  ok: true;
  command: "ingredients scan";
  owner: string;
  force: boolean;
  sources: SourceScanResult[];
}

function parseOnly(only: string | undefined): IngredientSource[] {
  if (only === undefined) return [...INGREDIENT_SOURCES];
  const wanted = only
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const bad = wanted.filter((s) => !(INGREDIENT_SOURCES as readonly string[]).includes(s));
  if (wanted.length === 0 || bad.length > 0) {
    throw new IngredientsUsage(`--only is ${INGREDIENT_SOURCES.join(", ")}, not "${bad[0] ?? only}"`);
  }
  return INGREDIENT_SOURCES.filter((s) => wanted.includes(s));
}

const notRun = (source: IngredientSource, notes: string[]): SourceScanResult => ({
  source,
  ran: false,
  scanned: 0,
  written: 0,
  unchanged: 0,
  skipped: [],
  notes,
});

const fromSummary = (source: IngredientSource, summary: StoreSummary, notes: string[]): SourceScanResult => ({
  source,
  ran: true,
  scanned: summary.scanned,
  written: summary.written,
  unchanged: summary.unchanged,
  skipped: summary.skipped,
  notes,
});

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Run `ingredients scan`. Throws only for a wrong invocation or a database that cannot be used. */
export async function runIngredientsScan(options: IngredientsScanOptions = {}): Promise<IngredientsScanResult> {
  const sources = parseOnly(options.only);
  const owner = (options.owner ?? CLI_OWNER).trim();
  const scope = ownerScope(owner);
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const force = options.force === true;

  return withDatabase(async ({ db }) => {
    await assertMigrated(db);
    const results: SourceScanResult[] = [];
    for (const source of sources) {
      if (source === "studio") {
        try {
          const names = await manimkcLibraryNames(MANIMKC.resolveRoot(repoRoot));
          const summary = await scanStudioVideos(db, scope, { force, ...(names === null ? {} : { libraryNames: names }) });
          results.push(
            fromSummary(
              source,
              summary,
              names === null ? ["manimkc's library was not found; star-imported helpers are not counted"] : [],
            ),
          );
        } catch (error) {
          results.push(notRun(source, [`failed: ${reason(error)}`]));
        }
        continue;
      }
      const tool = VIDEO_TOOLS.find((t) => t.name === source);
      if (tool === undefined) continue;
      if (!hasToolCli(tool, repoRoot)) {
        results.push(notRun(source, [`no ${source} CLI at ${toolCliPath(tool, repoRoot)}; skipped`]));
        continue;
      }
      try {
        const checkout = tool.resolveRoot(repoRoot);
        const report = await readToolReport(tool, repoRoot, checkout);
        const computed = await computeIngredientsForTool(tool, report, checkout);
        const summary = await storeToolIngredients(db, scope, computed, { force });
        results.push({
          ...fromSummary(source, summary, computed.notes),
          scanned: computed.videos.length + computed.skipped.length,
        });
      } catch (error) {
        results.push(notRun(source, [`failed: ${reason(error)}`]));
      }
    }
    return { ok: true as const, command: "ingredients scan" as const, owner, force, sources: results };
  });
}

/** How many skipped videos the text names before it says how many more. */
const SKIPS_SHOWN = 8;

export function formatIngredientsScan(result: IngredientsScanResult): string {
  const lines = [`ingredients scan for ${result.owner}${result.force ? " (forced)" : ""}`];
  for (const s of result.sources) {
    if (!s.ran) {
      lines.push(`  ${s.source.padEnd(11)} not run`);
    } else {
      lines.push(
        `  ${s.source.padEnd(11)} scanned ${s.scanned}, written ${s.written}, unchanged ${s.unchanged}, skipped ${s.skipped.length}`,
      );
    }
    for (const note of s.notes) lines.push(`    ${note}`);
    for (const skip of s.skipped.slice(0, SKIPS_SHOWN)) lines.push(`    skipped ${skip.id}: ${skip.reason}`);
    if (s.skipped.length > SKIPS_SHOWN) {
      lines.push(`    and ${s.skipped.length - SKIPS_SHOWN} more skipped (--json lists them)`);
    }
  }
  return lines.join("\n");
}
