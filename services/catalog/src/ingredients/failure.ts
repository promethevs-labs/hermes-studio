/**
 * Why a failed job failed, for the evaluation report.
 *
 * A failure is either about the work or about the run. A `quality` failure
 * means the agent ran and what it made was refused, or it could not make it by
 * its own doing. An `infrastructure` failure means the job never got a fair
 * run: a login that expired, a runner that threw, a tool that would not start,
 * a person's cancel. The accept rate counts the first kind and leaves the
 * second out, because an expired login says nothing about the agent.
 *
 * The kinds are the `error_kind` strings the studio's runners write
 * (`services/studio/src/diagram/runner.ts` and `video/runner.ts`). The column
 * is free text, so a kind this table has never heard of, or a failed job with
 * no kind at all, is infrastructure and is listed by name in the report until
 * somebody classifies it.
 */

export type FailureCause = "quality" | "infrastructure";

/** What the classifier reads from a failed job's row. Every field may be missing. */
export interface FailureEvidence {
  errorKind?: string | null;
  turns?: number | null;
  costUsd?: number | null;
  /** How many of the job's attempts reached the gate (`job.run.attempts[].gate`). */
  gatedAttempts?: number | null;
}

export interface FailureClass {
  /** The `error_kind` as stored, or `(none)` when the row has none. */
  kind: string;
  cause: FailureCause;
  /** False for a kind the table does not list, and for a missing one. */
  classified: boolean;
}

/** The kind shown for a failed job whose `error_kind` is null or empty. */
export const NO_ERROR_KIND = "(none)";

interface KindRule {
  cause: FailureCause;
  /** One line: how the runner assigns the kind, and so why it lands where it does. */
  reason: string;
}

/**
 * Every kind the runners assign to a job that ends `failed`, plus the ones they
 * give to cancelled and interrupted jobs, in case a row ever carries one.
 * `agent` is not here: it needs the job's own numbers (`classifyFailure`).
 */
export const FAILURE_KINDS: Readonly<Record<string, KindRule>> = {
  // The agent ran up to three attempts and the gate still refused the result,
  // or it left nothing the gate could read. The work is what failed.
  gate: { cause: "quality", reason: "the agent ran and the gate refused its work, or it produced nothing to judge" },
  // The agent wrote files outside its own workspace, which its permissions were
  // meant to stop. That is the agent's doing, and the work is refused for it.
  "wrote-outside": { cause: "quality", reason: "the agent left files dirty outside its workspace, and the work is refused for it" },
  // The runner killed a session that said nothing for minutes, or ran past the
  // job's ceiling. A hung browser or a slow machine looks the same as a slow
  // agent, so the time out is not a verdict on the work.
  timeout: { cause: "infrastructure", reason: "the runner stopped a hung session or a job past its ceiling, so there is no verdict on the work" },
  // The agent binary would not start, so nothing ran.
  spawn: { cause: "infrastructure", reason: "the agent process never started" },
  // The tool's wrapper could not start (dead tools, V26), so no attempt could succeed.
  toolchain: { cause: "infrastructure", reason: "the video tool's own commands cannot run on this machine" },
  // The runner threw, which is a bug in the runner and not in the work.
  internal: { cause: "infrastructure", reason: "the runner itself threw" },
  // The runner died while the job ran.
  interrupted: { cause: "infrastructure", reason: "the runner died mid-job" },
  // A person pressed cancel (or a timer did, as `timeout`).
  cancelled: { cause: "infrastructure", reason: "stopped on request before it could be judged" },
  // Another runner held the row, so no agent was ever started.
  "not-claimed": { cause: "infrastructure", reason: "another runner held the job, so no agent started" },
};

/** The kinds the classifier knows by name: the table, and `agent`. */
export const CLASSIFIED_KINDS: readonly string[] = [...Object.keys(FAILURE_KINDS), "agent"];

/** The most turns a job whose first request was refused can report, as the runners read it. */
export const REFUSED_REQUEST_TURNS = 1;

function none(x: number | null | undefined): boolean {
  return x === null || x === undefined || x <= 0;
}

/**
 * Classifies one failed job.
 *
 * `agent` is the one kind that can be either. Both runners assign it only when
 * the agent's first request failed (a refused login, a model the account
 * cannot use, an exhausted quota) and the workspace was unchanged, so it
 * usually means the job never ran. But the check looks at the last attempt
 * alone: a job whose first attempt did real work and failed the gate, and whose
 * second attempt then met a refused login, also ends as `agent`. The row tells
 * the two apart without reading the error text: the job did no work when it has
 * at most one turn, no cost, and no attempt that reached the gate. One turn is
 * not work: a refused first request can report `turns: 1`, which is why both
 * runners' own check is `(outcome.turns ?? 0) <= 1` (`REFUSED_REQUEST_TURNS`
 * here). A second turn, any cost or a gated attempt is the sign of an agent
 * that ran, and the job counts as quality.
 */
export function classifyFailure(evidence: FailureEvidence): FailureClass {
  const raw = evidence.errorKind;
  const kind = raw === null || raw === undefined || raw.trim() === "" ? NO_ERROR_KIND : raw;
  if (kind === "agent") {
    const neverRan =
      (evidence.turns ?? 0) <= REFUSED_REQUEST_TURNS && none(evidence.costUsd) && none(evidence.gatedAttempts);
    return { kind, cause: neverRan ? "infrastructure" : "quality", classified: true };
  }
  const rule = Object.hasOwn(FAILURE_KINDS, kind) ? FAILURE_KINDS[kind] : undefined;
  if (rule === undefined) return { kind, cause: "infrastructure", classified: false };
  return { kind, cause: rule.cause, classified: true };
}

/** One kind and cause with how many failed jobs had it. */
export interface FailureCount {
  kind: string;
  cause: FailureCause;
  count: number;
  /** False for an unknown or missing kind, which counts as infrastructure. */
  classified: boolean;
}

/** Classifies and counts failed jobs: most common first, then by kind, then cause. */
export function countFailures(jobs: readonly FailureEvidence[]): FailureCount[] {
  const counts = new Map<string, FailureCount>();
  for (const evidence of jobs) {
    const c = classifyFailure(evidence);
    const key = `${c.kind}\u0000${c.cause}`;
    const held = counts.get(key);
    if (held === undefined) counts.set(key, { kind: c.kind, cause: c.cause, count: 1, classified: c.classified });
    else held.count += 1;
  }
  return [...counts.values()].sort((a, b) =>
    b.count !== a.count ? b.count - a.count : a.kind !== b.kind ? (a.kind < b.kind ? -1 : 1) : a.cause < b.cause ? -1 : a.cause > b.cause ? 1 : 0,
  );
}
