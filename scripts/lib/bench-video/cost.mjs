// What a bench result cost. A resumed brief keeps what its earlier attempts
// cost in `earlierCostUsd` beside its last job's `costUsd`, and every place
// that adds up spending reads both through here.

/** What a result has cost so far: its job's cost and every earlier attempt's. */
export function costOf(result) {
  return (typeof result?.costUsd === 'number' ? result.costUsd : 0) + (typeof result?.earlierCostUsd === 'number' ? result.earlierCostUsd : 0);
}

/** The same, or null when neither figure is known, so an unpriced result is not shown as free. */
export function knownCostOf(result) {
  return typeof result?.costUsd === 'number' || typeof result?.earlierCostUsd === 'number' ? costOf(result) : null;
}
