// `bench:video run`: the loop. One brief at a time through a runner the bench
// started over its scratch home, every step written to the run file as it
// happens, so a crash or a Ctrl-C leaves a record of what was spent.
//
// The order of guards before money moves: the run file and label are checked,
// the port must be free (so the runner answering is the bench's own), what the
// home has already spent in the runner's rolling day is read (budget.mjs), the
// runner is started at that spend plus this run's allowance and must report
// the cap it was given and the claude CLI, and the tool's own doctor must
// pass. Only then is the first brief posted. During the run the runner's
// STUDIO_DAILY_USD refuses an enqueue at its cap (429), and the bench also
// stops before posting once this label's own recorded costs reach `--cap`.
import { existsSync, readFileSync } from 'node:fs';

import { jobBody, runSlug } from './briefs.mjs';
import { capLine, capPlan, capRecord, measureHomeSpend, money } from './budget.mjs';
import { costOf } from './cost.mjs';
import { criticCurrent, criticFromStandalone, criticFromView, criticRefused, verdictLine } from './critic.mjs';
import { criticCostOf, recordFields } from './metrics.mjs';
import { writeJsonAtomic } from './home.mjs';
import { plannedBody, shotsKept, shotsRecord } from './shots.mjs';

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
    shots: null,
    critic: null,
    criticCostUsd: null,
    checkCostUsd: null,
    error: null,
  };
}

/** A refusal as one line: the status, the runner's reason code when it gave one, and its message. */
export function refusalMessage(answer) {
  const reason = answer.json?.detail?.reason ?? null;
  return `${answer.status}${reason === null ? '' : ` ${reason}`}: ${answer.json?.error ?? answer.text ?? ''}`.trim();
}

/**
 * One standalone picture check of a finished job, `POST /api/jobs/{id}/critic`.
 * Resolves `{ critic, status, stop }`: the record to keep, the answer's
 * status (0 when none came), and why a caller should stop, or null. A 429
 * (the cap) or no answer always stops; a 503 means the runner cannot run
 * the critic at all; a 409 (no kept sheet) is recorded and the caller goes on.
 */
export async function standaloneCritic(call, base, jobId, jobView) {
  let answer;
  try {
    answer = await call(base, 'POST', `/api/jobs/${encodeURIComponent(jobId)}/critic`, {}, { timeoutMs: 20 * 60_000 });
  } catch (error) {
    return { critic: criticRefused(`the critic request did not get an answer: ${error.message}`, jobView), status: 0, stop: 'the runner did not answer the critic request' };
  }
  if (answer.status === 200) return { critic: criticFromStandalone(answer.json?.critic, jobView), status: 200, stop: null };
  const message = refusalMessage(answer);
  const critic = criticRefused(`the critic was refused, ${message}`, jobView);
  if (answer.status === 429) return { critic, status: 429, stop: `the runner refused the critic at the daily cap (${message})` };
  if (answer.status === 503) return { critic, status: 503, stop: `the runner cannot run the critic (${message})` };
  return { critic, status: answer.status, stop: null };
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

/** A clean stop: what finished is written down, the runner is stopped, and the verb exits 1. */
export class Stop extends Error {}

export { costOf };

/**
 * The spend guards every verb checks on `/api/health` before money moves:
 * the runner reports the cap it was started with, `runnerCap` (the home's
 * spend plus this command's allowance, see budget.mjs) and finds the claude
 * CLI (an Error, nothing was posted), and the home's rolling day is under
 * that cap (a Stop). Neither looks at a tool's doctor.
 */
export function checkSpendGuards(health, runnerCap) {
  if (health.status !== 200) throw new Error(`/api/health answered ${health.status}`);
  const capUsd = health.json?.dailyCap?.capUsd;
  if (typeof capUsd !== 'number' || Math.abs(capUsd - runnerCap) > 1e-9) {
    throw new Error(`the runner reports a daily cap of ${capUsd ?? 'none'}, not the $${runnerCap} it was started with; nothing was posted`);
  }
  if (health.json?.claude === false) throw new Error('the runner cannot find the claude CLI; nothing was posted');
  if (health.json?.dailyCap?.exceeded === true) {
    throw new Stop(`the scratch home has already spent ${money(Number(health.json.dailyCap.totalUsd ?? 0))} of the ${money(runnerCap)} runner cap in the last 24 hours`);
  }
}

/**
 * Run the selected briefs. `options`: `{ home, label, tool, model, cap, port,
 * keepGoing, resume, shots, critic, entries, runFile, env }`, where `shots`
 * asks the art director for each brief's shot plan before it is posted and
 * `critic` asks for a standalone picture check of a landed video whose job
 * has no read of its build in review. `deps`: `start(env)` resolves
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
  const askShots = options.shots === true;
  const askCritic = options.critic === true;
  if (existing !== null && (existing.shotsAsked === true) !== askShots) {
    throw new Error(`${runFile} was run ${existing.shotsAsked === true ? 'with' : 'without'} --shots; a resume must ask for shots the same way`);
  }
  const results = new Map((existing?.results ?? []).map((result) => [result.id, result]));
  const run = {
    label,
    tool,
    model,
    capUsd: cap,
    capPlan: null,
    shotsAsked: askShots,
    criticAsked: askCritic,
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
    // What this label already spent counts against its cap, so a resume is
    // never handed a fresh one; nothing is started when none is left.
    const labelSpentUsd = spent();
    if (labelSpentUsd >= cap) {
      throw new Stop(`${label} has already spent ${money(labelSpentUsd)}, which reaches the ${money(cap)} cap; pass a larger --cap to carry on`);
    }
    // What the home has spent in the runner's rolling day, asked of a runner
    // that is stopped again before the one the run uses is started.
    const homeSpentUsd = await measureHomeSpend(deps, options);
    if (stopped()) throw new Stop('stopped before the first brief');
    const plan = capPlan({ cap, homeSpentUsd, labelSpentUsd });
    run.capPlan = capRecord(plan);
    log(capLine(plan, 'run', label));

    runner = await deps.start(deps.envFor({ ...options, runnerCapUsd: plan.runnerCapUsd }));
    const base = runner.base;

    // Preflight: the cap in force, the CLI, and the tool's doctor.
    const doctorUntil = now() + doctorWaitMs;
    let announcedWait = false;
    for (;;) {
      if (stopped()) throw new Stop('stopped before the first brief');
      const health = await call(base, 'GET', '/api/health', undefined, { timeoutMs: 60_000 });
      checkSpendGuards(health, plan.runnerCapUsd);
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
    log(`bench: ${work.length} brief${work.length === 1 ? '' : 's'} on ${tool}, model ${model ?? 'the runner default'}`);
    if (askShots || askCritic) {
      const asked = [askShots ? "the art director plans each brief's shots first" : null, askCritic ? 'a job with no critic of its build in review gets a standalone check' : null];
      log(`bench: ${asked.filter((line) => line !== null).join('; ')}`);
    }

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
          // Its picture checks were paid apart from the job's own cost.
          const checked = criticCostOf(deps.readJob(previous.jobId)?.job);
          if (checked !== null) previous = { ...previous, criticCostUsd: checked };
          // Saved before any cap check below, so spent() counts what the old
          // attempt really cost; `fresh` then carries the same sum in
          // `earlierCostUsd`, so the total is the same before and after it.
          put(previous);
          attempt += 1;
        }
      }

      if (jobId === null) {
        // A new attempt carries what earlier attempts of this brief cost, so
        // the run's own sum never forgets money already spent.
        const newAttempt = previous !== undefined && attempt > (previous.tries ?? 0);
        const earlierCostUsd = (previous?.earlierCostUsd ?? 0) + (newAttempt ? (previous?.costUsd ?? 0) + (previous?.criticCostUsd ?? 0) : 0);
        const body = jobBody(entry, { label, tool, model, attempt });
        // A plan already recorded stands: a resume never pays for a second one.
        let shots = askShots ? (previous?.shots ?? null) : null;
        // A standalone check already paid for stays counted too (a check only
        // runs on a landed video, which a resume skips, so this is a guard).
        const fresh = { ...emptyResult(entry.id), id: entry.id, slug, tries: attempt, stopped: false, earlierCostUsd, checkCostUsd: previous?.checkCostUsd ?? null };
        // Every paid call is preceded, after the last await before it, by a
        // stop check and a cap check. A record whose post may already have
        // reached the runner is left as it is, so a resume reposts it under
        // the same idempotency key rather than queueing a second job.
        const hold = (why, reason) => {
          const now = results.get(entry.id);
          if (!(now?.state === 'posting' || now?.state === 'unanswered') || now.tries !== attempt) {
            put({ ...fresh, state: 'not-posted', shots, error: `not posted: ${why}` });
          }
          throw new Stop(reason);
        };
        const capReason = () => `this run's recorded cost, $${spent().toFixed(2)}, has reached the $${cap.toFixed(2)} cap`;
        if (askShots && !shotsKept(shots)) {
          if (stopped()) hold('the bench was stopped before its shot plan was asked for', 'stopped');
          if (spent() >= cap) hold('the run reached its cap before its shot plan', capReason());
          put({ ...fresh, state: 'planning', shots: null });
          let planned;
          try {
            planned = await call(base, 'POST', '/api/video/shots', { brief: body }, { timeoutMs: 30 * 60_000 });
          } catch (error) {
            put({ ...results.get(entry.id), state: 'unanswered', error: `the shot plan request did not get an answer: ${error.message}` });
            throw new Stop(`${entry.id}: the runner did not answer the shot plan request`);
          }
          if (planned.status !== 200) {
            const message = refusalMessage(planned);
            const refused = { state: 'refused', costUsd: null, reason: message, types: null, brief: null };
            put({ ...results.get(entry.id), state: 'refused', shots: refused, error: `the shot plan was refused, ${message}` });
            if (planned.status === 429) throw new Stop(`${entry.id}: the runner refused its shot plan at the daily cap (${message})`);
            log(`${entry.id}: shot plan refused, ${message}`);
            if (options.keepGoing !== true) throw new Stop(`${entry.id}'s shot plan was refused; pass --keep-going to carry on past a refusal`);
            continue;
          }
          shots = shotsRecord(planned.json);
          put({ ...results.get(entry.id), shots });
          const cost = shots.costUsd === null ? '' : `, $${shots.costUsd.toFixed(2)}`;
          log(`${entry.id}: shots ${shots.state}${cost}${shots.types === null ? '' : `, ${shots.types.join(' ')}`}${shots.reason === null ? '' : `, ${shots.reason}`}`);
          if (shots.state === 'off' && options.keepGoing !== true) {
            put({ ...results.get(entry.id), state: 'not-posted', error: `the run asked for shots and the runner cannot plan them: ${shots.reason ?? 'the art director is off'}` });
            throw new Stop(`${entry.id}: the runner's art director is off; pass --keep-going to post the briefs without shots`);
          }
        }
        // A stop that arrived while the plan was being made (or while a
        // resume asked about an old job) is honoured before any paid video
        // work is queued. A plan is already in the run file, so a resume posts
        // it without paying for it again; the cap counts the plan just paid for.
        if (stopped()) hold('the bench was stopped before the job was queued', 'stopped');
        if (spent() >= cap) hold(shots?.costUsd > 0 ? 'the run reached its cap with this shot plan' : 'the run reached its cap before the job was queued', capReason());
        put({ ...fresh, state: 'posting', shots });
        let answer;
        try {
          answer = await call(base, 'POST', '/api/jobs', plannedBody(body, shots), { timeoutMs: 120_000 });
        } catch (error) {
          put({ ...results.get(entry.id), state: 'unanswered', error: `the post did not get an answer: ${error.message}` });
          throw new Stop(`${entry.id}: the runner did not answer the post`);
        }
        if (answer.status !== 200 && answer.status !== 201) {
          const message = refusalMessage(answer);
          put({ ...results.get(entry.id), state: 'refused', error: message });
          if (answer.status === 429) throw new Stop(`${entry.id}: the runner refused it at the daily cap (${message})`);
          log(`${entry.id}: refused, ${message}`);
          if (options.keepGoing !== true) throw new Stop(`${entry.id} was refused; pass --keep-going to carry on past a refusal`);
          continue;
        }
        jobId = answer.json?.jobId;
        put({ ...results.get(entry.id), jobId, state: answer.json?.state ?? 'queued' });
        deps.onJob?.(jobId);
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
      // The picture check of a landed video: the job's own, read from its
      // view, or with --critic a standalone one when the job has no read of
      // the build in review. Never a standalone check of a job that has one.
      let critic = null;
      let criticStop = null;
      // What the job just cost, and what the runner's own checks of it cost,
      // go into the run file before any decision about another paid call, so
      // the cap below counts them.
      const settledCost = recordFields(deps.readJob(jobId));
      put({
        ...results.get(entry.id),
        costUsd: settledCost.costUsd ?? (typeof view.costUsd === 'number' ? view.costUsd : null),
        criticCostUsd: settledCost.criticCostUsd,
      });
      if (state === 'accepted') {
        const after = await call(base, 'GET', `/api/jobs/${encodeURIComponent(jobId)}`).catch(() => null);
        const jobView = after?.status === 200 ? after.json : view;
        critic = criticFromView(jobView?.critic ?? null);
        if (!criticCurrent(critic) && askCritic) {
          // Checked after the GET above, the last await before the paid call.
          // A stop keeps the landed video's record as it is (accepted, its
          // costs, its job's own critic) and ends the run; `score` checks it later.
          if (stopped()) {
            log(`${entry.id}: no standalone critic, the bench was stopped`);
            criticStop = 'stopped';
          } else if (spent() >= cap) log(`${entry.id}: no standalone critic, the run's recorded cost has reached the cap`);
          else {
            const checked = await standaloneCritic(call, base, jobId, jobView);
            critic = checked.critic;
            log(`${entry.id}: standalone critic ${verdictLine(critic)}`);
            if (checked.stop !== null && (checked.status !== 503 || options.keepGoing !== true)) {
              criticStop = `${entry.id}: ${checked.stop}${checked.status === 503 ? '; pass --keep-going to carry on without it' : ''}`;
            }
          }
        }
      }
      const fields = recordFields(deps.readJob(jobId), Math.round((now() - posted) / 100) / 10);
      // This run's standalone check, added to any the record already carried.
      const priorCheck = results.get(entry.id)?.checkCostUsd;
      const thisCheck = critic?.source === 'standalone' && typeof critic.costUsd === 'number' ? critic.costUsd : null;
      const checkCostUsd = thisCheck === null && typeof priorCheck !== 'number' ? null : (typeof priorCheck === 'number' ? priorCheck : 0) + (thisCheck ?? 0);
      // Look metrics only for a video that landed: a failed job's kept source
      // can be the untouched scene stub, which scans as a busy picture.
      const metrics = state === 'accepted' ? deps.metrics(jobId) : null;
      const result = {
        ...emptyResult(entry.id),
        earlierCostUsd: results.get(entry.id)?.earlierCostUsd ?? 0,
        slug,
        tries: attempt,
        stopped: false,
        jobId,
        state,
        ...fields,
        metrics,
        shots: results.get(entry.id)?.shots ?? null,
        critic,
        checkCostUsd,
        error,
        errorKind: view.errorKind ?? null,
      };
      put(result);
      log(`${entry.id}: ${state}${result.costUsd === null ? '' : `, $${result.costUsd.toFixed(2)}`}${error === null ? '' : `, ${error}`}`);
      if (acceptFailed && options.keepGoing !== true) throw new Stop(`${entry.id}: the accept failed; pass --keep-going to carry on past it`);
      if (criticStop !== null) throw new Stop(criticStop);
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
        const stopped = await runner.stop();
        if (stopped?.clean === false) {
          log(`bench: process groups ${stopped.survivors.join(', ')} survived SIGKILL; check them with ps -g and stop them by hand`);
        } else if (stopped?.clean === true) {
          log('bench: the runner and every process group it started are stopped');
        }
      }
    }
  }
  return run;
}
