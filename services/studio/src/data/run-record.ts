import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  checkJobReview,
  checkJobRun,
  JOB_RUN_LIMITS,
  RATING_LIMITS,
  type JobReview,
  type JobRun,
  type JobRunAttempt,
  type JobRunCritic,
  type JobRunGate,
  type JobVerdict,
  type RatingTagDown,
} from "@hermes/schema/shared";

import { jobDir, sessionLogPath, studioHome } from "../paths";
import { jobReview } from "./catalog";
import type { RecordStore, StoredRecord } from "./store";

/**
 * How a job ran, and why a person kept or dropped it: the runner's half of
 * `job.run` and `job.review` (the catalog's `checkJobRun` and
 * `checkJobReview` hold the shapes, in `@hermes/schema/shared`).
 *
 * The attempt history lives in the job's own `job.json` as `attempts`, one
 * entry appended as each agent attempt ends, and its gate summary filled in
 * once the gate has judged that attempt. At a terminal state the runner
 * builds a `JobRun` from the record, writes it to `jobs/<id>/run.json` and
 * hands that path to `catalog job finish --run-file`. A record that fails
 * `checkJobRun` never fails the job: the finish goes without `--run-file`
 * and the record says why (`runRecordError`).
 */

/** The harness every studio job runs on: the agents are `claude -p` and nothing else. */
export const HARNESS_NAME = "claude-code";

/** The file the run record is written to, inside the job's own workspace. */
export function runFilePath(jobId: string): string {
  return path.join(jobDir(jobId), "run.json");
}

/** The job's session log, relative to `STUDIO_HOME`, as `job.run.transcriptPath` stores it. */
export function transcriptRef(jobId: string): string {
  return path.relative(studioHome(), sessionLogPath(jobId)).split(path.sep).join("/");
}

/** What a gate result has that its summary needs. Both runners' gates have these. */
export interface GateLike {
  ok: boolean;
  steps: readonly { name: string; ok: boolean }[];
  findings: readonly string[];
  /** The video gate's; the diagram gate has none. */
  warnings?: readonly string[];
}

/** A gate result as `job.run` keeps it: pass or fail, each step's name and verdict, and two counts. */
export function gateSummary(gate: GateLike): JobRunGate {
  return {
    ok: gate.ok,
    steps: gate.steps.slice(0, JOB_RUN_LIMITS.maxGateSteps).map((step) => ({ name: clip(step.name || "step"), ok: step.ok })),
    findings: gate.findings.length,
    warnings: gate.warnings?.length ?? 0,
  };
}

/** An attempt as it starts: its number, when, and what the job's meter read then. */
export interface AttemptStart {
  n: number;
  startedAt: string;
  usdBefore: number | null;
}

export function startAttempt(n: number, usdBefore: number | null): AttemptStart {
  return { n, startedAt: new Date().toISOString(), usdBefore };
}

/**
 * An attempt as it ended. `turns` is the attempt's own result event's
 * `num_turns`, null for a session that was killed before it wrote one. The
 * cost is what the job's meter gained during the attempt: the meter is one
 * per job, so the difference of two readings is this attempt's share, exact
 * where both readings are and an estimate otherwise. Null when the meter
 * could price nothing.
 */
export function endAttempt(start: AttemptStart, outcome: { turns: number | null } | null, usdAfter: number | null): JobRunAttempt {
  const turns = outcome?.turns ?? null;
  return {
    n: start.n,
    startedAt: start.startedAt,
    endedAt: new Date().toISOString(),
    turns: turns !== null && Number.isInteger(turns) && turns >= 0 ? turns : null,
    costUsd: usdAfter === null ? null : Math.max(0, Math.round((usdAfter - (start.usdBefore ?? 0)) * 1_000_000) / 1_000_000),
    gate: null,
  };
}

/** `attempts` with `attempt` added, the newest kept when there are more than a run record holds. */
export function appendAttempt(attempts: readonly JobRunAttempt[] | undefined, attempt: JobRunAttempt): JobRunAttempt[] {
  return [...(attempts ?? []), attempt].slice(-JOB_RUN_LIMITS.maxAttempts);
}

/** `attempts` with attempt `n`'s gate set. An attempt the list does not hold is left out of it. */
export function withAttemptGate(attempts: readonly JobRunAttempt[] | undefined, n: number, gate: JobRunGate): JobRunAttempt[] {
  return (attempts ?? []).map((attempt) => (attempt.n === n ? { ...attempt, gate } : attempt));
}

/**
 * `attempts` with attempt `n`'s critic set: a vision critic's scores on that
 * attempt's contact sheets, or null for a critic that ran and gave none. An
 * attempt the list does not hold is left out of it, as `withAttemptGate`
 * leaves it. The scores are copied, so the record never shares an object
 * with the caller.
 */
export function withAttemptCritic(
  attempts: readonly JobRunAttempt[] | undefined,
  n: number,
  critic: JobRunCritic | null,
): JobRunAttempt[] {
  const copy = critic === null ? null : { ...critic, scores: { ...critic.scores } };
  return (attempts ?? []).map((attempt) => (attempt.n === n ? { ...attempt, critic: copy } : attempt));
}

/** How many times the job called each wrapper verb, from its `calls.ndjson`. */
export function callCounts(calls: readonly { verb: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const call of calls) counts[call.verb] = (counts[call.verb] ?? 0) + 1;
  return counts;
}

/** The wrapper verbs that render pictures: a preview or a still to look at, and the build. */
const RENDER_VERBS = new Set(["preview", "still", "build"]);

/**
 * Seconds spent rendering, from the wrapper's log: for each render call, its
 * `render` steps' own durations (the time inside the render profile, which
 * leaves out a build's narration), or its wall time when the call recorded no
 * steps. Null when the job made no wrapper call at all, since then nothing was
 * measured; zero when it made calls and none of them rendered.
 */
export function renderSeconds(
  calls: readonly { verb: string; startedAt: string; endedAt: string; steps?: readonly { step: string; ms: number }[] }[],
): number | null {
  if (calls.length === 0) return null;
  let ms = 0;
  for (const call of calls) {
    if (!RENDER_VERBS.has(call.verb)) continue;
    if (call.steps !== undefined && call.steps.length > 0) {
      for (const step of call.steps) if (step.step === "render" && Number.isFinite(step.ms) && step.ms > 0) ms += step.ms;
      continue;
    }
    const wall = Date.parse(call.endedAt) - Date.parse(call.startedAt);
    if (Number.isFinite(wall) && wall > 0) ms += wall;
  }
  return Math.round(ms) / 1000;
}

/** What `buildJobRun` reads off a job's record: the fields both runners' records carry. */
export interface RunSource {
  id: string;
  harnessVersion?: string | null;
  agentModel?: { passed: string | null } | null;
  agentEffort?: { passed: string | null } | null;
  resolvedModel?: string | null;
  manualHash?: string | null;
  manualVersion?: string | null;
  agentAuth?: string | null;
  attempts?: readonly JobRunAttempt[];
}

/** The `JobRun` a record describes, with the calls it made and the seconds it rendered. */
export function buildJobRun(
  record: RunSource,
  extra: { calls?: Record<string, number>; renderSeconds?: number | null } = {},
): JobRun {
  return {
    harness: { name: HARNESS_NAME, version: record.harnessVersion ?? null },
    model: { passed: record.agentModel?.passed ?? null, resolved: record.resolvedModel ?? null },
    effort: record.agentEffort?.passed ?? null,
    manualHash: record.manualHash ?? null,
    // Only a record that has one: an older job's run record stays as it was.
    ...(record.manualVersion === undefined ? {} : { manualVersion: record.manualVersion }),
    auth: record.agentAuth ?? null,
    attempts: [...(record.attempts ?? [])],
    calls: extra.calls ?? {},
    renderSeconds: extra.renderSeconds ?? null,
    transcriptPath: transcriptRef(record.id),
  };
}

/**
 * Check a run record and write it to `jobs/<id>/run.json`. `file` is the
 * path to pass as `--run-file`, or null with the reason when the record
 * failed `checkJobRun` or could not be written: the job then finishes
 * without one.
 */
export async function writeRunFile(jobId: string, run: JobRun): Promise<{ file: string; reason: null } | { file: null; reason: string }> {
  const checked = checkJobRun(run);
  if (!checked.ok) return { file: null, reason: `the run record was not stored: ${checked.reason}` };
  const file = runFilePath(jobId);
  try {
    await writeFile(file, `${JSON.stringify(checked.run, null, 1)}\n`, "utf8");
  } catch (error) {
    return { file: null, reason: `the run record could not be written: ${(error as Error).message}` };
  }
  return { file, reason: null };
}

/**
 * The `--run-file` for a job's `job finish`: its record built into a `JobRun`
 * and written into its workspace, or nothing when the record failed the check
 * or could not be written. A run record never fails a job: the reason goes
 * to the runner's log and onto the record as `runRecordError`, and the finish
 * goes ahead without one, exactly as before run records existed.
 */
export async function runFileFor<R extends StoredRecord & RunSource>(
  store: RecordStore<R>,
  id: string,
  extra: { calls?: Record<string, number>; renderSeconds?: number | null } = {},
): Promise<{ runFile?: string }> {
  const record = store.get(id);
  if (record === undefined) return {};
  const written = await writeRunFile(id, buildJobRun(record, extra));
  if (written.file !== null) return { runFile: written.file };
  console.error(`studio: job ${id}: ${written.reason}`);
  await store.update(id, { runRecordError: written.reason } as unknown as Partial<R>).catch(() => undefined);
  return {};
}

/* -------------------------------------------------------------------------- */
/* Reviews                                                                    */
/* -------------------------------------------------------------------------- */

/** Why a person discarded a job: down tags and a note, both possibly empty. */
export interface ReviewReason {
  tags: RatingTagDown[];
  note: string | null;
}

/**
 * The optional body of a discard, `{ tags, note }`. No body, `{}` or `null`,
 * or a body whose tags are empty and whose note is blank, is no reason at
 * all, which discards exactly as a discard always has. Tags are checked
 * against `RATING_TAGS_DOWN` and the note against `RATING_LIMITS.maxNoteChars`
 * by the same checker the catalog runs, so the two refuse with one sentence.
 */
export function parseReviewReason(body: unknown): { ok: true; reason: ReviewReason | null } | { ok: false; message: string } {
  if (body === undefined || body === null) return { ok: true, reason: null };
  if (typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: 'a discard\'s body is { "tags": [...], "note": "..." }, or nothing' };
  }
  const { tags, note } = body as { tags?: unknown; note?: unknown };
  const checked = checkJobReview({ verdict: "discard", tags: tags ?? [], note: note ?? null, at: new Date().toISOString() });
  if (!checked.ok) return { ok: false, message: checked.reason };
  const { tags: clean, note: cleanNote } = checked.review;
  return { ok: true, reason: clean.length === 0 && cleanNote === null ? null : { tags: clean, note: cleanNote } };
}

/** A review dated now, as the runner keeps it on its record beside the catalog's copy. */
export function reviewOf(verdict: JobVerdict, reason: ReviewReason = { tags: [], note: null }): JobReview {
  return { verdict, tags: [...reason.tags], note: reason.note, at: new Date().toISOString() };
}

/**
 * Keep a person's accept or revise on the job: on its record first (rule 7),
 * then in the catalog with `job review`. Never throws and never refuses:
 * the accept or the revise it follows has already happened, so a review that
 * does not land is noted on the record, as an accept whose job row did not
 * record it is (`indexed: false`), and nothing is undone.
 */
export async function keepReview<R extends StoredRecord>(
  store: RecordStore<R>,
  id: string,
  verdict: "accept" | "revise",
  reason?: ReviewReason,
): Promise<void> {
  try {
    if (store.get(id) === undefined) return;
    const review = reviewOf(verdict, reason);
    await store.update(id, { review } as unknown as Partial<R>);
    const stored = await jobReview(id, verdict, { tags: review.tags, note: review.note });
    if (!stored.ok) await store.noteCatalogError(id, stored.error ?? `the ${verdict} review was not recorded`);
  } catch (error) {
    console.error(`studio: job ${id}: the ${verdict} review was not kept: ${(error as Error).message}`);
  }
}

/** A revise's change request as a review's note: trimmed, and cut to the note limit. */
export function reviseNote(changes: string): string | null {
  const note = changes.trim().slice(0, RATING_LIMITS.maxNoteChars).trim();
  return note === "" ? null : note;
}

function clip(text: string): string {
  return text.length <= JOB_RUN_LIMITS.maxChars ? text : text.slice(0, JOB_RUN_LIMITS.maxChars);
}
