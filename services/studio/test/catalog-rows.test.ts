import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { canTransition, JOB_ACTIVE_STATES, JOB_STATES, JOB_TRANSITIONS, type JobState } from "@hermes/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { validateBrief, type ValidBrief } from "../src/diagram/brief";
import type { JobRecord } from "../src/data/store";
import type { VideoDoctor, VideoDoctorReport } from "../src/video/doctor";
import type { ValidVideoBrief } from "../src/video/brief";
import type { VideoJobRecord } from "../src/video/types";
import { narratedBrief } from "./video-fixture";
import { testVocabulary } from "./vocabulary";

/**
 * The catalog's job rows against the runners' records, after a stop between
 * the two.
 *
 * Measured on 2026-11-20: the app restarted while a video job ran, the
 * record said `cancelled`, the row said `running`, and the row's lease
 * refused the next job for that video with a 409 until a person ran `catalog
 * job finish`. The catalog here is a stand-in that keeps rows and refuses
 * what the real one refuses: a transition `JOB_TRANSITIONS` does not have, a
 * second live job on a path, every call while it is down.
 */

interface Row {
  id: string;
  kind: string;
  state: JobState;
  targetPath: string;
  runner: string | null;
}

const catalogMock = vi.hoisted(() => ({
  jobEnqueue: vi.fn(),
  jobClaim: vi.fn(),
  jobFinish: vi.fn(),
  jobShow: vi.fn(),
  jobListActive: vi.fn(),
  jobAccept: vi.fn(),
  jobDiscard: vi.fn(),
  jobReview: vi.fn(),
  sessionStart: vi.fn(),
  sessionEnd: vi.fn(),
  status: vi.fn(),
  diagramShow: vi.fn(),
  diagramCheckout: vi.fn(),
  videoShow: vi.fn(),
  videoCheckout: vi.fn(),
  videoPut: vi.fn(),
  preferenceGet: vi.fn(),
}));
vi.mock("../src/data/catalog", () => catalogMock);

const { Runner } = await import("../src/diagram/runner");
const { JobStore, RecordStore } = await import("../src/data/store");
const { VideoRunner } = await import("../src/video/runner");
const { planRow, stepsBetween, leaseHolder } = await import("../src/data/catalog-rows");
const { RUNNER_NAME } = await import("../src/config");
const { VIDEO_RUNNER_NAME } = await import("../src/video/config");
const { jobDir, targetPath } = await import("../src/paths");

/* ---------------------------------------------------------------------- */
/* The stand-in catalog                                                   */
/* ---------------------------------------------------------------------- */

const rows = new Map<string, Row>();
const catalog = { down: false };

const answer = (json: unknown) => ({ ok: true, json, error: null, offline: false });
const refuse = (error: string) => ({ ok: false, json: null, error, offline: false });
const unreachable = () => ({ ok: false, json: null, error: "catalog job: database unreachable", offline: true });

function move(id: string, to: JobState): ReturnType<typeof answer> | ReturnType<typeof refuse> {
  const row = rows.get(id);
  if (row === undefined) return refuse(`no job "${id}"`);
  if (!canTransition(JOB_TRANSITIONS, row.state, to)) return refuse(`job ${id} is ${row.state}, and ${row.state} → ${to} is not a transition`);
  row.state = to;
  return answer({ job: { ...row } });
}

function stageCatalog(): void {
  rows.clear();
  catalog.down = false;
  for (const fn of Object.values(catalogMock)) fn.mockReset();
  const live = <T>(work: () => T) => (catalog.down ? unreachable() : work());
  catalogMock.jobListActive.mockImplementation(async (kind: string) =>
    live(() => answer({ jobs: [...rows.values()].filter((row) => row.kind === kind && (JOB_ACTIVE_STATES as readonly string[]).includes(row.state)).map((row) => ({ ...row })) })),
  );
  catalogMock.jobShow.mockImplementation(async (id: string) => live(() => (rows.has(id) ? answer({ job: { ...rows.get(id) } }) : refuse(`no job "${id}"`))));
  catalogMock.jobFinish.mockImplementation(async (input: { jobId: string; state: JobState }) => live(() => move(input.jobId, input.state)));
  catalogMock.jobDiscard.mockImplementation(async (id: string) => live(() => move(id, "discarded")));
  catalogMock.jobClaim.mockImplementation(async (id: string, runner: string) =>
    live(() => {
      const moved = move(id, "running");
      if (moved.ok) rows.get(id)!.runner = runner;
      return moved;
    }),
  );
  catalogMock.jobEnqueue.mockImplementation(async (briefFile: string) => {
    if (catalog.down) return unreachable();
    const brief = JSON.parse(await readFile(briefFile, "utf8")) as { id: string; kind: string; target: string };
    const held = [...rows.values()].find((row) => row.targetPath === brief.target && (JOB_ACTIVE_STATES as readonly string[]).includes(row.state));
    if (held !== undefined) return refuse(`${brief.target} is already held by job ${held.id} (${held.state}). Accept or discard that one first.`);
    rows.set(brief.id, { id: brief.id, kind: brief.kind, state: "queued", targetPath: brief.target, runner: null });
    return answer({ job: { id: brief.id } });
  });
  catalogMock.sessionStart.mockResolvedValue(answer({}));
  catalogMock.sessionEnd.mockResolvedValue(answer({}));
  catalogMock.diagramShow.mockResolvedValue(unreachable());
  catalogMock.diagramCheckout.mockResolvedValue(unreachable());
  catalogMock.videoShow.mockResolvedValue(answer({ video: null }));
  catalogMock.preferenceGet.mockResolvedValue(answer({ value: null }));
}

/** A row as the catalog would hold it for a job: by default this runner claimed it and it is running. */
function row(id: string, over: Partial<Row> & { kind: string; targetPath: string }): Row {
  const made: Row = { id, state: "running", runner: over.kind === "video" ? VIDEO_RUNNER_NAME : RUNNER_NAME, ...over };
  rows.set(id, made);
  return made;
}

const finishes = () => catalogMock.jobFinish.mock.calls.map((call) => (call as [{ jobId: string; state: string; runFile?: string; gateFile?: string }])[0]);

let home: string;
const saved = { STUDIO_HOME: process.env.STUDIO_HOME, STUDIO_DAILY_USD: process.env.STUDIO_DAILY_USD };

beforeEach(() => {
  home = path.join(tmpdir(), `studio-catalog-rows-${Date.now()}-${Math.random()}`);
  process.env.STUDIO_HOME = home;
  delete process.env.STUDIO_DAILY_USD;
  stageCatalog();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/* ---------------------------------------------------------------------- */
/* The plan                                                               */
/* ---------------------------------------------------------------------- */

describe("the path from a row's state to a record's", () => {
  it("is made only of edges the catalog has", () => {
    for (const from of JOB_ACTIVE_STATES) {
      for (const to of JOB_STATES) {
        for (const ran of [true, false]) {
          const steps = stepsBetween(from, to, ran);
          if (steps === null) continue;
          let at: JobState = from;
          for (const step of steps) {
            const next: JobState = step.op === "claim" ? "running" : step.op === "discard" ? "discarded" : step.state;
            expect(canTransition(JOB_TRANSITIONS, at, next), `${from} to ${to}: ${at} → ${next}`).toBe(true);
            at = next;
          }
          expect(at).toBe(to);
        }
      }
    }
  });

  it("never writes accepted, and claims a queued row only for a job that started", () => {
    expect(stepsBetween("running", "accepted", true)).toBeNull();
    expect(stepsBetween("queued", "failed", false)).toBeNull();
    expect(stepsBetween("queued", "failed", true)).toEqual([{ op: "claim" }, { op: "finish", state: "failed" }]);
    expect(stepsBetween("queued", "cancelled", false)).toEqual([{ op: "finish", state: "cancelled" }]);
    expect(stepsBetween("awaiting_review", "failed", true)).toBeNull();
  });

  it("leaves a job the runner is still finishing, a refused claim, and another runner's row", () => {
    const record = { state: "cancelled" as JobState, errorKind: "cancelled", startedAt: "t", sessionId: null };
    const live = { id: "j", state: "running" as JobState, targetPath: "p", runner: RUNNER_NAME };
    expect(planRow(live, { ...record, state: "running" } as never, RUNNER_NAME)).toEqual({ kind: "in-step" });
    expect(planRow(live, { ...record, errorKind: "not-claimed", state: "failed" } as never, RUNNER_NAME)).toMatchObject({ kind: "leave" });
    expect(planRow({ ...live, runner: "elsewhere" }, record as never, RUNNER_NAME)).toMatchObject({ kind: "leave", reason: expect.stringContaining("elsewhere") });
    expect(planRow(live, record as never, RUNNER_NAME)).toEqual({ kind: "repair", steps: [{ op: "finish", state: "cancelled" }] });
  });

  it("reads the holder a lease refusal names", () => {
    expect(leaseHolder("videos/a.mp4 is already held by job 1b2c-3d (running). Accept")).toBe("1b2c-3d");
    expect(leaseHolder("the lease on x is already held by job y")).toBe("y");
    expect(leaseHolder("topic not in the vocabulary")).toBeNull();
  });
});

/* ---------------------------------------------------------------------- */
/* Diagram jobs                                                           */
/* ---------------------------------------------------------------------- */

const SLUG = "catalog-rows-fixture";

function diagramRecord(id: string, state: JobState, over: Partial<JobRecord> = {}): JobRecord {
  const at = new Date().toISOString();
  return {
    id,
    kind: "diagram",
    state,
    phase: state === "awaiting_review" ? "ready" : "drawing",
    brief: {
      intent: "i",
      topic: "vector-and-linear-algebra-basics",
      slug: SLUG,
      title: "t",
      mode: "new",
      elements: [{ label: "a" }],
      relations: [],
      concepts: [],
      model: "sonnet",
      idempotencyKey: `${id}-key`,
    },
    targetPath: targetPath(SLUG),
    targetSvgPath: `learn/assets/${SLUG}.svg`,
    candidatePath: path.join(jobDir(id), "candidate", `${SLUG}.tldr`),
    candidateSvgPath: path.join(jobDir(id), "candidate", `${SLUG}.svg`),
    topic: "vector-and-linear-algebra-basics",
    slug: SLUG,
    attempt: 1,
    sessionId: `studio-${id}`,
    agentSessionId: null,
    parentJobId: null,
    draftId: null,
    changes: null,
    idempotencyKey: `${id}-key`,
    targetHashBefore: null,
    requestedAt: at,
    startedAt: at,
    finishedAt: at,
    reviewedAt: null,
    heartbeatAt: null,
    cancelRequestedAt: null,
    exitCode: null,
    turns: 4,
    costUsd: 0.12,
    costSource: "stream",
    gate:
      state === "awaiting_review"
        ? { ok: true, steps: [], findings: [], shapes: 3, lints: 0, svg: null, exportFailed: false, checkedAt: at }
        : null,
    errorKind: state === "cancelled" ? "cancelled" : state === "failed" ? "timeout" : state === "interrupted" ? "interrupted" : null,
    error: state === "awaiting_review" ? null : `the job ended ${state}`,
    written: [],
    indexed: false,
    catalogErrors: [],
    attempts: [],
    review: null,
    ...over,
  } as JobRecord;
}

async function diagramBrief(key: string): Promise<ValidBrief> {
  return validateBrief(
    {
      intent: "show how a dot product projects one vector onto another",
      topic: "vector-and-linear-algebra-basics",
      slug: SLUG,
      title: "Dot product",
      mode: "new",
      elements: [{ label: "vector a" }],
      relations: [],
      idempotencyKey: key,
    },
    testVocabulary(),
  );
}

/** A runner that never starts a job: drained first, so `kick` does nothing and no agent is spawned. */
async function diagramRunner(store: InstanceType<typeof JobStore>) {
  const runner = new Runner(store);
  await runner.drain();
  return runner;
}

describe("the startup reconcile, for diagram jobs", () => {
  it.each(["cancelled", "failed", "awaiting_review", "interrupted"] as const)(
    "finishes a running row whose record says %s, with the record's own finish, and does nothing the second time",
    async (state) => {
      const store = new JobStore();
      const record = await store.create(diagramRecord(`d-${state}`, state));
      row(record.id, { kind: "diagram", targetPath: record.targetPath });
      const runner = await diagramRunner(store);

      const status = await runner.reconcileCatalog();
      expect(rows.get(record.id)?.state).toBe(state);
      expect(status).toMatchObject({ pending: null, repaired: [{ id: record.id, from: "running", to: state }], left: [], orphans: [] });
      const [finish] = finishes();
      expect(finish).toMatchObject({ jobId: record.id, state, costUsd: 0.12, costSource: "stream", runFile: path.join(jobDir(record.id), "run.json") });
      expect(finish?.gateFile === undefined).toBe(state !== "awaiting_review");
      if (finish?.gateFile !== undefined) expect((await stat(finish.gateFile)).isFile()).toBe(true);
      expect(catalogMock.sessionEnd).toHaveBeenCalledWith(record.sessionId, state === "awaiting_review" ? "closed" : state);

      // A second start, from the records on disk, changes nothing.
      catalogMock.jobFinish.mockClear();
      const reloaded = new JobStore();
      await reloaded.load();
      const again = await (await diagramRunner(reloaded)).reconcileCatalog();
      expect(again).toMatchObject({ pending: null, repaired: [], left: [] });
      expect(catalogMock.jobFinish).not.toHaveBeenCalled();
    },
  );

  it("claims the queued row of a job that ran while the catalog missed its claim, then finishes it", async () => {
    const store = new JobStore();
    const record = await store.create(diagramRecord("d-queued", "failed"));
    row(record.id, { kind: "diagram", targetPath: record.targetPath, state: "queued", runner: null });
    const status = await (await diagramRunner(store)).reconcileCatalog();
    expect(catalogMock.jobClaim).toHaveBeenCalledWith(record.id, RUNNER_NAME);
    expect(rows.get(record.id)).toMatchObject({ state: "failed", runner: RUNNER_NAME });
    expect(status.repaired).toEqual([expect.objectContaining({ from: "queued", to: "failed" })]);
  });

  it("brings a discarded record's running row through review to discarded, with the person's reason", async () => {
    const store = new JobStore();
    const review = { verdict: "discard" as const, tags: ["too-much-text" as const], note: "too busy", at: new Date().toISOString() };
    const record = await store.create(diagramRecord("d-discarded", "discarded", { review }));
    row(record.id, { kind: "diagram", targetPath: record.targetPath });
    await (await diagramRunner(store)).reconcileCatalog();
    expect(finishes().map((input) => input.state)).toEqual(["awaiting_review"]);
    expect(catalogMock.jobDiscard).toHaveBeenCalledWith(record.id, { tags: ["too-much-text"], note: "too busy" });
    expect(rows.get(record.id)?.state).toBe("discarded");
  });

  it("touches no job still running here, no refused claim, no other runner's row and no row without a record", async () => {
    const store = new JobStore();
    const running = await store.create(diagramRecord("d-running", "running"));
    row(running.id, { kind: "diagram", targetPath: "learn/assets/a.tldr" });
    const refused = await store.create(diagramRecord("d-refused", "failed", { errorKind: "not-claimed", targetPath: "learn/assets/b.tldr" }));
    row(refused.id, { kind: "diagram", targetPath: refused.targetPath, runner: "another-studio" });
    const claimedElsewhere = await store.create(diagramRecord("d-elsewhere", "cancelled", { targetPath: "learn/assets/c.tldr" }));
    row(claimedElsewhere.id, { kind: "diagram", targetPath: claimedElsewhere.targetPath, runner: "another-studio" });
    row("not-ours", { kind: "diagram", targetPath: "learn/assets/d.tldr" });

    const status = await (await diagramRunner(store)).reconcileCatalog();
    expect(catalogMock.jobFinish).not.toHaveBeenCalled();
    expect([...rows.values()].every((each) => each.state === "running")).toBe(true);
    expect(status.left.map((each) => each.id).sort()).toEqual([claimedElsewhere.id, refused.id].sort());
    expect(status.orphans).toEqual([{ id: "not-ours", targetPath: "learn/assets/d.tldr", state: "running", runner: RUNNER_NAME }]);
  });

  it("with the catalog down at start, owes the reconcile and pays it once the catalog answers", async () => {
    const store = new JobStore();
    const record = await store.create(diagramRecord("d-down", "cancelled"));
    row(record.id, { kind: "diagram", targetPath: record.targetPath });
    const runner = await diagramRunner(store);

    catalog.down = true;
    const deferred = await runner.reconcileCatalog();
    expect(deferred.pending).toMatchObject({ error: expect.stringContaining("unreachable") });
    expect(rows.get(record.id)?.state).toBe("running");
    // What `/api/health` calls when it sees the catalog answer: not again
    // within the minute, so a poll is not a subprocess each time.
    catalog.down = false;
    catalogMock.jobListActive.mockClear();
    expect((await runner.rows.retry()).pending).not.toBeNull();
    expect(catalogMock.jobListActive).not.toHaveBeenCalled();
    const paid = await runner.rows.retry(Date.now() + 61_000);
    expect(paid.pending).toBeNull();
    expect(rows.get(record.id)?.state).toBe("cancelled");
    // Nothing owed, nothing read.
    catalogMock.jobListActive.mockClear();
    await runner.rows.retry(Date.now() + 200_000);
    expect(catalogMock.jobListActive).not.toHaveBeenCalled();
  });

  it("reports a row the catalog refuses to move, and does not keep asking", async () => {
    const store = new JobStore();
    const record = await store.create(diagramRecord("d-refused-move", "cancelled"));
    row(record.id, { kind: "diagram", targetPath: record.targetPath });
    catalogMock.jobFinish.mockResolvedValueOnce(refuse("catalog job finish: --run-file: attempts[0] is not an attempt"));
    const status = await (await diagramRunner(store)).reconcileCatalog();
    expect(status.pending).toBeNull();
    expect(status.left).toEqual([expect.objectContaining({ id: record.id, reason: expect.stringContaining("not an attempt") })]);
    expect(store.get(record.id)?.catalogErrors.at(-1)).toContain("not an attempt");
  });

  it("an enqueue refused by the lease of a job this runner already finished moves that row and goes through", async () => {
    const store = new JobStore();
    const stale = await store.create(diagramRecord("d-stale", "cancelled"));
    row(stale.id, { kind: "diagram", targetPath: stale.targetPath });
    const runner = await diagramRunner(store);

    const { record, created } = await runner.enqueue(await diagramBrief("after-the-stale-lease"));
    expect(created).toBe(true);
    expect(rows.get(stale.id)?.state).toBe("cancelled");
    expect(rows.get(record.id)?.state).toBe("queued");
    expect(catalogMock.jobEnqueue).toHaveBeenCalledTimes(2);
  });

  it("still refuses with 409 when the lease is held by a job no record here has finished", async () => {
    const store = new JobStore();
    row("live-elsewhere", { kind: "diagram", targetPath: targetPath(SLUG) });
    const runner = await diagramRunner(store);
    await expect(runner.enqueue(await diagramBrief("behind-a-live-lease"))).rejects.toMatchObject({ status: 409 });
    expect(rows.get("live-elsewhere")?.state).toBe("running");
    expect(catalogMock.jobEnqueue).toHaveBeenCalledTimes(1);
  });
});

/* ---------------------------------------------------------------------- */
/* Video jobs                                                             */
/* ---------------------------------------------------------------------- */

function doctor(): VideoDoctor {
  const full: VideoDoctorReport = { ok: true, sandbox: true, metal: true, kokoro: true, voices: ["af_heart"], checks: [], checkedAt: new Date().toISOString() };
  return { report: async () => full, current: () => full, start: () => undefined, stop: () => undefined } as unknown as VideoDoctor;
}

function videoBrief(over: Partial<ValidVideoBrief> = {}): ValidVideoBrief {
  return { ...narratedBrief(), idempotencyKey: `key-${Math.random()}`, ...over };
}

async function videoRunner(store: InstanceType<typeof RecordStore<VideoJobRecord>>) {
  const runner = new VideoRunner(store, { doctor: doctor() });
  await runner.drain();
  return runner;
}

/** A video job as a stopped runner left it: enqueued (its row queued), then its record moved to `state` and its row to `rowState`. */
async function stoppedVideo(store: InstanceType<typeof RecordStore<VideoJobRecord>>, state: JobState, rowState: JobState = "running", over: Partial<ValidVideoBrief> = {}) {
  const runner = await videoRunner(store);
  const { record } = await runner.enqueue(videoBrief(over));
  const at = new Date().toISOString();
  await store.update(record.id, {
    state,
    startedAt: at,
    finishedAt: at,
    sessionId: `studio-${record.id}`,
    errorKind: state === "cancelled" ? "cancelled" : state === "failed" ? "internal" : state === "interrupted" ? "interrupted" : null,
    error: state === "awaiting_review" ? null : "stopped on request",
  });
  const held = rows.get(record.id)!;
  held.state = rowState;
  held.runner = rowState === "queued" ? null : VIDEO_RUNNER_NAME;
  return { runner, record: store.get(record.id)! };
}

describe("the startup reconcile, for video jobs", () => {
  it.each(["cancelled", "failed", "awaiting_review", "interrupted"] as const)(
    "finishes a running row whose record says %s, and does nothing the second time",
    async (state) => {
      const store = new RecordStore<VideoJobRecord>("video");
      const { record } = await stoppedVideo(store, state);
      const status = await (await videoRunner(store)).reconcileCatalog();
      expect(rows.get(record.id)?.state).toBe(state);
      expect(status).toMatchObject({ pending: null, repaired: [{ id: record.id, from: "running", to: state }] });
      expect(finishes().at(-1)).toMatchObject({ jobId: record.id, state, candidatePath: expect.stringContaining(record.id), runFile: path.join(jobDir(record.id), "run.json") });

      catalogMock.jobFinish.mockClear();
      const reloaded = new RecordStore<VideoJobRecord>("video");
      await reloaded.load();
      expect(await (await videoRunner(reloaded)).reconcileCatalog()).toMatchObject({ repaired: [], left: [] });
      expect(catalogMock.jobFinish).not.toHaveBeenCalled();
    },
  );

  it("is the incident: a cancelled video whose row stayed running no longer refuses the next one", async () => {
    const store = new RecordStore<VideoJobRecord>("video");
    const slug = "two-boxes";
    const { runner, record } = await stoppedVideo(store, "cancelled", "running", { slug });
    // Today's runner, before any restart: the press is reconciled and goes through.
    const { record: next, created } = await runner.enqueue(videoBrief({ slug }));
    expect(created).toBe(true);
    expect(rows.get(record.id)?.state).toBe("cancelled");
    expect(rows.get(next.id)?.state).toBe("queued");
  });

  it("with the catalog down at start, owes it, and a later pass finishes the row", async () => {
    const store = new RecordStore<VideoJobRecord>("video");
    const { record } = await stoppedVideo(store, "interrupted");
    const runner = await videoRunner(store);
    catalog.down = true;
    expect((await runner.reconcileCatalog()).pending).not.toBeNull();
    expect(rows.get(record.id)?.state).toBe("running");
    catalog.down = false;
    expect((await runner.rows.retry(Date.now() + 61_000)).pending).toBeNull();
    expect(rows.get(record.id)?.state).toBe("interrupted");
  });

  it("leaves a video job still running here alone, and reports a row no record names", async () => {
    const store = new RecordStore<VideoJobRecord>("video");
    const { record } = await stoppedVideo(store, "running");
    row("elsewhere", { kind: "video", targetPath: "videos/elsewhere.mp4" });
    const status = await (await videoRunner(store)).reconcileCatalog();
    expect(catalogMock.jobFinish).not.toHaveBeenCalled();
    expect(rows.get(record.id)?.state).toBe("running");
    expect(status.orphans.map((each) => each.id)).toEqual(["elsewhere"]);
  });
});
