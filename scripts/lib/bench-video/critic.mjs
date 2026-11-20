// The picture check's scores on a bench result. After a job is accepted the
// bench reads `critic` from `GET /api/jobs/{id}` (`criticView` in
// services/studio/src/video/critic.ts); when that names no read of the build
// in review and the run asked for one, it calls the standalone
// `POST /api/jobs/{id}/critic`. Either way the result carries
// `critic: { source, attempt, current, scores, mean, defects, notes,
// sentBack, passed, error }`. `passed` is D116 of docs/STUDIO-LOOK.md: the
// critic's read of the last attempt names no defect; the scores never block.
// It is null when the build in review was not scored.

const list = (value) => (Array.isArray(value) ? value.map((item) => (item !== null && typeof item === 'object' ? { ...item } : item)) : []);

/** A whole set of scores, each a finite number, or null. */
function scoresOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value).filter(([, score]) => typeof score === 'number' && Number.isFinite(score));
  return entries.length === 0 ? null : Object.fromEntries(entries);
}

/** The mean of a set of scores, or null. */
export function scoresMean(scores) {
  const values = Object.values(scores ?? {}).filter((score) => typeof score === 'number' && Number.isFinite(score));
  return values.length === 0 ? null : values.reduce((sum, score) => sum + score, 0) / values.length;
}

/**
 * The record for a job's own critic, from its view (`GET /api/jobs/{id}`'s
 * `critic`). A job no critic scored records with no scores and says so.
 */
export function criticFromView(view, source = 'job') {
  if (view === null || typeof view !== 'object') {
    return { source, attempt: null, current: false, scores: null, mean: null, defects: [], notes: [], sentBack: [], passed: null, error: 'no critic scored this job' };
  }
  const scores = scoresOf(view.scores);
  const current = view.current === true && scores !== null;
  const defects = list(view.defects);
  return {
    source,
    attempt: typeof view.attempt === 'number' ? view.attempt : null,
    current,
    scores,
    mean: scoresMean(scores),
    defects,
    notes: list(view.notes),
    sentBack: list(view.sentBack),
    passed: current ? defects.length === 0 : null,
    error: current ? null : typeof view.unscoredReason === 'string' && view.unscoredReason !== '' ? view.unscoredReason : 'the build in review was not scored',
  };
}

/**
 * The record for a standalone check, from the route's `critic` (`criticRunView`).
 * A standalone run always reads the build in review, so its scores are
 * current; one that gave no usable answer has none. `attempt` and
 * `sentBack` come from the job's view, which the standalone answer lacks.
 */
export function criticFromStandalone(run, jobView = null) {
  const scores = scoresOf(run?.scores);
  const defects = list(run?.defects);
  const build = typeof jobView?.critic?.build === 'number' ? jobView.critic.build : typeof jobView?.attempt === 'number' ? jobView.attempt : null;
  return {
    source: 'standalone',
    attempt: build,
    current: scores !== null,
    scores,
    mean: scoresMean(scores),
    defects,
    notes: list(run?.notes),
    sentBack: list(jobView?.critic?.sentBack),
    passed: scores === null ? null : defects.length === 0,
    error: scores === null ? (typeof run?.error === 'string' && run.error !== '' ? run.error : 'the critic gave no scores') : null,
    costUsd: typeof run?.costUsd === 'number' ? run.costUsd : null,
  };
}

/** The record for a standalone check the runner refused or never answered. */
export function criticRefused(message, jobView = null) {
  return { ...criticFromStandalone(null, jobView), error: message };
}

/** A recorded critic in a few words, for the log. */
export function verdictLine(critic) {
  if (critic?.passed === true) return `passed, mean ${critic.mean.toFixed(2)}`;
  if (critic?.passed === false) return `failed, ${critic.defects.length} defect${critic.defects.length === 1 ? '' : 's'}, mean ${critic.mean.toFixed(2)}`;
  return `gave no verdict: ${critic?.error ?? 'no critic'}`;
}

/** Whether a recorded critic is a read of the build in review. */
export function criticCurrent(critic) {
  return critic !== null && typeof critic === 'object' && critic.current === true;
}
