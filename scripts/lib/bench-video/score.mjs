// `bench:video score`: the critic's scores for a run that already exists,
// such as a baseline made before the critic did. It starts a runner over the
// home as `run` does, asks `POST /api/jobs/{id}/critic` of each accepted
// result with no critic recorded, and writes each answer into the run file as
// it comes, so a stop leaves what was scored and a second `score` carries on.
//
// The guards are `run`'s, minus the tool's doctor, which reading kept sheets
// does not need: the port must be free, the runner must report the cap it
// was given and find the claude CLI, and the home's rolling day must be under
// that cap. During the scoring the runner refuses a check at the cap (429),
// and the bench stops once what this scoring spent reaches the cap.
import { criticCurrent, criticFromView, verdictLine } from './critic.mjs';
import { writeJsonAtomic } from './home.mjs';
import { criticCostOf } from './metrics.mjs';
import { checkSpendGuards, readRun, standaloneCritic, Stop } from './run.mjs';

/**
 * Whether `score` asks about this result: an accepted video whose recorded
 * critic is not a read of the build in review. A result a standalone check
 * already answered for (a score, a 409 or an error) is left alone unless
 * `again`. A job's own current critic is never checked again.
 */
export function wantsScore(result, again = false) {
  if (result?.state !== 'accepted' || typeof result.jobId !== 'string' || result.jobId === '') return false;
  const critic = result.critic ?? null;
  if (critic === null) return true;
  if (critic.source === 'standalone') return again;
  return !criticCurrent(critic);
}

/**
 * Score the run in `runFile`. `options`: `{ home, label, cap, port, only,
 * again, runFile }`. `deps`: as `runBench` takes them (`start`, `envFor`,
 * `call`, `portFree`, `readJob`, `log`, `now`, `stopped`, `onJob`). Resolves
 * with the run as written; the runner is stopped however the scoring ends.
 */
export async function scoreRun(options, deps) {
  const { cap, runFile } = options;
  const { call, log, now = () => Date.now(), stopped = () => false } = deps;
  const run = readRun(runFile);
  if (run === null) throw new Error(`no run file at ${runFile}; score reads a run that already exists`);
  const only = options.only === undefined || options.only === null || options.only.length === 0 ? null : new Set(options.only);
  if (only !== null) {
    const known = new Set((run.results ?? []).map((result) => result.id));
    const unknown = [...only].filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`${runFile} has no result for ${unknown.join(', ')}`);
  }
  const targets = (run.results ?? []).filter((result) => (only === null || only.has(result.id)) && wantsScore(result, options.again === true));
  if (targets.length === 0) {
    log(`nothing to score: every selected accepted result in ${runFile} already has a critic recorded`);
    return run;
  }
  if (!(await deps.portFree(options.port))) {
    throw new Error(`something already listens on 127.0.0.1:${options.port}; stop it (an old bench runner, perhaps) or pass another --port`);
  }

  const byId = new Map(run.results.map((result, at) => [result.id, at]));
  const scoring = { startedAt: new Date(now()).toISOString(), endedAt: null, capUsd: cap, spentUsd: 0 };
  let begun = false;
  const save = () => {
    run.scoring = { ...scoring };
    writeJsonAtomic(runFile, run);
  };
  const put = (result) => {
    run.results[byId.get(result.id)] = result;
    save();
  };

  let runner = null;
  let stopReason = null;
  try {
    runner = await deps.start(deps.envFor(options));
    const base = runner.base;
    if (stopped()) throw new Stop('stopped before the first check');
    checkSpendGuards(await call(base, 'GET', '/api/health', undefined, { timeoutMs: 60_000 }), cap);
    begun = true;
    save();
    log(`bench: scoring ${targets.length} video${targets.length === 1 ? '' : 's'} of ${run.label}, cap $${cap.toFixed(2)} for this home's rolling day`);

    for (const target of targets) {
      if (stopped()) throw new Stop('stopped');
      if (scoring.spentUsd >= cap) throw new Stop(`this scoring's cost, $${scoring.spentUsd.toFixed(2)}, has reached the $${cap.toFixed(2)} cap`);
      const result = run.results[byId.get(target.id)];
      deps.onJob?.(result.jobId);
      const shown = await call(base, 'GET', `/api/jobs/${encodeURIComponent(result.jobId)}`).catch((error) => ({ status: 0, json: { error: error.message } }));
      if (shown.status !== 200) {
        // A job the runner does not know cannot be checked; say so and go on.
        log(`${result.id}: GET /api/jobs/${result.jobId} answered ${shown.status}; not scored`);
        put({ ...result, scoreError: `GET /api/jobs/${result.jobId} answered ${shown.status}` });
        continue;
      }
      const own = criticFromView(shown.json?.critic ?? null);
      if (criticCurrent(own) && !(options.again === true && result.critic?.source === 'standalone')) {
        // The job already has a read of its build in review: record it, pay nothing.
        put({ ...result, critic: own, criticCostUsd: criticCostOf(deps.readJob(result.jobId)?.job) ?? result.criticCostUsd ?? null });
        log(`${result.id}: the job's own critic ${verdictLine(own)}`);
        continue;
      }
      // The stop and the cap again, after the GET above, the last await
      // before the paid call; a stop leaves this video's record as it is.
      if (stopped()) throw new Stop('stopped');
      if (scoring.spentUsd >= cap) throw new Stop(`this scoring's cost, $${scoring.spentUsd.toFixed(2)}, has reached the $${cap.toFixed(2)} cap`);
      const checked = await standaloneCritic(call, base, result.jobId, shown.json);
      const paid = typeof checked.critic.costUsd === 'number' ? checked.critic.costUsd : null;
      scoring.spentUsd += paid ?? 0;
      // What this check cost is the bench's measuring, kept apart from what making the video cost.
      const before = typeof result.checkCostUsd === 'number' ? result.checkCostUsd : null;
      const checkCostUsd = paid === null ? before : (before ?? 0) + paid;
      put({ ...result, critic: checked.critic, criticCostUsd: criticCostOf(deps.readJob(result.jobId)?.job) ?? result.criticCostUsd ?? null, checkCostUsd });
      log(`${result.id}: standalone critic ${verdictLine(checked.critic)}`);
      if (checked.stop !== null) throw new Stop(`${result.id}: ${checked.stop}`);
    }
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    stopReason = error.message;
    log(`bench: stopping: ${stopReason}`);
  } finally {
    scoring.endedAt = new Date(now()).toISOString();
    if (stopReason !== null) scoring.stopReason = stopReason;
    try {
      if (begun) save();
    } finally {
      if (runner !== null) {
        const ended = await runner.stop();
        if (ended?.clean === false) {
          log(`bench: process groups ${ended.survivors.join(', ')} survived SIGKILL; check them with ps -g and stop them by hand`);
        } else if (ended?.clean === true) {
          log('bench: the runner and every process group it started are stopped');
        }
      }
    }
  }
  return run;
}
