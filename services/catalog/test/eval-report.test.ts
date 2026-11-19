import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { asset, assetJob, learner, LOCAL_LEARNER_ID, topic, type JobRun } from "@hermes/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { formatEval, runEvalReport } from "../src/commands/eval";
import { runAccept, runClaim, runDiscard, runEnqueue, runFinish } from "../src/commands/job";
import { upsertAssetIngredients } from "../src/index/ingredients";
import { rateAsset } from "../src/state/asset-ratings";
import { migratedScratchDatabase, probe, type Scratch } from "./scratch-database";
import { storedBlob } from "./stored-blob";

/**
 * `catalog eval report` on a scratch catalog: videos with and without a scan,
 * a rating and a job, jobs that made no video, and the report's shape in text
 * and `--json`. Jobs are made through the job verbs; the link from a job to a
 * video is the `asset_job` row the studio's put writes.
 */

const reachable = await probe();

const A = "manimkc:out/demo/a/a.mp4";
const B = "manimkc:out/demo/b/b.mp4";
const C = "remotionkc:out/demo/c/c.mp4";

const RUN: JobRun = {
  harness: { name: "claude", version: "2.1.319" },
  model: { passed: "opus", resolved: "claude-opus-5-5" },
  effort: "high",
  manualHash: "0123456789abcdef",
  auth: "login",
  attempts: [
    { n: 1, startedAt: "2026-11-20T10:00:00.000Z", endedAt: "2026-11-20T10:03:00.000Z", turns: 9, costUsd: 0.4, gate: { ok: false, steps: [], findings: 1, warnings: 0 } },
    { n: 2, startedAt: "2026-11-20T10:03:00.000Z", endedAt: "2026-11-20T10:06:00.000Z", turns: 7, costUsd: 0.3, gate: { ok: true, steps: [], findings: 0, warnings: 0 } },
  ],
  calls: {},
  renderSeconds: null,
  transcriptPath: null,
};

const metrics = (over: Record<string, unknown> = {}) => ({
  files: 1,
  lines: 80,
  plays: 4,
  voiceovers: 3,
  rateFuncs: 0,
  helperCalls: 10,
  distinctHelpers: 3,
  helperTop5Share: 0.9,
  animationCalls: 8,
  distinctAnimations: 2,
  fadeShare: 0.75,
  engineCalls: 6,
  distinctEngine: 3,
  uses3d: false,
  variety: 0.5,
  ...over,
});

describe.skipIf(!reachable.ok)("catalog eval report", () => {
  let scratch: Scratch;
  let previousUrl: string | undefined;
  let previousManim: string | undefined;
  let root: string;

  async function video(id: string) {
    await scratch.db.insert(asset).values({
      id,
      kind: "video",
      path: id.slice(id.indexOf(":") + 1),
      title: `Video ${id.slice(-5)}`,
      blobKey: await storedBlob(scratch.db, id, "mp4"),
      sourceRepo: id.startsWith("manimkc") ? "manimkc" : "remotionkc",
      ownerId: LOCAL_LEARNER_ID,
    });
  }

  /** A job awaiting review, enqueued as a diagram job (the verbs are the same), optionally with a run record. */
  async function ready(name: string, extra: { run?: JobRun; costUsd?: number; turns?: number } = {}): Promise<string> {
    const queued = await runEnqueue({
      brief: { kind: "diagram", topic: "alpha", target: `learn/assets/${name}.tldr`, idempotencyKey: `key-${name}` },
      repoRoot: root,
    });
    await runClaim({ jobId: queued.job.id });
    await runFinish({
      jobId: queued.job.id,
      state: "awaiting_review",
      ...(extra.run === undefined ? {} : { run: extra.run }),
      ...(extra.costUsd === undefined ? {} : { costUsd: extra.costUsd }),
      ...(extra.turns === undefined ? {} : { turns: extra.turns }),
    });
    return queued.job.id;
  }

  async function link(assetId: string, jobId: string) {
    await scratch.db.insert(assetJob).values({ assetId, jobId, contentHash: "a".repeat(64), bytes: 1, ownerId: LOCAL_LEARNER_ID });
  }

  beforeAll(async () => {
    scratch = await migratedScratchDatabase();
    previousUrl = process.env["DATABASE_URL"];
    previousManim = process.env["MANIMKC_ROOT"];
    process.env["DATABASE_URL"] = scratch.url;
    process.env["MANIMKC_ROOT"] = path.join(tmpdir(), "no-manimkc-for-eval-report");
    root = await mkdtemp(path.join(tmpdir(), "eval-report-"));
    await mkdir(path.join(root, "learn", "assets"), { recursive: true });
    await writeFile(path.join(root, "learn", "assets", ".keep"), "");
    await scratch.db.insert(learner).values({ id: LOCAL_LEARNER_ID }).onConflictDoNothing();
    await scratch.db.insert(topic).values({ slug: "alpha", title: "Alpha", domain: "testing" });
  }, 60_000);

  afterAll(async () => {
    if (previousUrl === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = previousUrl;
    if (previousManim === undefined) delete process.env["MANIMKC_ROOT"];
    else process.env["MANIMKC_ROOT"] = previousManim;
    await rm(root, { recursive: true, force: true });
    await scratch?.drop();
  });

  it("answers an empty catalog with an empty report, not an error", async () => {
    const result = await runEvalReport({ owner: "nobody-here" });
    expect(result).toMatchObject({ ok: true, command: "eval report", owner: "nobody-here", libraryFound: false });
    expect(result.report.totals.videos).toBe(0);
    expect(result.report.byTool).toEqual([]);
    const text = formatEval(result);
    expect(text).toContain("No videos.");
    expect(text).toContain("library not found");
  });

  it("reads videos, ingredients, ratings and jobs into the report", async () => {
    await video(A);
    await video(B);
    await video(C);
    for (const [assetId, tool, over] of [
      [A, "manimkc", { variety: 0.5, uses3d: true }],
      [C, "remotionkc", { variety: 0.7, fadeShare: 0.25 }],
    ] as const) {
      await upsertAssetIngredients(scratch.db, {
        assetId,
        tool,
        scannerVersion: 1,
        sourceHash: "c".repeat(64),
        sceneCount: 3,
        durationSeconds: 61,
        calls: { FadeIn: 5, body: 4 },
        metrics: metrics(over),
      });
    }
    await rateAsset(scratch.db, { learnerId: LOCAL_LEARNER_ID, assetId: A, value: 1, tags: ["clear"], surface: "library" });
    await rateAsset(scratch.db, { learnerId: LOCAL_LEARNER_ID, assetId: B, value: -1, tags: ["same-look"], surface: "library" });
    // C was rated and then cleared: not a rating.
    await rateAsset(scratch.db, { learnerId: LOCAL_LEARNER_ID, assetId: C, value: 1, surface: "library" });
    await rateAsset(scratch.db, { learnerId: LOCAL_LEARNER_ID, assetId: C, value: 0, surface: "library" });

    // A's job has a run record; B's has none; C was made at a terminal, with no job.
    const jobA = await ready("job-a", { run: RUN, costUsd: 0.7, turns: 16 });
    await link(A, jobA);
    await runAccept({ jobId: jobA });
    const jobB = await ready("job-b", { costUsd: 0.2, turns: 4 });
    await link(B, jobB);
    await runAccept({ jobId: jobB });
    // Two jobs that made no video: a discard with tags, and a failure.
    const discarded = await ready("job-d", { run: { ...RUN, manualHash: "fedcba9876543210" }, costUsd: 1.1 });
    await runDiscard({ jobId: discarded, tags: ["same-look", "too-slow"] });
    const failedQueue = await runEnqueue({
      brief: { kind: "diagram", topic: "alpha", target: "learn/assets/job-f.tldr", idempotencyKey: "key-job-f" },
      repoRoot: root,
    });
    await runClaim({ jobId: failedQueue.job.id });
    await runFinish({ jobId: failedQueue.job.id, state: "failed", costUsd: 0.5, errorKind: "agent", error: "no" });
    // A job still running is not in the report.
    const running = await runEnqueue({
      brief: { kind: "diagram", topic: "alpha", target: "learn/assets/job-r.tldr", idempotencyKey: "key-job-r" },
      repoRoot: root,
    });
    await runClaim({ jobId: running.job.id });

    const { report, libraryFound } = await runEvalReport({});
    expect(libraryFound).toBe(false);

    const t = report.totals;
    expect(t.videos).toBe(3);
    expect(t.rated).toBe(2);
    expect([t.up, t.down, t.upShare]).toEqual([1, 1, 0.5]);
    expect(t.tagCounts.map((x) => x.tag).sort()).toEqual(["clear", "same-look"]);
    // Accepted: A and B. Discarded and failed are the two without a video.
    expect([t.accepted, t.discarded, t.failed, t.acceptRate]).toEqual([2, 1, 1, 0.5]);
    expect(t.discardTags).toEqual([
      { tag: "same-look", count: 1 },
      { tag: "too-slow", count: 1 },
    ]);
    expect(t.wastedUsd).toBe(1.6);
    expect(t.costUsd).toMatchObject({ n: 2, mean: 0.45 });
    expect(t.meanVariety).toBe(0.6);
    expect(t.uses3dShare).toBe(0.5);

    expect(report.byTool.map((g) => [g.key, g.videos])).toEqual([
      ["manimkc", 2],
      ["remotionkc", 1],
      ["tldrawkc", 0],
    ]);
    // The model is the resolved one from the run record; a job with no run has none.
    expect(report.byModel.map((g) => g.key)).toEqual(["(no job)", "claude-opus-5-5", "unknown"]);
    const opus = report.byModel.find((g) => g.key === "claude-opus-5-5")!;
    expect([opus.videos, opus.accepted, opus.discarded]).toEqual([1, 1, 1]);
    expect(report.byManual.map((g) => g.key)).toEqual(["(none)", "(no job)", "0123456789abcdef", "fedcba9876543210"].sort());
    expect(report.corpus.videosWithIngredients).toBe(2);
    expect(report.corpus.topCalls[0]).toMatchObject({ name: "FadeIn", calls: 10 });
  });

  it("prints the report as text and as the same object under --json", async () => {
    const result = await runEvalReport({});
    const text = formatEval(result);
    expect(text.indexOf("Totals")).toBeLessThan(text.indexOf("By tool"));
    expect(text.indexOf("By tool")).toBeLessThan(text.indexOf("By model"));
    expect(text.indexOf("By model")).toBeLessThan(text.indexOf("By prompt version"));
    expect(text.indexOf("By prompt version")).toBeLessThan(text.indexOf("Corpus calls"));
    expect(text).toContain("claude-opus-5-5");
    expect(text).toContain("01234567");
    expect(text).toContain("library not found");
    expect(text).not.toContain("—");

    const json = JSON.parse(JSON.stringify(result)) as typeof result;
    expect(Object.keys(json)).toEqual(["ok", "command", "owner", "libraryFound", "report"]);
    expect(Object.keys(json.report)).toEqual(["totals", "byTool", "byModel", "byManual", "corpus"]);
    expect(json.report.totals.videos).toBe(3);
  });

  it("fills the unused-helper list when manimkc's library is found", async () => {
    const checkout = path.join(root, "manimkc");
    await mkdir(path.join(checkout, "lib"), { recursive: true });
    await writeFile(path.join(checkout, "lib", "cslib.py"), "def body(s):\n    pass\n\ndef caption(s):\n    pass\n\ndef card(s):\n    pass\n");
    process.env["MANIMKC_ROOT"] = checkout;
    const result = await runEvalReport({});
    expect(result.libraryFound).toBe(true);
    expect(result.report.corpus.underusedHelpers).toEqual(["caption", "card"]);
    expect(formatEval(result)).not.toContain("library not found");
  });

  it("reads only what the owner can read", async () => {
    const other = await runEvalReport({ owner: "owner-b" });
    expect(other.report.totals.videos).toBe(0);
    expect(other.report.totals.accepted).toBe(0);
  });
});
