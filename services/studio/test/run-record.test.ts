import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkJobRun, JOB_RUN_LIMITS } from "@hermes/schema/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The pieces of a run record and a review, one at a time: the gate summary,
 * an attempt's own share of the job's cost, the calls and render seconds
 * read off the wrapper's log, the check before the file is written, the
 * discard body, and a `job.json` from before any of this loading as it did.
 */

const catalogMock = vi.hoisted(() => ({ jobReview: vi.fn() }));
vi.mock("../src/data/catalog", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/data/catalog")>()), ...catalogMock }));

const {
  appendAttempt,
  buildJobRun,
  callCounts,
  endAttempt,
  gateSummary,
  keepReview,
  parseReviewReason,
  renderSeconds,
  reviseNote,
  runFileFor,
  startAttempt,
  transcriptRef,
  withAttemptCritic,
  withAttemptGate,
  writeRunFile,
} = await import("../src/data/run-record");
const { JobStore, RecordStore } = await import("../src/data/store");
type VideoJobRecordT = import("../src/video/types").VideoJobRecord;

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "studio-run-record-unit-"));
  process.env.STUDIO_HOME = home;
  catalogMock.jobReview.mockReset().mockResolvedValue({ ok: true, json: {}, error: null, offline: false });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  delete process.env.STUDIO_HOME;
});

describe("an attempt", () => {
  it("is charged what the job's meter gained while it ran, and keeps its own turns", () => {
    const begun = startAttempt(2, 0.05);
    const ended = endAttempt(begun, { turns: 7 }, 0.080_000_4);
    // 0.0800004 less 0.05, to the six places the CLI's own figure carries.
    expect(ended).toMatchObject({ n: 2, turns: 7, costUsd: 0.03, gate: null });
    expect(Date.parse(ended.endedAt!)).toBeGreaterThanOrEqual(Date.parse(ended.startedAt!));
  });

  it("is charged from nothing when the meter had read nothing, and nothing is known when it can price nothing", () => {
    expect(endAttempt(startAttempt(1, null), { turns: 1 }, 0.01).costUsd).toBe(0.01);
    expect(endAttempt(startAttempt(1, 0.01), null, null)).toMatchObject({ costUsd: null, turns: null });
  });

  it("gets its gate once the gate has judged it, and the list keeps the newest it can hold", () => {
    const one = endAttempt(startAttempt(1, 0), { turns: 1 }, 0);
    const two = endAttempt(startAttempt(2, 0), { turns: 1 }, 0);
    const summary = gateSummary({ ok: false, steps: [{ name: "lints", ok: false }], findings: ["a", "b"], warnings: ["w"] });
    expect(summary).toEqual({ ok: false, steps: [{ name: "lints", ok: false }], findings: 2, warnings: 1 });
    expect(withAttemptGate([one, two], 2, summary).map((attempt) => attempt.gate)).toEqual([null, summary]);
    // A diagram gate has no warnings.
    expect(gateSummary({ ok: true, steps: [], findings: [] }).warnings).toBe(0);
    let many: ReturnType<typeof appendAttempt> = [];
    for (let n = 1; n <= JOB_RUN_LIMITS.maxAttempts + 3; n += 1) many = appendAttempt(many, { ...one, n });
    expect(many).toHaveLength(JOB_RUN_LIMITS.maxAttempts);
    expect(many.at(-1)?.n).toBe(JOB_RUN_LIMITS.maxAttempts + 3);
  });

  it("gets its critic on its own number, copied, and leaves the list it was given alone", () => {
    const one = endAttempt(startAttempt(1, 0), { turns: 1 }, 0);
    const two = endAttempt(startAttempt(2, 0), { turns: 1 }, 0);
    const critic = { model: "claude-opus-5-5", costUsd: 0.02, scores: { accuracy: 4, layout: 3, relevance: 5, variety: 2, pacing: 4 }, defects: 3, notes: 1 };
    const given = [one, two];
    const judged = withAttemptCritic(given, 2, critic);
    expect(judged.map((attempt) => attempt.critic)).toEqual([undefined, critic]);
    // Attempt 1 gains no critic key at all, so it stores as it did before.
    expect(Object.hasOwn(judged[0]!, "critic")).toBe(false);
    expect(given.every((attempt) => !Object.hasOwn(attempt, "critic"))).toBe(true);
    expect(judged[1]!.critic).not.toBe(critic);
    expect(judged[1]!.critic!.scores).not.toBe(critic.scores);
    // A critic that ran and gave nothing, and an attempt the list does not hold.
    expect(withAttemptCritic(judged, 2, null)[1]!.critic).toBeNull();
    expect(withAttemptCritic(given, 9, critic)).toEqual(given);
    expect(withAttemptCritic(undefined, 1, critic)).toEqual([]);
    // A gate set after the critic keeps it.
    const gate = gateSummary({ ok: true, steps: [], findings: [] });
    expect(withAttemptGate(judged, 2, gate)[1]).toMatchObject({ gate, critic });
  });
});

describe("the wrapper's log", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 20, 0, 0, s)).toISOString();

  it("counts calls by verb and times the renders, a call with no steps by its wall time", () => {
    const calls = [
      { verb: "lint", startedAt: at(0), endedAt: at(1) },
      { verb: "preview", startedAt: at(0), endedAt: at(9), steps: [{ step: "render", ms: 1_250 }] },
      { verb: "still", startedAt: at(0), endedAt: at(3) },
      { verb: "build", startedAt: at(0), endedAt: at(30), steps: [{ step: "render", ms: 10_000 }, { step: "narrate", ms: 5_000 }] },
    ];
    expect(callCounts(calls)).toEqual({ lint: 1, preview: 1, still: 1, build: 1 });
    expect(renderSeconds(calls)).toBe(14.25);
    expect(renderSeconds([{ verb: "lint", startedAt: at(0), endedAt: at(1) }])).toBe(0);
    expect(renderSeconds([])).toBeNull();
  });
});

describe("the run file", () => {
  const source = { id: "job-1", harnessVersion: "2.1.300", agentModel: { passed: "sonnet" }, agentEffort: { passed: null }, resolvedModel: "claude-sonnet-5", manualHash: "a".repeat(64), agentAuth: "login", attempts: [] };

  it("is a JobRun the catalog's check takes, its transcript relative to the studio home", async () => {
    const run = buildJobRun(source, { calls: { build: 1 }, renderSeconds: 2 });
    expect(checkJobRun(run)).toMatchObject({ ok: true });
    expect(run.transcriptPath).toBe("jobs/job-1/session.ndjson");
    expect(transcriptRef("job-1")).toBe("jobs/job-1/session.ndjson");
    await mkdir(path.join(home, "jobs", "job-1"), { recursive: true });
    const written = await writeRunFile("job-1", run);
    expect(written.file).toBe(path.join(home, "jobs", "job-1", "run.json"));
    expect(JSON.parse(await readFile(written.file!, "utf8"))).toEqual(run);
  });

  it("carries each attempt's critic through, and the catalog's check takes it", async () => {
    const critic = { model: null, costUsd: null, scores: { accuracy: 5, layout: 5, relevance: 4, variety: 3, pacing: 2 }, defects: 0, notes: 2 };
    const attempts = withAttemptCritic([endAttempt(startAttempt(1, 0), { turns: 2 }, 0.1), endAttempt(startAttempt(2, 0.1), { turns: 1 }, 0.2)], 1, critic);
    const run = buildJobRun({ ...source, attempts });
    expect(run.attempts.map((attempt) => attempt.critic)).toEqual([critic, undefined]);
    await mkdir(path.join(home, "jobs", "job-1"), { recursive: true });
    const written = await writeRunFile("job-1", run);
    const stored = JSON.parse(await readFile(written.file!, "utf8")) as typeof run;
    expect(stored).toEqual(run);
    expect(Object.hasOwn(stored.attempts[1]!, "critic")).toBe(false);
    // A score out of range fails the check, so the run file is not written.
    const bad = buildJobRun({ ...source, attempts: withAttemptCritic(attempts, 1, { ...critic, scores: { ...critic.scores, pacing: 0 } }) });
    expect(await writeRunFile("job-1", bad)).toMatchObject({ file: null, reason: expect.stringContaining("attempts[0].critic.scores.pacing") });
  });

  it("is never written when the record fails the check, and the reason is kept on the record", async () => {
    const bad = buildJobRun({ ...source, resolvedModel: "m".repeat(JOB_RUN_LIMITS.maxChars + 1) });
    const written = await writeRunFile("job-1", bad);
    expect(written).toMatchObject({ file: null, reason: expect.stringContaining("model.resolved") });
    expect(existsSync(path.join(home, "jobs", "job-1", "run.json"))).toBe(false);

    const store = new RecordStore<VideoJobRecordT>("video");
    await mkdir(path.join(home, "jobs", "job-2"), { recursive: true });
    await store.create({ id: "job-2", kind: "video", state: "running", targetPath: "videos/x.mp4", idempotencyKey: "k", requestedAt: new Date().toISOString(), startedAt: null, finishedAt: null, costUsd: null, costSource: null, catalogErrors: [], resolvedModel: "m".repeat(600) } as unknown as VideoJobRecordT);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await runFileFor(store, "job-2")).toEqual({});
    } finally {
      error.mockRestore();
    }
    expect(store.get("job-2")?.runRecordError).toContain("model.resolved");
  });
});

describe("a discard's body", () => {
  it("is no reason when absent, empty or blank", () => {
    for (const body of [undefined, null, {}, { tags: [], note: "  " }, { tags: null, note: null }]) {
      expect(parseReviewReason(body)).toEqual({ ok: true, reason: null });
    }
  });

  it("is down tags, each once, and a trimmed note", () => {
    expect(parseReviewReason({ tags: ["voice", "voice", "too-long"], note: "  too long by half " })).toEqual({
      ok: true,
      reason: { tags: ["voice", "too-long"], note: "too long by half" },
    });
    expect(parseReviewReason({ note: "just a note" })).toEqual({ ok: true, reason: { tags: [], note: "just a note" } });
  });

  it("is refused by name: an up tag, an unknown one, an overlong note, a shape that is not { tags, note }", () => {
    expect(parseReviewReason({ tags: ["good-pacing"] })).toMatchObject({ ok: false, message: expect.stringContaining('"good-pacing"') });
    expect(parseReviewReason({ tags: ["meh"] })).toMatchObject({ ok: false, message: expect.stringContaining('"meh"') });
    expect(parseReviewReason({ note: "n".repeat(2_001) })).toMatchObject({ ok: false, message: expect.stringContaining("2000") });
    expect(parseReviewReason({ note: 3 })).toMatchObject({ ok: false });
    expect(parseReviewReason("too slow")).toMatchObject({ ok: false });
    expect(parseReviewReason(["too-slow"])).toMatchObject({ ok: false });
  });
});

describe("an accept's or a revise's review", () => {
  it("is kept on the record and sent to the catalog, and a refusal is only noted", async () => {
    const store = new JobStore();
    await mkdir(path.join(home, "jobs", "job-3"), { recursive: true });
    await store.create({ id: "job-3", kind: "diagram", state: "accepted", targetPath: "learn/assets/x.tldr", idempotencyKey: "k", requestedAt: new Date().toISOString(), startedAt: null, finishedAt: null, costUsd: null, costSource: null, catalogErrors: [] } as unknown as import("../src/data/store").JobRecord);
    await keepReview(store, "job-3", "revise", { tags: [], note: reviseNote(`  ${"x".repeat(2_500)}  `) });
    expect(store.get("job-3")?.review).toMatchObject({ verdict: "revise", tags: [], note: "x".repeat(2_000) });
    expect(catalogMock.jobReview).toHaveBeenCalledWith("job-3", "revise", { tags: [], note: "x".repeat(2_000) });
    catalogMock.jobReview.mockResolvedValueOnce({ ok: false, json: null, error: "down", offline: true });
    await keepReview(store, "job-3", "accept");
    expect(store.get("job-3")).toMatchObject({ review: { verdict: "accept", note: null }, catalogErrors: ["down"] });
    // A job the store does not hold writes nothing and throws nothing.
    await expect(keepReview(store, "no-such-job", "accept")).resolves.toBeUndefined();
  });
});

describe("a job.json from before the attempt history", () => {
  it("loads with no attempts and no review", async () => {
    const id = "old-job";
    await mkdir(path.join(home, "jobs", id), { recursive: true });
    await writeFile(
      path.join(home, "jobs", id, "job.json"),
      JSON.stringify({ id, kind: "video", state: "failed", targetPath: "videos/old.mp4", idempotencyKey: "old", requestedAt: "2026-10-01T00:00:00.000Z", startedAt: null, finishedAt: null, costUsd: 0.4, catalogErrors: [] }),
      "utf8",
    );
    const store = new RecordStore<VideoJobRecordT>("video");
    await store.load();
    expect(store.get(id)).toMatchObject({ attempts: [], review: null, costSource: null });
    // And its run record is still one the catalog takes.
    expect(checkJobRun(buildJobRun(store.get(id)!))).toMatchObject({ ok: true, run: { attempts: [] } });
  });
});
