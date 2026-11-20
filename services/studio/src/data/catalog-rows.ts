import type { JobState } from "@hermes/schema";

import { jobClaim, jobDiscard, jobFinish, jobListActive, jobShow, sessionEnd, type JobFinishInput } from "./catalog";
import type { RecordStore, StoredRecord } from "./store";

/**
 * Bringing the catalog's job rows back in step with the runner's own records.
 *
 * `job.json` is written first and the catalog second (rule 7), so a process
 * that stops between the two leaves a record that is finished and a row that
 * is not: the record says `cancelled` and the row still says `running`. The
 * row is the lease on its committed path (`JOB_ACTIVE_STATES`), so every later
 * job for that path was refused with a 409 until someone ran `catalog job
 * finish` by hand. That happened on 2026-11-20, when the app was restarted
 * while a video job ran.
 *
 * The record is the truth here, because it is the runner's own last word
 * about a job it ran. So a live row whose record has moved on is moved the
 * same way, with the same `job finish` the live path sends (its run record,
 * gate and review included), and a row no record of this runner names is
 * reported and never touched: nothing in this process can prove whose it is.
 */

/** The least time between two reconciles `/api/health` starts while one is owed. */
const RETRY_MS = 60_000;

/** The fields of a `job ls` or `job show` row the reconcile reads. */
export interface LiveRow {
  id: string;
  state: JobState;
  targetPath: string;
  runner: string | null;
}

/** What a record carries beyond the store's own fields, which every job kind has. */
export interface RowRecord extends StoredRecord {
  errorKind: string | null;
  sessionId: string | null;
}

/** One catalog write that moves a row one edge of `JOB_TRANSITIONS`. */
export type RowStep = { op: "claim" } | { op: "finish"; state: JobState } | { op: "discard" };

export type RowPlan =
  /** The row already says what the record says, or the job is still the runner's to finish. */
  | { kind: "in-step" }
  /** Writes that bring the row to the record's state; `note` when they stop short of it. */
  | { kind: "repair"; steps: RowStep[]; note?: string }
  /** Nothing this runner may write: the reason, for the report. */
  | { kind: "leave"; reason: string };

/** The states a runner finishes a running job in, with `job finish`. */
const RUNNER_ENDS: ReadonlySet<JobState> = new Set<JobState>(["awaiting_review", "failed", "cancelled", "interrupted"]);
/** The states a record holds while its job is still the runner's to finish. */
const LIVE: ReadonlySet<JobState> = new Set<JobState>(["queued", "running"]);

/**
 * The catalog writes from `from` to `to`, or null when there is no honest
 * path. A queued row is claimed first only for a job that did start (`ran`):
 * its claim was the write that was missed. `accepted` is never written here,
 * since it needs the outputs Accept lands; the path stops at review.
 */
export function stepsBetween(from: JobState, to: JobState, ran: boolean): RowStep[] | null {
  if (from === to) return [];
  if (from === "queued") {
    if (to === "cancelled") return [{ op: "finish", state: "cancelled" }];
    if (!ran) return null;
    const rest = stepsBetween("running", to, ran);
    return rest === null ? null : [{ op: "claim" }, ...rest];
  }
  if (from === "running") {
    if (RUNNER_ENDS.has(to)) return [{ op: "finish", state: to }];
    if (to === "discarded") return [{ op: "finish", state: "awaiting_review" }, { op: "discard" }];
    return null;
  }
  if (from === "awaiting_review") {
    if (to === "interrupted") return [{ op: "finish", state: "interrupted" }];
    if (to === "discarded") return [{ op: "discard" }];
  }
  return null;
}

/**
 * What to do about one live row, given this runner's record of the job.
 *
 * - A record still `queued` or `running` is a job this runner has not
 *   finished, so the row is left to the live path.
 * - A job the catalog would not hand over (`not-claimed`) is somebody else's
 *   row, as the runners' own refused-claim paths say.
 * - A row another runner claimed is that runner's.
 * - Otherwise the row is moved to the record's state, or to review for an
 *   accepted record, whose accept Reindex records.
 */
export function planRow(row: LiveRow, record: RowRecord, runnerName: string): RowPlan {
  if (row.state === record.state || LIVE.has(record.state)) return { kind: "in-step" };
  if (record.errorKind === "not-claimed") {
    return { kind: "leave", reason: "the catalog would not hand this job to this runner, so its row belongs to whoever holds it" };
  }
  if (row.runner !== null && row.runner !== runnerName) {
    return { kind: "leave", reason: `the row was claimed by ${row.runner}, not by ${runnerName}` };
  }
  const accepted = record.state === "accepted";
  const steps = stepsBetween(row.state, accepted ? "awaiting_review" : record.state, record.startedAt !== null);
  if (steps === null) {
    return { kind: "leave", reason: `the row is ${row.state} and the record ${record.state}, and the catalog has no path between the two` };
  }
  if (accepted) {
    const note = "the record says accepted: Reindex records the accept once the row is in review";
    return steps.length === 0 ? { kind: "leave", reason: note } : { kind: "repair", steps, note };
  }
  return { kind: "repair", steps };
}

/** The rows `job ls` or `job show` printed, or null when the answer is not that shape. */
export function liveRows(json: unknown): LiveRow[] | null {
  const jobs = (json as { jobs?: unknown } | null)?.jobs;
  if (!Array.isArray(jobs)) return null;
  const rows: LiveRow[] = [];
  for (const job of jobs) {
    const row = rowOf(job);
    if (row !== null) rows.push(row);
  }
  return rows;
}

function rowOf(value: unknown): LiveRow | null {
  const job = value as { id?: unknown; state?: unknown; targetPath?: unknown; runner?: unknown } | null;
  if (job === null || typeof job !== "object") return null;
  if (typeof job.id !== "string" || typeof job.state !== "string" || typeof job.targetPath !== "string") return null;
  return {
    id: job.id,
    state: job.state as JobState,
    targetPath: job.targetPath,
    runner: typeof job.runner === "string" ? job.runner : null,
  };
}

/** The holder a catalog lease refusal names (`... is already held by job <id> ...`), or null. */
export function leaseHolder(error: string | null | undefined): string | null {
  return /already held by job ([0-9A-Za-z][\w-]*)/.exec(error ?? "")?.[1] ?? null;
}

/** The session end that matches a job's end, as the runners' own `finish` sends it. */
function sessionState(state: JobState): string {
  if (state === "cancelled") return "cancelled";
  if (state === "failed") return "failed";
  if (state === "interrupted") return "interrupted";
  return "closed";
}

export interface RowRepair {
  id: string;
  targetPath: string;
  from: JobState;
  to: JobState;
  note?: string;
}

export interface RowLeft {
  id: string;
  targetPath: string;
  state: JobState;
  reason: string;
}

/** Where the reconcile stands, for `/api/health`. */
export interface RowsStatus {
  /** When the catalog last answered a reconcile, or null when it never has. */
  checkedAt: string | null;
  /**
   * Set while there is a reconcile still owed: the catalog could not be read
   * or written, or a finish failed since the last pass. Health retries it the
   * next time it sees the catalog answer.
   */
  pending: { since: string; error: string } | null;
  /** The rows the last pass moved. */
  repaired: RowRepair[];
  /** Rows with a record that the last pass could not move, and why. */
  left: RowLeft[];
  /**
   * Live rows of this kind that no record in this studio home names: a job
   * directory removed by hand, or another studio home on the same catalog
   * and owner. Never written to, since nothing here can prove they are this
   * runner's and that no process is running them.
   */
  orphans: { id: string; targetPath: string; state: JobState; runner: string | null }[];
}

export interface CatalogRowsDeps<R extends RowRecord> {
  kind: string;
  runnerName: string;
  store: RecordStore<R>;
  /** True while the runner itself is writing this job: running, or between its record and its enqueue. */
  busy: (id: string) => boolean;
  /** The `job finish` the runner's own `finish` would send for this record, in `state`. */
  finishInput: (record: R, state: JobState) => Promise<JobFinishInput>;
}

export class CatalogRows<R extends RowRecord> {
  private readonly deps: CatalogRowsDeps<R>;
  private current: RowsStatus = { checkedAt: null, pending: null, repaired: [], left: [], orphans: [] };
  private inFlight: Promise<RowsStatus> | null = null;
  /** When a pass last started, for `retry`'s spacing. */
  private triedAt = 0;

  constructor(deps: CatalogRowsDeps<R>) {
    this.deps = deps;
  }

  status(): RowsStatus {
    return this.current;
  }

  /**
   * Note a catalog write about a job that did not land, so the next health
   * check that sees the catalog answer reconciles. The first reason is kept.
   */
  owe(error: string): void {
    this.current = { ...this.current, pending: this.current.pending ?? { since: new Date().toISOString(), error } };
  }

  /**
   * A reconcile when one is owed and none was tried in the last
   * `RETRY_MS`, else the last status. For `/api/health`, which is polled:
   * the spacing keeps a catalog that answers health but refuses the list
   * from costing a subprocess on every poll.
   */
  retry(now: number = Date.now()): Promise<RowsStatus> {
    if (this.current.pending === null || now - this.triedAt < RETRY_MS) return Promise.resolve(this.current);
    return this.reconcile();
  }

  /**
   * Read every live row of this kind once (`job ls --active`) and move each
   * one whose record has finished. One pass at a time: a second caller gets
   * the pass already running. Never rejects: a pass that throws is owed.
   */
  reconcile(): Promise<RowsStatus> {
    this.triedAt = Date.now();
    this.inFlight ??= this.pass()
      .catch((error: unknown) => {
        this.owe(`the reconcile threw: ${(error as Error).message}`);
        return this.current;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /**
   * The job a lease refusal named, when this runner's record of it has moved
   * on and its row has not: moved like a reconcile would, from one `job show`.
   * True when the row now holds no lease, so the refused enqueue is worth one
   * more try.
   */
  async release(holderId: string): Promise<boolean> {
    const record = this.deps.store.get(holderId);
    if (record === undefined || LIVE.has(record.state) || record.state === "awaiting_review") return false;
    if (this.deps.busy(holderId)) return false;
    const shown = await jobShow(holderId);
    if (!shown.ok) {
      this.owe(shown.error ?? "job show failed");
      return false;
    }
    const row = rowOf((shown.json as { job?: unknown } | null)?.job);
    if (row === null) return false;
    const done = await this.repair(row, record);
    return done !== null && !["queued", "running", "awaiting_review"].includes(done.to);
  }

  private async pass(): Promise<RowsStatus> {
    // A debt noted from here on is one this pass may already have read past,
    // so it outlives the pass; one noted before is this pass's to settle.
    const before = this.current.pending;
    this.current = { ...this.current, pending: null };
    const listed = await jobListActive(this.deps.kind);
    const rows = listed.ok ? liveRows(listed.json) : null;
    if (rows === null) {
      this.current = { ...this.current, pending: before };
      this.owe(listed.error ?? "job ls --active printed no job list");
      return this.current;
    }
    const repaired: RowRepair[] = [];
    const left: RowLeft[] = [];
    const orphans: RowsStatus["orphans"] = [];
    let owed: string | null = null;
    for (const row of rows) {
      const record = this.deps.store.get(row.id);
      if (record === undefined) {
        orphans.push({ id: row.id, targetPath: row.targetPath, state: row.state, runner: row.runner });
        continue;
      }
      if (this.deps.busy(row.id)) continue;
      const plan = planRow(row, record, this.deps.runnerName);
      if (plan.kind === "leave") left.push({ id: row.id, targetPath: row.targetPath, state: row.state, reason: plan.reason });
      if (plan.kind !== "repair") continue;
      const outcome = await this.run(row, record, plan);
      if ("error" in outcome) {
        // Only a catalog that did not answer is worth asking again; a refusal
        // will refuse the next pass too, and is reported rather than retried.
        if (outcome.transient) owed ??= outcome.error;
        left.push({ id: row.id, targetPath: row.targetPath, state: outcome.reached, reason: outcome.error });
      } else {
        repaired.push(outcome);
      }
    }
    this.current = {
      checkedAt: new Date().toISOString(),
      pending: this.current.pending ?? (owed === null ? null : { since: new Date().toISOString(), error: owed }),
      repaired,
      left,
      orphans,
    };
    return this.current;
  }

  /** One row, planned and moved; the repair, or null when it was left. */
  private async repair(row: LiveRow, record: R): Promise<RowRepair | null> {
    const plan = planRow(row, record, this.deps.runnerName);
    if (plan.kind !== "repair") return null;
    const outcome = await this.run(row, record, plan);
    if ("error" in outcome) {
      if (outcome.transient) this.owe(outcome.error);
      return null;
    }
    this.current = { ...this.current, repaired: [...this.current.repaired, outcome] };
    return outcome;
  }

  /**
   * The plan's writes in order, stopping at the first refusal. A refusal is
   * also noted on the record, where every failed catalog call of a job goes.
   */
  private async run(
    row: LiveRow,
    record: R,
    plan: Extract<RowPlan, { kind: "repair" }>,
  ): Promise<RowRepair | { error: string; reached: JobState; transient: boolean }> {
    let reached = row.state;
    let finishedIn: JobState | null = null;
    for (const step of plan.steps) {
      const result = await this.write(record, step).catch((thrown: unknown) => ({
        ok: false,
        offline: false,
        error: `the runner threw: ${(thrown as Error).message}`,
      }));
      if (!result.ok) {
        const error = `the reconcile could not move the row from ${reached}: ${result.error ?? "the catalog refused"}`;
        await this.deps.store.noteCatalogError(record.id, error);
        return { error, reached, transient: result.offline || /timed out/.test(result.error ?? "") };
      }
      reached = step.op === "claim" ? "running" : step.op === "finish" ? step.state : "discarded";
      if (step.op === "finish") finishedIn = step.state;
    }
    // The session the live `finish` would have closed after its `job finish`.
    // Its answer is not the reconcile's business: a session already ended
    // refuses, and that is the state wanted.
    if (finishedIn !== null && record.sessionId !== null) {
      await sessionEnd(record.sessionId, sessionState(finishedIn)).catch(() => undefined);
    }
    return { id: record.id, targetPath: row.targetPath, from: row.state, to: reached, ...(plan.note === undefined ? {} : { note: plan.note }) };
  }

  private async write(record: R, step: RowStep): Promise<{ ok: boolean; offline: boolean; error: string | null }> {
    if (step.op === "claim") return jobClaim(record.id, this.deps.runnerName);
    if (step.op === "finish") return jobFinish(await this.deps.finishInput(record, step.state));
    return jobDiscard(record.id, discardReason(record));
  }
}

/** A discard's reason as the record keeps it, for `job discard`. */
function discardReason(record: StoredRecord): { tags: readonly string[]; note: string | null } | undefined {
  const review = record.review ?? null;
  return review !== null && review.verdict === "discard" ? { tags: review.tags, note: review.note } : undefined;
}
