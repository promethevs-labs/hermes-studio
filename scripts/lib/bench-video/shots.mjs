// `run --shots`: the art director's shot plan for each brief, asked of the
// runner's `POST /api/video/shots` (docs/STUDIO-VIDEOS.md, "The shot plan")
// with the brief exactly as it will be posted. The stored briefs carry no
// shots on purpose, so each run plans them afresh. What the route answered is
// kept on the result as `shots`, the planned brief with it, so a resume posts
// the same plan rather than paying for a second one.

/** Shot plan states a resume reuses rather than asking again: a plan, or a recorded failure, which was paid for. */
export const KEPT_SHOTS = Object.freeze(['planned', 'reused', 'failed']);

/** Whether a recorded `shots` can stand for this attempt without another call. */
export function shotsKept(shots) {
  if (shots === null || typeof shots !== 'object' || !KEPT_SHOTS.includes(shots.state)) return false;
  return shots.state === 'failed' || (typeof shots.brief === 'object' && shots.brief !== null && Array.isArray(shots.brief.scenes));
}

/** Each scene's shot type, in scene order, or null when the brief carries no shot plan. */
export function shotTypes(brief) {
  const scenes = Array.isArray(brief?.scenes) ? brief.scenes : [];
  if (scenes.length === 0 || !scenes.every((scene) => typeof scene?.shot?.type === 'string')) return null;
  return scenes.map((scene) => scene.shot.type);
}

/** How many distinct shot types a recorded plan uses, or null when none was planned. */
export function distinctShotTypes(shots) {
  if (shots === null || typeof shots !== 'object' || !['planned', 'reused'].includes(shots.state) || !Array.isArray(shots.types)) return null;
  const types = shots.types.filter((type) => typeof type === 'string');
  return types.length === 0 ? null : new Set(types).size;
}

/**
 * The `shots` a route answer records: `{ state, costUsd, reason, types,
 * brief }`, where `brief` is the planned brief for `planned` and `reused`
 * and null otherwise. An answer the bench cannot read records as `failed`.
 */
export function shotsRecord(answer) {
  const state = ['planned', 'reused', 'failed', 'off'].includes(answer?.shotPlan) ? answer.shotPlan : 'failed';
  const costUsd = typeof answer?.costUsd === 'number' && Number.isFinite(answer.costUsd) ? answer.costUsd : null;
  const reason = typeof answer?.reason === 'string' && answer.reason !== '' ? answer.reason : null;
  if (state === 'planned' || state === 'reused') {
    const types = shotTypes(answer?.brief);
    if (types === null) return { state: 'failed', costUsd, reason: `the route said ${state}, but its brief carries no whole shot plan`, types: null, brief: null };
    return { state, costUsd, reason, types, brief: answer.brief };
  }
  return { state, costUsd, reason: reason ?? (answer?.shotPlan === state ? null : 'the route gave no shot plan state'), types: null, brief: null };
}

/**
 * The body the job is posted with: the planned brief under the run's own
 * `kind`, slug, tool, model and idempotency key, which an earlier attempt's
 * plan may carry differently. With no plan to post, `body` itself.
 */
export function plannedBody(body, shots) {
  if (shots === null || typeof shots !== 'object' || !['planned', 'reused'].includes(shots.state) || shots.brief === null || typeof shots.brief !== 'object') return body;
  const planned = { ...shots.brief };
  delete planned.kind;
  delete planned.model;
  delete planned.idempotencyKey;
  return {
    kind: body.kind,
    ...planned,
    slug: body.slug,
    tool: body.tool,
    ...(body.model === undefined ? {} : { model: body.model }),
    idempotencyKey: body.idempotencyKey,
  };
}
