// `bench:video run`: the loop. One brief at a time through a runner the bench
// started over its scratch home, every step written to the run file as it
// happens, so a crash or a Ctrl-C leaves a record of what was spent.
//
// The order of guards before money moves: the run file and label are checked,
// the port must be free (so the runner answering is the bench's own), the
// runner must report the cap it was given and the claude CLI, and the tool's
// own doctor must pass. Only then is the one line naming the count, tool,
// model and cap printed, and the first brief posted. During the run the
// runner's STUDIO_DAILY_USD refuses an enqueue at the cap (429), and the bench
// also stops before posting once its own recorded costs reach the cap.
import { existsSync, readFileSync } from 'node:fs';

import { jobBody, runSlug } from './briefs.mjs';
import { costOf } from './cost.mjs';
import { recordFields } from './metrics.mjs';
import { writeJsonAtomic } from './home.mjs';

/** Job states after which the runner does nothing more on its own. */
export const SETTLED = Object.freeze(['awaiting_review', 'accepted', 'discarded', 'failed', 'cancelled', 'interrupted']);

/** Recorded states a resume leaves alone. */
const DONE = new Set(['accepted', 'failed', 'cancelled']);

/** Error kinds that say the machine, not the video, is the problem: a run stops on one unless --keep-going. */
export const SYSTEMIC_ERRORS = Object.freeze(['agent', 'spawn', 'toolchain', 'internal', 'not-claimed']);

const NOT_YET = /has not finished its first check/;

/**
 * What to do with one brief given what the run file already says about it.
 * `post` enqueues (a repeated `attempt` reuses the idempotency key, so a post
 * the runner already took is answered with that job rather than paid twice),
 * `check` asks the runner about the recorded job first, `skip` leaves it.
 */
export function planFor(previous) {
  if (previous === undefined) return { action: 'post', attempt: 1 };
  const tries = typeof previous.tries === 'number' && previous.tries > 0 ? previous.tries : 1;
  // A post that never got an answer may still have reached the runner, which
  // may have queued it, paid for it, or put it in review. Reposting with the
  // same attempt sends the same idempotency key, so the runner answers with
  // that job instead of queueing a second one under the same slug.
  if (previous.state === 'posting' || previous.state === 'unanswered') return { action: 'post', attempt: tries };
  if (DONE.has(previous.state) && previous.stopped !== true) return { action: 'skip' };
  if (typeof previous.jobId === 'string' && previous.jobId !== '') return { action: 'check', attempt: tries };
  return { action: 'post', attempt: tries + 1 };
}

/** A result with every field the run file promises, null where nothing is known. */
export function emptyResult(id) {
  return {
    id,
    jobId: null,
    state: null,
    gateOk: null,
    attempts: null,
    turns: null,
    costUsd: null,
    wallSeconds: null,
    renderSeconds: null,
    metrics: null,
    error: null,
  };
}

/** The manual hashes the run's jobs carried, each once. */
function manualHashes(results) {
  return [...new Set(results.map((result) => result.manualHash).filter((hash) => typeof hash === 'string' && hash !== ''))];
}

/** Read a run file, or null when there is none. */
export function readRun(file) {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** What the runner's health says about one tool: `{ ready, reason }`, `ready: null` while its doctor is still checking. */
export function toolReadiness(health, tool) {
  const entry = (health?.video?.tools ?? []).find((candidate) => candidate?.name === tool);
  if (entry === undefined) return { ready: null, reason: 'the runner has not listed its video tools yet' };
  if (entry.available === true) return { ready: true, reason: null };
  const reason = typeof entry.reason === 'string' ? entry.reason : `${tool} is not available`;
  return NOT_YET.test(reason) ? { ready: null, reason } : { ready: false, reason };
}

class Stop extends Error {}

export { costOf };

/**
 * Run the selected briefs. `options`: `{ home, label, tool, model, cap, port,
 * keepGoing, resume, entries, runFile, env }`. `deps`: `start(env)` resolves
 * `{ base, stop }` for a runner over the home; `call(base, method, path,
 * body, opts)` answers `{ status, json }`; `envFor(options)` is the runner's
 * environment; `portFree(port)`, `readJob(jobId)`, `metrics(jobId)`,
 * `sleep(ms)`, `now()`, `log(line)`, `stopped()`, and the timing knobs
 * `pollMs`, `healthMs`, `doctorWaitMs`, `jobTimeoutMs`. Resolves with the run
 * as written; the runner is stopped however the run ends.
 */
export async function runBench(options, deps) {
  const { label, tool, cap, entries, runFile } = options;
  const model = options.model ?? null;
  const { call, log, now = () => Date.now(), stopped = () => false } = deps;
  const pollMs = deps.pollMs ?? 10_000;
  const healthMs = deps.healthMs ?? 5_000;
  const doctorWaitMs = deps.doctorWaitMs ?? 15 * 60_000;
  const jobTimeoutMs = deps.jobTimeoutMs ?? 3 * 60 * 60_000;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  const existing = readRun(runFile);
  if (existing !== null && options.resume !== true) {
    throw new Error(`${runFile} already exists; pass --resume to carry on with it, or pick another --label`);
  }
  if (existing !== null && (existing.tool !== tool || (existing.model ?? null) !== model)) {
    throw new Error(`${runFile} was run with ${existing.tool} and model ${existing.model ?? 'default'}; a resume must use the same tool and model`);
  }
  const results = new Map((existing?.results ?? []).map((result) => [result.id, result]));
  const run = {
    label,
    tool,
    model,
    capUsd: cap,
    startedAt: existing?.startedAt ?? new Date(now()).toISOString(),
    endedAt: null,
    manualHashes: [],
    results: [],
  };
  const order = [...new Set([...entries.map((entry) => entry.id), ...results.keys()])].sort((a, b) => a.localeCompare(b, 'en'));
  const save = () => {
    run.results = order.filter((id) => results.has(id)).map((id) => results.get(id));
    run.manualHashes = manualHashes(run.results);
    writeJsonAtomic(runFile, run);
  };
  const put = (result) => {
    results.set(result.id, result);
    save();
  };
  const spent = () => [...results.values()].reduce((sum, result) => sum + costOf(result), 0);

  const plans = entries.map((entry) => ({ entry, plan: planFor(results.get(entry.id)) }));
  const work = plans.filter(({ plan }) => plan.action !== 'skip');
  if (work.length === 0) {
    log(`nothing to run: every selected brief is already recorded in ${runFile}`);
    run.endedAt = new Date(now()).toISOString();
    save();
    return run;
  }

  if (!(await deps.portFree(options.port))) {
    throw new Error(`something already listens on 127.0.0.1:${options.port}; stop it (an old bench runner, perhaps) or pass another --port`);
  }

  const waitOrStop = async (ms) => {
    const until = now() + ms;
    while (!stopped() && now() < until) await sleep(Math.min(1_000, Math.max(0, until - now())));
  };

  let runner = null;
  let stopReason = null;
  // The run file is written once the preflight has passed, so a refusal
  // before anything is posted leaves no file behind to --resume.
  let begun = existing !== null;
  try {
    runner = await deps.start(deps.envFor(options));
    const base = runner.base;

    // Preflight: the cap in force, the CLI, and the tool's doctor.
    const doctorUntil = now() + doctorWaitMs;
    let announcedWait = false;
    for (;;) {
      if (stopped()) throw new Stop('stopped before the first brief');
      const health = await call(base, 'GET', '/api/health', undefined, { timeoutMs: 60_000 });
      if (health.status !== 200) throw new Error(`/api/health answered ${health.status}`);
      const capUsd = health.json?.dailyCap?.capUsd;
      if (typeof capUsd !== 'number' || Math.abs(capUsd - cap) > 1e-9) {
        throw new Error(`the runner reports a daily cap of ${capUsd ?? 'none'}, not the $${cap} it was started with; nothing was posted`);
      }
      if (health.json?.claude === false) throw new Error('the runner cannot find the claude CLI; nothing was posted');
      if (health.json?.dailyCap?.exceeded === true) {
        throw new Stop(`the scratch home has already spent $${Number(health.json.dailyCap.totalUsd ?? 0).toFixed(2)} of the $${cap} cap in the last 24 hours`);
      }
      const { ready, reason } = toolReadiness(health.json, tool);
      if (ready === true) break;
      if (ready === false) throw new Error(`${reason}; nothing was posted`);
      if (now() > doctorUntil) throw new Error(`the ${tool} doctor did not finish within ${Math.round(doctorWaitMs / 60_000)} minutes (${reason}); nothing was posted`);
      if (!announcedWait) log(`waiting for the ${tool} doctor's first check`);
      announcedWait = true;
      await waitOrStop(healthMs);
    }

    begun = true;
    save();
    log(`bench: ${work.length} brief${work.length === 1 ? '' : 's'} on ${tool}, model ${model ?? 'the runner default'}, cap $${cap.toFixed(2)} for this home's rolling day`);

    for (const { entry, plan } of work) {
      if (stopped()) throw new Stop('stopped');
      if (spent() >= cap) throw new Stop(`this run's recorded cost, $${spent().toFixed(2)}, has reached the $${cap.toFixed(2)} cap`);
      let previous = results.get(entry.id);
      const slug = runSlug(entry.id, label);
      let attempt = plan.attempt;
      let jobId = null;
      let view = null;
      const posted = now();

      if (plan.action === 'check') {
        const shown = await call(base, 'GET', `/api/jobs/${encodeURIComponent(previous.jobId)}`);
        const state = shown.status === 200 ? shown.json?.state : null;
        if (state === 'queued' || state === 'running' || state === 'awaiting_review' || state === 'accepted') {
          jobId = previous.jobId;
          log(`${entry.id}: picking up job ${jobId}, ${state}`);
        } else {
          // Stopped, cancelled, interrupted or gone: the next post is a new
          // attempt, and what the old one cost stays counted.
          if (typeof shown.json?.costUsd === 'number') previous = { ...previous, costUsd: shown.json.costUsd };
          attempt += 1;
        }
      }

      if (jobId === null) {
        // A new attempt carries what earlier attempts of this brief cost, so
        // the run's own sum never forgets money already spent.
        const newAttempt = previous !== undefined && attempt > (previous.tries ?? 0);
        const earlierCostUsd = (previous?.earlierCostUsd ?? 0) + (newAttempt ? (previous?.costUsd ?? 0) : 0);
        put({ ...emptyResult(entry.id), id: entry.id, slug, state: 'posting', tries: attempt, stopped: false, earlierCostUsd });
        let answer;
        try {
          answer = await call(base, 'POST', '/api/jobs', jobBody(entry, { label, tool, model, attempt }), { timeoutMs: 120_000 });
        } catch (error) {
          put({ ...results.get(entry.id), state: 'unanswered', error: `the post did not get an answer: ${error.message}` });
          throw new Stop(`${entry.id}: the runner did not answer the post`);
        }
        if (answer.status !== 200 && answer.status !== 201) {
          const reason = answer.json?.detail?.reason ?? null;
          const message = `${answer.status}${reason === null ? '' : ` ${reason}`}: ${answer.json?.error ?? answer.text ?? ''}`.trim();
          put({ ...results.get(entry.id), state: 'refused', error: message });
          if (answer.status === 429) throw new Stop(`${entry.id}: the runner refused it at the daily cap (${message})`);
          log(`${entry.id}: refused, ${message}`);
          if (options.keepGoing !== true) throw new Stop(`${entry.id} was refused; pass --keep-going to carry on past a refusal`);
          continue;
        }
        jobId = answer.json?.jobId;
        put({ ...results.get(entry.id), jobId, state: answer.json?.state ?? 'queued' });
        log(`${entry.id}: job ${jobId} ${answer.status === 201 ? 'queued' : 'was already queued under this key'}`);
      }

      // Follow the job to a settled state.
      const deadline = now() + jobTimeoutMs;
      let lastCost = null;
      while (view === null) {
        if (stopped()) {
          await call(base, 'POST', `/api/jobs/${encodeURIComponent(jobId)}/cancel`, {}).catch(() => null);
          put({ ...results.get(entry.id), stopped: true, state: 'stopped', costUsd: lastCost, error: 'the bench was stopped while this job ran' });
          throw new Stop('stopped');
        }
        const shown = await call(base, 'GET', `/api/jobs/${encodeURIComponent(jobId)}`);
        if (shown.status !== 200) {
          put({ ...results.get(entry.id), state: 'lost', error: `GET /api/jobs/${jobId} answered ${shown.status}` });
          throw new Stop(`${entry.id}: the runner no longer knows job ${jobId}`);
        }
        if (typeof shown.json?.costUsd === 'number') lastCost = shown.json.costUsd;
        if (SETTLED.includes(shown.json?.state)) {
          view = shown.json;
          break;
        }
        if (now() > deadline) {
          await call(base, 'POST', `/api/jobs/${encodeURIComponent(jobId)}/cancel`, {}).catch(() => null);
          put({ ...results.get(entry.id), state: 'timeout', costUsd: lastCost, error: `still ${shown.json?.state} after ${Math.round(jobTimeoutMs / 60_000)} minutes; cancelled` });
          throw new Stop(`${entry.id}: the job ran past the bench's limit`);
        }
        await waitOrStop(pollMs);
      }

      let state = view.state;
      let error = typeof view.error === 'string' && view.error !== '' ? view.error : null;
      let acceptFailed = false;
      if (state === 'awaiting_review') {
        const accepted = await call(base, 'POST', `/api/jobs/${encodeURIComponent(jobId)}/accept`, {}, { timeoutMs: 15 * 60_000 }).catch((failure) => ({ status: 0, json: { error: failure.message } }));
        if (accepted.status === 200) state = 'accepted';
        else {
          acceptFailed = true;
          error = `accept answered ${accepted.status}: ${accepted.json?.error ?? accepted.json?.note ?? ''}`.trim();
        }
      }
      const fields = recordFields(deps.readJob(jobId), Math.round((now() - posted) / 100) / 10);
      const result = {
        ...emptyResult(entry.id),
        earlierCostUsd: results.get(entry.id)?.earlierCostUsd ?? 0,
        slug,
        tries: attempt,
        stopped: false,
        jobId,
        state,
        ...fields,
        metrics: deps.metrics(jobId),
        error,
        errorKind: view.errorKind ?? null,
      };
      put(result);
      log(`${entry.id}: ${state}${result.costUsd === null ? '' : `, $${result.costUsd.toFixed(2)}`}${error === null ? '' : `, ${error}`}`);
      if (acceptFailed && options.keepGoing !== true) throw new Stop(`${entry.id}: the accept failed; pass --keep-going to carry on past it`);
      if (state === 'failed' && SYSTEMIC_ERRORS.includes(view.errorKind) && options.keepGoing !== true) {
        throw new Stop(`${entry.id} failed with error kind ${view.errorKind}, which says the machine is the problem; pass --keep-going to carry on`);
      }
    }
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    stopReason = error.message;
    log(`bench: stopping: ${stopReason}`);
  } finally {
    run.endedAt = new Date(now()).toISOString();
    if (stopReason !== null) run.stopReason = stopReason;
    try {
      if (begun) save();
    } finally {
      // Stopped even when the save throws (a full disk), so a detached
      // runner is never left running paid work; the save's error still
      // reaches the caller once the runner is down.
      if (runner !== null) {
        const clean = await runner.stop();
        if (clean === false) log(`bench: the runner's process group survived SIGKILL; check for leftover processes`);
      }
    }
  }
  return run;
}
