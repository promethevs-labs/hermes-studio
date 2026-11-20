// What a finished job left in the scratch STUDIO_HOME, read back: its record
// (`jobs/<id>/job.json`), its run record (`jobs/<id>/run.json`) and the look
// metrics of its kept scene source (`jobs/<id>/source/`, written after a
// verdict). The metrics come from the catalog's own pure scanner, so the
// bench and `catalog eval report` count a video the same way.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { scanSources } from '../../../services/catalog/src/ingredients/scan.ts';

/** The scene files each tool's source is made of, as `computeStudioIngredients` picks them. */
const SOURCE_FILES = { manimkc: /\.py$/, remotionkc: /\.tsx?$/, revideokc: /\.tsx?$/ };

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** `{ job, run }` for one job under `studioHome`; either is null when its file is missing or unreadable. */
export function readJobFiles(studioHome, jobId) {
  const dir = join(studioHome, 'jobs', jobId);
  return { job: readJson(join(dir, 'job.json')), run: readJson(join(dir, 'run.json')) };
}

/**
 * The four look numbers the bench compares, from the job's kept source, or
 * null when the job kept no scene file (a failed job, or one never reviewed).
 * `libraryNames` is manimkc's library listing (`manimkcLibraryNames`), which
 * a star-importing scene's helpers are counted against.
 */
export function sourceMetrics(studioHome, jobId, tool, libraryNames = undefined) {
  const dir = join(studioHome, 'jobs', jobId, 'source');
  const wanted = SOURCE_FILES[tool];
  if (wanted === undefined) return null;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const files = names
    .filter((name) => wanted.test(name))
    .sort()
    .map((name) => ({ path: name, text: readFileSync(join(dir, name), 'utf8') }));
  if (files.length === 0) return null;
  const { metrics } = scanSources(tool, files, libraryNames === undefined || libraryNames === null ? {} : { libraryNames });
  return {
    variety: metrics.variety,
    helperTop5Share: metrics.helperTop5Share,
    fadeShare: metrics.fadeShare,
    uses3d: metrics.uses3d,
  };
}

/**
 * The turns a job took over all its attempts. `job.turns` is only the last
 * attempt's: the video runner's `finish` writes the last agent session's own
 * `num_turns` there, while `run.attempts[].turns` holds each attempt's own
 * (`endAttempt` in services/studio/src/data/run-record.ts). So the attempt
 * history is summed when it is complete: every attempt has a count, and there
 * are as many entries as the job's attempt number says. Otherwise `job.turns`,
 * which undercounts a retried job but is the best figure left.
 */
export function turnsOf(job, attempts) {
  const complete =
    attempts.length > 0 &&
    attempts.every((attempt) => typeof attempt?.turns === 'number') &&
    (typeof job?.attempt !== 'number' || attempts.length >= job.attempt);
  if (complete) return attempts.reduce((sum, attempt) => sum + attempt.turns, 0);
  return typeof job?.turns === 'number' ? job.turns : null;
}

const seconds = (from, to) => {
  const start = Date.parse(from ?? '');
  const end = Date.parse(to ?? '');
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round((end - start) / 100) / 10 : null;
};

/**
 * The run-file fields a job's records give: gate verdict, attempts, turns,
 * cost, wall time and render time. `measuredSeconds` is the bench's own clock
 * from enqueue to the end, used when the record has no start or finish time.
 */
export function recordFields({ job, run }, measuredSeconds = null) {
  const attempts = Array.isArray(run?.attempts) ? run.attempts : [];
  const lastGate = [...attempts].reverse().find((attempt) => attempt?.gate !== null && attempt?.gate !== undefined)?.gate ?? null;
  const gateOk = typeof job?.gate?.ok === 'boolean' ? job.gate.ok : typeof lastGate?.ok === 'boolean' ? lastGate.ok : null;
  return {
    gateOk,
    attempts: attempts.length > 0 ? attempts.length : typeof job?.attempt === 'number' ? job.attempt : null,
    turns: turnsOf(job, attempts),
    costUsd: typeof job?.costUsd === 'number' ? job.costUsd : null,
    wallSeconds: seconds(job?.startedAt, job?.finishedAt) ?? measuredSeconds,
    renderSeconds: typeof run?.renderSeconds === 'number' ? run.renderSeconds : null,
    manualHash: run?.manualHash ?? job?.manualHash ?? null,
    resolvedModel: run?.model?.resolved ?? job?.resolvedModel ?? null,
  };
}
