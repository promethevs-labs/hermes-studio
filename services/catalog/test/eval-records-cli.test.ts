import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { asset, assetJob, assetRating, job, learner, LOCAL_LEARNER_ID, topic, type JobRun } from "@hermes/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  runAccept,
  runClaim,
  runDiscard,
  runEnqueue,
  runFinish,
  runList,
  runReview,
  runShow,
  type BriefDocument,
} from "../src/commands/job";
import { formatRating, runRatingAdd, runRatingList } from "../src/commands/rating";
import { migratedScratchDatabase, probe, type Scratch } from "./scratch-database";

/**
 * The eval records at the catalog's CLI: `job finish --run-file` and
 * `job show`'s `run`, `job review` and the `--tags`/`--note` on accept and
 * discard, and `catalog rating add` and `ls`.
 *
 * The verbs are called as functions, as `studio.test.ts` calls its siblings,
 * and a few are spawned through the real CLI so the flags are parsed the way
 * a terminal or the studio's runner passes them.
 */

const reachable = await probe();
const OTHER = "owner-b";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.resolve(HERE, "..", "src", "cli.ts");

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

function cli(env: Record<string, string>, ...args: string[]): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", CATALOG, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const RUN: JobRun = {
  harness: { name: "claude", version: "2.1.319" },
  model: { passed: "sonnet", resolved: "claude-sonnet-5-5" },
  effort: "high",
  manualHash: "m1",
  auth: "login",
  attempts: [
    {
      n: 1,
      startedAt: "2026-11-20T10:00:00.000Z",
      endedAt: "2026-11-20T10:03:00.000Z",
      turns: 9,
      costUsd: 0.31,
      gate: { ok: true, steps: [{ name: "inspect", ok: true }], findings: 0, warnings: 1 },
    },
  ],
  calls: { "canvas run": 3 },
  renderSeconds: null,
  transcriptPath: "jobs/x/transcript.ndjson",
};

describe.skipIf(!reachable.ok)("the eval records at the CLI", () => {
  let scratch: Scratch;
  let previousUrl: string | undefined;
  let root: string;

  beforeAll(async () => {
    scratch = await migratedScratchDatabase();
    previousUrl = process.env["DATABASE_URL"];
    process.env["DATABASE_URL"] = scratch.url;
    root = await mkdtemp(path.join(tmpdir(), "eval-records-"));
    await mkdir(path.join(root, "learn", "assets"), { recursive: true });
    await scratch.db.insert(learner).values([{ id: LOCAL_LEARNER_ID }, { id: OTHER }]).onConflictDoNothing();
    await scratch.db.insert(topic).values({ slug: "alpha", title: "Alpha", domain: "testing" });
  }, 60_000);

  afterAll(async () => {
    if (previousUrl === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = previousUrl;
    await rm(root, { recursive: true, force: true });
    await scratch?.drop();
  });

  beforeEach(async () => {
    await scratch.db.delete(assetRating);
    await scratch.db.delete(assetJob);
    await scratch.db.delete(job);
    await scratch.db.delete(asset);
  });

  /** A job awaiting review under `name`, owned by `owner`. */
  async function readyJob(name: string, owner?: string): Promise<string> {
    const brief: BriefDocument = { kind: "diagram", topic: "alpha", target: `learn/assets/${name}.tldr`, idempotencyKey: `key-${name}` };
    const queued = await runEnqueue({ brief, repoRoot: root, ...(owner === undefined ? {} : { owner }) });
    await runClaim({ jobId: queued.job.id, ...(owner === undefined ? {} : { owner }) });
    await runFinish({ jobId: queued.job.id, state: "awaiting_review", ...(owner === undefined ? {} : { owner }) });
    return queued.job.id;
  }

  describe("job finish --run-file and job show", () => {
    it("stores a checked run record, shows it parsed, and leaves it alone on a finish without one", async () => {
      const queued = await runEnqueue({
        brief: { kind: "diagram", topic: "alpha", target: "learn/assets/ran.tldr", idempotencyKey: "key-ran" },
        repoRoot: root,
      });
      await runClaim({ jobId: queued.job.id });
      expect((await runShow(queued.job.id)).run).toBeNull();

      await runFinish({ jobId: queued.job.id, state: "awaiting_review", run: RUN });
      const shown = await runShow(queued.job.id);
      expect(shown.run).toEqual(RUN);
      expect(shown.review).toBeNull();

      // A later finish with no record (interrupted after review began) keeps the one stored.
      await runFinish({ jobId: queued.job.id, state: "interrupted" });
      expect((await runShow(queued.job.id)).run).toEqual(RUN);
      // `ls` keeps to the summary: no JSON columns in a list.
      const listed = await runList({});
      expect(Object.keys(listed.jobs[0]!)).not.toContain("run");
    });

    it("refuses a malformed record before it touches the row", async () => {
      const queued = await runEnqueue({
        brief: { kind: "diagram", topic: "alpha", target: "learn/assets/bad-run.tldr", idempotencyKey: "key-bad-run" },
        repoRoot: root,
      });
      await runClaim({ jobId: queued.job.id });
      await expect(
        runFinish({ jobId: queued.job.id, state: "awaiting_review", run: { ...RUN, transcriptPath: "/Users/me/.studio/x" } }),
      ).rejects.toThrow(/STUDIO_HOME/);
      await expect(runFinish({ jobId: queued.job.id, state: "awaiting_review", run: { ...RUN, extra: true } })).rejects.toThrow(
        /unknown fields: extra/,
      );
      const [row] = await scratch.db.select().from(job).where(eq(job.id, queued.job.id));
      expect(row?.state).toBe("running");
      expect(row?.run).toBeNull();
    });

    it("stores an attempt's critic as given, and refuses a score out of range", async () => {
      const queued = await runEnqueue({
        brief: { kind: "diagram", topic: "alpha", target: "learn/assets/judged.tldr", idempotencyKey: "key-judged" },
        repoRoot: root,
      });
      await runClaim({ jobId: queued.job.id });
      const critic = { model: null, costUsd: 0.01, scores: { accuracy: 4, layout: 5, relevance: 3, variety: 2, pacing: 4 }, defects: 2, notes: 0 };
      const judged: JobRun = { ...RUN, attempts: [{ ...RUN.attempts[0]!, critic }, { ...RUN.attempts[0]!, n: 2, critic: null }] };
      await expect(
        runFinish({
          jobId: queued.job.id,
          state: "awaiting_review",
          run: { ...judged, attempts: [{ ...RUN.attempts[0]!, critic: { ...critic, scores: { ...critic.scores, variety: 7 } } }] },
        }),
      ).rejects.toThrow(/attempts\[0\]\.critic\.scores\.variety/);
      await runFinish({ jobId: queued.job.id, state: "awaiting_review", run: judged });
      expect((await runShow(queued.job.id)).run).toEqual(judged);
    });
  });

  describe("job review", () => {
    it("writes a review dated now, replaces it on a second, and changes no state", async () => {
      const jobId = await readyJob("reviewed");
      const first = await runReview({ jobId, verdict: "revise", tags: ["too-slow", "too-slow"], note: "  tighten the intro " });
      expect(first.review).toMatchObject({ verdict: "revise", tags: ["too-slow"], note: "tighten the intro" });
      expect(Date.parse(first.review.at)).not.toBeNaN();
      expect(first.job.state).toBe("awaiting_review");

      await runReview({ jobId, verdict: "discard", tags: ["wrong"] });
      expect((await runShow(jobId)).review).toMatchObject({ verdict: "discard", tags: ["wrong"], note: null });
    });

    it("refuses an unknown verdict or tag, and another owner's job", async () => {
      const jobId = await readyJob("refused-review");
      await expect(runReview({ jobId, verdict: "maybe" })).rejects.toThrow(/verdict/);
      await expect(runReview({ jobId, verdict: "discard", tags: ["clear"] })).rejects.toThrow(/"clear" is not a tag/);
      await expect(runReview({ jobId, verdict: "discard", owner: OTHER })).rejects.toThrow(/no job/);
      expect((await runShow(jobId)).review).toBeNull();
    });
  });

  describe("accept and discard with --tags and --note", () => {
    it("writes the discard's review in the same update as the transition", async () => {
      const jobId = await readyJob("discarded");
      const discarded = await runDiscard({ jobId, tags: ["same-look"], note: "like the last three" });
      expect(discarded.to).toBe("discarded");
      expect((await runShow(jobId)).review).toMatchObject({ verdict: "discard", tags: ["same-look"], note: "like the last three" });
    });

    it("leaves the review alone on a verdict with neither flag", async () => {
      const jobId = await readyJob("plain-discard");
      await runReview({ jobId, verdict: "revise", note: "kept" });
      await runDiscard({ jobId });
      expect((await runShow(jobId)).review).toMatchObject({ verdict: "revise", note: "kept" });
    });

    it("refuses a bad tag on discard and leaves the job where it was", async () => {
      const jobId = await readyJob("bad-tag-discard");
      await expect(runDiscard({ jobId, tags: ["boring"] })).rejects.toThrow(/"boring" is not a tag/);
      expect((await runShow(jobId)).job.state).toBe("awaiting_review");
    });

    it("writes the accept's review once the outputs are there", async () => {
      const jobId = await readyJob("accepted");
      await scratch.db.insert(asset).values({ id: "link:accepted", kind: "link", url: "https://example.com", sourceRepo: "hermes" });
      await scratch.db.insert(assetJob).values({ assetId: "link:accepted", jobId, contentHash: "c".repeat(64), bytes: 1 });
      const accepted = await runAccept({ jobId, note: "good enough" });
      expect(accepted.to).toBe("accepted");
      expect((await runShow(jobId)).review).toMatchObject({ verdict: "accept", tags: [], note: "good enough" });
    });
  });

  describe("catalog rating", () => {
    it("adds ratings by word and lists the current one per asset, or one asset's history", async () => {
      await scratch.db.insert(asset).values([
        { id: "link:a", kind: "link", url: "https://example.com/a", sourceRepo: "hermes" },
        { id: "link:b", kind: "link", url: "https://example.com/b", sourceRepo: "hermes" },
      ]);
      const down = await runRatingAdd({ assetId: "link:a", value: "down", tags: ["too-much-text"], note: "a wall of words" });
      expect(down.rating).toMatchObject({ value: -1, surface: "library", tags: ["too-much-text"] });
      await runRatingAdd({ assetId: "link:a", value: "up", surface: "studio" });
      await runRatingAdd({ assetId: "link:b", value: "clear" });

      const current = await runRatingList({});
      expect(current.ratings.map((r) => [r.assetId, r.value, r.surface])).toEqual([
        ["link:b", 0, "library"],
        ["link:a", 1, "studio"],
      ]);
      const history = await runRatingList({ assetId: "link:a" });
      expect(history.ratings.map((r) => r.value)).toEqual([1, -1]);
      expect(formatRating(history)).toContain("Too much text");
      expect(formatRating(await runRatingList({ owner: OTHER }))).toBe("no ratings");
    });

    it("refuses a word it does not know, a surface, and a tag for the wrong value", async () => {
      await scratch.db.insert(asset).values({ id: "link:a", kind: "link", url: "https://example.com/a", sourceRepo: "hermes" });
      await expect(runRatingAdd({ assetId: "link:a", value: "meh" })).rejects.toThrow(/--value/);
      await expect(runRatingAdd({ assetId: "link:a", value: "up", surface: "email" })).rejects.toThrow(/--surface/);
      await expect(runRatingAdd({ assetId: "link:a", value: "up", tags: ["voice"] })).rejects.toThrow(RangeError);
      // --owner scopes the asset too: another owner cannot rate the CLI owner's link.
      await expect(runRatingAdd({ assetId: "link:a", value: "up", owner: OTHER })).rejects.toThrow(/No asset "link:a"/);
    });
  });

  describe("through the real CLI", () => {
    it("parses the rating, review and run-file flags", async () => {
      await scratch.db.insert(asset).values({ id: "link:cli", kind: "link", url: "https://example.com/cli", sourceRepo: "hermes" });
      const env = { DATABASE_URL: scratch.url, CATALOG_COPY_OK: "1" };

      const added = await cli(env, "rating", "add", "--asset", "link:cli", "--value", "down", "--tags", "voice, too-fast", "--note", "rushed", "--json");
      expect(added.code, added.stderr).toBe(0);
      expect(JSON.parse(added.stdout)).toMatchObject({ ok: true, command: "rating add", rating: { tags: ["voice", "too-fast"], note: "rushed" } });

      const listed = await cli(env, "rating", "ls", "--json");
      expect(listed.code, listed.stderr).toBe(0);
      expect((JSON.parse(listed.stdout) as { ratings: unknown[] }).ratings).toHaveLength(1);

      const bad = await cli(env, "rating", "add", "--asset", "link:cli", "--value", "sideways");
      expect(bad.code).toBe(2);

      const jobId = await readyJob("cli-review");
      const reviewed = await cli(env, "job", "review", "--job", jobId, "--verdict", "revise", "--tags", "too-long", "--json");
      expect(reviewed.code, reviewed.stderr).toBe(0);
      expect(JSON.parse(reviewed.stdout)).toMatchObject({ command: "review", review: { verdict: "revise", tags: ["too-long"] } });

      const runFile = path.join(root, "run.json");
      await writeFile(runFile, JSON.stringify(RUN));
      const queued = await runEnqueue({
        brief: { kind: "diagram", topic: "alpha", target: "learn/assets/cli-run.tldr", idempotencyKey: "key-cli-run" },
        repoRoot: root,
      });
      await runClaim({ jobId: queued.job.id });
      const finished = await cli(env, "job", "finish", "--job", queued.job.id, "--state", "awaiting_review", "--run-file", runFile, "--json");
      expect(finished.code, finished.stderr).toBe(0);
      const shown = await cli(env, "job", "show", "--job", queued.job.id, "--json");
      expect(JSON.parse(shown.stdout)).toMatchObject({ command: "show", run: RUN, review: null });
    }, 120_000);
  });
});
