// What `--cap` means for one command, and how the runner's own spend cap is
// worked out from it.
//
// `--cap` is the most this one command (a run label, or one score pass) may
// spend. The studio runner knows only a rolling 24-hour cap over everything a
// home spent (`STUDIO_DAILY_USD`), and that cap is the one thing that stops a
// paid agent session, so it stays the hard backstop. The bench therefore asks
// the runner what the home has already spent in the last 24 hours, and starts
// the runner it works with at `already spent + this command's allowance`.
//
// The home's spend is read from a runner, not from files: the runner's total
// counts video jobs, each picture check, diagram jobs, planner turns and shot
// plans, over the same window the cap refuses on (`spendWindow` in
// services/studio/src/cost.ts), and a second reader of those files would agree
// with it only until it did not.

const MICRO = 1_000_000;

/** A dollar figure rounded to the six places the runner's own totals carry. */
export const round6 = (usd) => Math.round(usd * MICRO) / MICRO;

/** Dollars as the run's log lines write them. */
export const money = (usd) => `$${usd.toFixed(2)}`;

/**
 * A cap as `STUDIO_DAILY_USD` reads it: digits and an optional fraction, no
 * exponent and no trailing zeros, so 62.33 is "62.33" and 50 is "50".
 */
export function capEnvValue(usd) {
  return round6(usd).toFixed(6).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

/**
 * The cap numbers for one command. `cap` is what the person typed,
 * `homeSpentUsd` what the home had spent in its rolling day when the command
 * started, and `labelSpentUsd` what this run label had already spent (a resume),
 * which counts against `cap` so a resume is never handed a fresh one.
 * `allowanceUsd` is what the command may still spend; `runnerCapUsd` is the
 * runner's rolling-day cap, which is the home's spend plus that allowance.
 */
export function capPlan({ cap, homeSpentUsd, labelSpentUsd = 0 }) {
  const allowanceUsd = round6(cap - labelSpentUsd);
  const runnerCapUsd = Number(capEnvValue(homeSpentUsd + Math.max(0, allowanceUsd)));
  return { perCommandUsd: cap, labelSpentUsd: round6(labelSpentUsd), allowanceUsd, homeSpentUsd, runnerCapUsd };
}

/** What the plan records in a run file or a scoring record. */
export function capRecord(plan) {
  return { perCommandUsd: plan.perCommandUsd, labelSpentUsd: plan.labelSpentUsd, homeSpentUsd: plan.homeSpentUsd, runnerCapUsd: plan.runnerCapUsd };
}

/** The one plain line printed at the start of a command. `what` is "run" or "scoring"; `label` names the run label. */
export function capLine(plan, what, label) {
  const spent = `Home has spent ${money(plan.homeSpentUsd)} in the last 24 hours`;
  const room = plan.labelSpentUsd > 0
    ? `this ${what} may spend up to ${money(plan.allowanceUsd)} more (its ${money(plan.perCommandUsd)} cap less the ${money(plan.labelSpentUsd)} that ${label} already spent)`
    : `this ${what} may spend up to ${money(plan.allowanceUsd)} more`;
  return `${spent}; ${room} (runner cap ${money(plan.runnerCapUsd)}).`;
}

/**
 * What the home has spent in the runner's rolling day right now, asked of a
 * runner started just for the answer: nothing is posted to it, and it is
 * stopped before this resolves. `deps` is `{ start, envFor, call }` as the
 * loops take them; the runner is started at the typed cap, which is no more
 * than the command may spend anyway. Throws, with nothing posted, when the
 * runner gives no usable figure: a command that cannot tell what the home has
 * spent must not guess.
 */
export async function measureHomeSpend(deps, options) {
  const runner = await deps.start(deps.envFor({ ...options, runnerCapUsd: options.cap }));
  let total;
  try {
    const health = await deps.call(runner.base, 'GET', '/api/health', undefined, { timeoutMs: 60_000 });
    if (health.status !== 200) throw new Error(`/api/health answered ${health.status}; nothing was posted`);
    total = health.json?.dailyCap?.totalUsd;
  } finally {
    const stopped = await runner.stop();
    if (stopped?.clean === false) {
      deps.log?.(`bench: process groups ${stopped.survivors.join(', ')} survived SIGKILL; check them with ps -g and stop them by hand`);
    }
  }
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) {
    throw new Error('the runner did not say what the home has spent in the last 24 hours, so no cap can be worked out; nothing was posted');
  }
  return total;
}
