import { asset, assetJob, job as jobTable, ownerScope, video as videoTable, type OwnerScope } from "@hermes/schema";
import { and, eq, inArray } from "drizzle-orm";

import { CLI_OWNER, ownedBy } from "../content/scope";
import { withDatabase, type CatalogDatabase } from "../db";
import { REPO_ROOT } from "../env";
import { manimkcLibraryNames } from "../index/ingredients-scan";
import { listAssetIngredients, type StoredIngredients } from "../index/ingredients";
import { MANIMKC } from "../index/video-tool";
import {
  evalReport,
  formatEvalReport,
  type EvalReport,
  type ReportJob,
  type ReportVideo,
} from "../ingredients/report";
import type { IngredientMetrics } from "../ingredients/scan";
import { assertMigrated } from "../migrations";
import { listCurrentRatings, type StoredRating } from "../state/asset-ratings";

/**
 * `catalog eval report`: the owner's videos, how they were rated, what they
 * were made of and what the jobs behind them cost, grouped by tool, model and
 * prompt version. Read-only. The math is `ingredients/report.ts`; this file
 * only reads the rows into the shapes it takes.
 */

export interface EvalReportOptions {
  owner?: string;
  repoRoot?: string;
}

export interface EvalReportResult {
  ok: true;
  command: "eval report";
  owner: string;
  /** Whether manimkc's library was found, so the unused-helper list could be filled. */
  libraryFound: boolean;
  report: EvalReport;
}

/** The tool a stored job names: its brief's, else manimkc for a video and tldrawkc for a diagram. */
function jobTool(kind: string, brief: unknown): string {
  const named = (brief as { tool?: unknown } | null)?.tool;
  if (typeof named === "string" && named !== "") return named;
  return kind === "diagram" ? "tldrawkc" : "manimkc";
}

const TOOL_BY_PREFIX: ReadonlyArray<readonly [string, string]> = [
  ["manimkc:", "manimkc"],
  ["remotionkc:", "remotionkc"],
  ["revideokc:", "revideokc"],
  ["blenderkc:", "blenderkc"],
];

/** Which tool made a video: its id's namespace, else the stored scan's, else "studio". */
function videoTool(id: string, ingredients: StoredIngredients | undefined): string {
  for (const [prefix, name] of TOOL_BY_PREFIX) if (id.startsWith(prefix)) return name;
  return ingredients?.tool ?? "studio";
}

type JobRow = typeof jobTable.$inferSelect;

function wallSeconds(row: JobRow): number | null {
  if (row.startedAt === null || row.finishedAt === null) return null;
  const seconds = (row.finishedAt.getTime() - row.startedAt.getTime()) / 1000;
  return seconds >= 0 ? seconds : null;
}

function reportJob(row: JobRow): NonNullable<ReportVideo["job"]> {
  const run = row.run;
  return {
    model: run?.model.resolved ?? run?.model.passed ?? null,
    effort: run?.effort ?? null,
    manualHash: run?.manualHash ?? null,
    costUsd: row.costUsd,
    turns: row.turns,
    wallSeconds: wallSeconds(row),
    attempts: run === null || run === undefined ? (row.attempt > 0 ? row.attempt : null) : run.attempts.length,
    state: row.state,
  };
}

/** Job states a report counts: the ones that ended. */
const ENDED = ["accepted", "discarded", "failed", "cancelled", "interrupted"];

/**
 * A video's rating for the report. A rating that names a job is counted under
 * that job's model and prompt version, even when a newer job has replaced the
 * video; it is "of an older version" when that job is not the video's current
 * one, or when the bytes it judged are not the asset's now (both hashes known).
 */
function reportRating(
  rating: StoredRating,
  currentJobId: string | null,
  contentHash: string | null,
  jobsById: Map<string, JobRow>,
): NonNullable<ReportVideo["rating"]> {
  const judged = rating.jobId === null ? undefined : jobsById.get(rating.jobId);
  const stale =
    (rating.jobId !== null && rating.jobId !== currentJobId) ||
    (rating.assetHash !== null && contentHash !== null && rating.assetHash !== contentHash);
  return {
    value: rating.value,
    tags: [...rating.tags],
    job:
      rating.jobId === null
        ? null
        : {
            model: judged?.run?.model.resolved ?? judged?.run?.model.passed ?? null,
            manualHash: judged?.run?.manualHash ?? null,
          },
    stale,
  };
}

/** The report's inputs for one owner, read from the catalog. */
export async function readReportInputs(
  db: CatalogDatabase,
  scope: OwnerScope,
  owner: string,
): Promise<{ videos: ReportVideo[]; extraJobs: ReportJob[] }> {
  const assets = await db
    .select({ id: asset.id, title: asset.title, contentHash: asset.contentHash })
    .from(asset)
    .where(and(eq(asset.kind, "video"), ownedBy(asset.ownerId, scope.readable)));
  assets.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const ingredients = new Map((await listAssetIngredients(db, scope)).map((row) => [row.assetId, row] as const));
  const ratings = new Map((await listCurrentRatings(db, owner)).map((row) => [row.assetId, row] as const));
  const studio = new Map<string, number | null>(
    (
      await db
        .select({ slug: videoTable.slug, durationSeconds: videoTable.durationSeconds })
        .from(videoTable)
        .where(ownedBy(videoTable.ownerId, scope.readable))
    ).map((row) => [`video:${row.slug}`, row.durationSeconds] as const),
  );

  // Each video's producing job: the newest job that wrote it.
  const links = assets.length === 0
    ? []
    : await db
        .select({ assetId: assetJob.assetId, jobId: assetJob.jobId, writtenAt: assetJob.writtenAt })
        .from(assetJob)
        .where(inArray(assetJob.assetId, assets.map((a) => a.id)));
  const newest = new Map<string, { jobId: string; at: number }>();
  for (const link of links) {
    const at = link.writtenAt.getTime();
    const held = newest.get(link.assetId);
    if (held === undefined || at > held.at) newest.set(link.assetId, { jobId: link.jobId, at });
  }

  const jobs = await db.select().from(jobTable).where(ownedBy(jobTable.ownerId, scope.readable));
  const jobsById = new Map(jobs.map((row) => [row.id, row] as const));

  const videos: ReportVideo[] = assets.map((row) => {
    const stored = ingredients.get(row.id);
    const rating = ratings.get(row.id);
    const made = newest.get(row.id);
    const producer = made === undefined ? undefined : jobsById.get(made.jobId);
    return {
      assetId: row.id,
      tool: videoTool(row.id, stored),
      title: row.title ?? row.id,
      durationSeconds: stored?.durationSeconds ?? studio.get(row.id) ?? null,
      ingredients:
        stored === undefined
          ? null
          : {
              calls: stored.calls,
              metrics: stored.metrics as unknown as IngredientMetrics,
              sceneCount: stored.sceneCount,
            },
      rating: rating === undefined ? null : reportRating(rating, made?.jobId ?? null, row.contentHash, jobsById),
      job: producer === undefined ? null : reportJob(producer),
    };
  });

  // Every finished job counts once. The one behind a video as it is now is
  // that video's `job`; every other finished job (one that made no video, a
  // diagram job, or one a newer job replaced) is an extra, so an earlier
  // accepted job is not lost when a re-render takes its place.
  const current = new Set([...newest.values()].map((n) => n.jobId));
  const extraJobs: ReportJob[] = jobs
    .filter((row) => !current.has(row.id) && ENDED.includes(row.state))
    .map((row) => ({
      kind: row.kind,
      tool: jobTool(row.kind, row.brief),
      state: row.state,
      model: row.run?.model.resolved ?? row.run?.model.passed ?? null,
      manualHash: row.run?.manualHash ?? null,
      costUsd: row.costUsd,
      turns: row.turns,
      wallSeconds: wallSeconds(row),
      reviewTags: [...(row.review?.tags ?? [])],
    }));
  return { videos, extraJobs };
}

/** Run `eval report`. */
export async function runEvalReport(options: EvalReportOptions = {}): Promise<EvalReportResult> {
  const owner = (options.owner ?? CLI_OWNER).trim();
  const scope = ownerScope(owner);
  return withDatabase(async ({ db }) => {
    await assertMigrated(db);
    const { videos, extraJobs } = await readReportInputs(db, scope, owner);
    const names = await manimkcLibraryNames(MANIMKC.resolveRoot(options.repoRoot ?? REPO_ROOT));
    return {
      ok: true as const,
      command: "eval report" as const,
      owner,
      libraryFound: names !== null,
      report: evalReport(videos, extraJobs, names ?? undefined),
    };
  });
}

export function formatEval(result: EvalReportResult): string {
  const text = formatEvalReport(result.report).replace(/\n+$/, "");
  return result.libraryFound ? text : `${text}\n\nLibrary helpers: library not found (set MANIMKC_ROOT), so unused helpers are not listed.`;
}
