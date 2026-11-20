// What a bench result cost. A resumed brief keeps what its earlier attempts
// cost in `earlierCostUsd` beside its last job's `costUsd`. The art
// director's shot plan (`shots.costUsd`) and the runner's own picture checks
// of each attempt (`criticCostUsd`) are spent apart from the job's own
// `cost_usd`, so they are carried beside it. A standalone check the bench
// asked for (`checkCostUsd`) is measuring, not making: it counts toward the
// cap, and is left out of the cost `compare` sets side by side. Every place
// that adds up spending reads these through here.

const known = (value) => typeof value === 'number' && Number.isFinite(value);

/** What making the video cost: its job, every earlier attempt, its shot plan and the runner's picture checks. */
function making(result) {
  return [result?.costUsd, result?.earlierCostUsd, result?.shots?.costUsd, result?.criticCostUsd];
}

const total = (values) => values.reduce((sum, value) => sum + (known(value) ? value : 0), 0);

/** Everything a result has spent so far, a standalone check included: what the cap counts. */
export function costOf(result) {
  return total([...making(result), result?.checkCostUsd]);
}

/** What making the video cost, or null when no figure is known, so an unpriced result is not shown as free. */
export function knownCostOf(result) {
  const parts = making(result);
  return parts.some(known) ? total(parts) : null;
}
