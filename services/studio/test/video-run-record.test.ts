import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { until } from "./wait";

/**
 * The run record of a video job, end to end through the runner: a stand-in
 * `claude` that answers each spawn from a plan (its version, turns, cost,
 * the wrapper calls it leaves in `calls.ndjson`, a refused first request, a
 * session that hangs until it is cancelled), and a gate that answers from a
 * script. What is under test is what the runner writes down: one attempt
 * entry per spawn with its own gate summary, the `JobRun` it hands to
 * `job finish --run-file`, and a record that fails the check never failing
 * the job.
 *
 * The backend is manimkc's with the parts that need a real manimkc replaced,
 * as in `video-dead-tools-runner.test.ts`: no checkout is built and nothing
 * is sandboxed.
 */

// `config.ts` reads the CLI's path once, at import: never the real `claude`.
vi.hoisted(() => {
  process.env.STUDIO_CLAUDE_BIN = "/nonexistent/claude-until-the-fake-is-ready";
});

/** One spawn per entry of `plan.json`, the last repeated. */
const FAKE = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const here = path.dirname(process.argv[1]);
const argv = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(path.join(here, "plan.json"), "utf8"));
const countFile = path.join(here, "count");
const n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0;
fs.writeFileSync(countFile, String(n + 1));
const step = plan[Math.min(n, plan.length - 1)] || {};
const job = path.dirname(argv[argv.indexOf("--settings") + 1]);
const session = argv.includes("--resume") ? argv[argv.indexOf("--resume") + 1] : argv[argv.indexOf("--session-id") + 1];
const out = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const init = { type: "system", subtype: "init", session_id: session, tools: ["Bash"], mcp_servers: [], model: "claude-sonnet-5", apiKeySource: "none" };
if (step.version !== undefined) init.claude_code_version = step.version;
out(init);
for (const call of step.calls || []) fs.appendFileSync(path.join(job, "calls.ndjson"), JSON.stringify(call) + "\n");
const usage = { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 20 };
out({ type: "stream_event", event: { type: "message_start", message: { id: "msg_" + n, model: "claude-sonnet-5", usage } } });
out({ type: "assistant", message: { id: "msg_" + n, model: "claude-sonnet-5", role: "assistant", content: [{ type: "text", text: "working" }], usage } });
const finish = () => {
  out({ type: "result", subtype: step.refused ? "error_during_execution" : "success", is_error: !!step.refused, result: step.refused || "done", num_turns: step.turns === undefined ? 1 : step.turns, total_cost_usd: step.cost === undefined ? 0.01 : step.cost, usage });
  process.exit(0);
};
if (step.hangMs) setTimeout(finish, step.hangMs);
else finish();
`;

const fakeDir = await mkdtemp(path.join(tmpdir(), "fake-run-record-claude-"));
await writeFile(path.join(fakeDir, "claude"), FAKE, "utf8");
await chmod(path.join(fakeDir, "claude"), 0o755);
process.env.STUDIO_CLAUDE_BIN = path.join(fakeDir, "claude");

const catalogMock = vi.hoisted(() => ({
  jobEnqueue: vi.fn(),
  jobClaim: vi.fn(),
  jobFinish: vi.fn(),
  jobShow: vi.fn(),
  jobReview: vi.fn(),
  sessionStart: vi.fn(),
  sessionEnd: vi.fn(),
  videoShow: vi.fn(),
  videoCheckout: vi.fn(),
  preferenceGet: vi.fn(),
}));
vi.mock("../src/data/catalog", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/data/catalog")>()), ...catalogMock }));

/** The gate's verdicts, one per call, in order. */
const gateMock = vi.hoisted(() => ({ verdicts: [] as unknown[], runVideoGate: vi.fn() }));
vi.mock("../src/video/gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/video/gate")>()),
  runVideoGate: gateMock.runVideoGate,
}));

vi.mock("../src/video/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/video/backend")>();
  const real = actual.backendFor("manimkc");
  const backend: import("../src/video/backend").VideoBackend = {
    ...real,
    problems: () => [],
    async prepare(job) {
      await mkdir(job.paths.topicDir, { recursive: true });
      await mkdir(job.paths.tmp, { recursive: true });
    },
    async scaffold(job) {
      await writeFile(job.paths.sceneFile, "# the scenes\n", "utf8");
      return { prefix: "TB", classes: ["TB1_WhyItMatters", "TB2_Recap"] };
    },
    async wrapper(job) {
      await mkdir(job.paths.bin, { recursive: true });
      return "the listing";
    },
    settings: () => ({}) as ReturnType<typeof real.settings>,
    prompt: () => "make the video",
    gateTools: () => ({}) as ReturnType<typeof real.gateTools>,
  };
  return { ...actual, backendFor: () => backend };
});

const { CLAUDE_BIN } = await import("../src/config");
if (CLAUDE_BIN !== path.join(fakeDir, "claude")) throw new Error(`the runner would spawn ${CLAUDE_BIN}, not the stand-in`);
const { VideoRunner } = await import("../src/video/runner");
const { RecordStore } = await import("../src/data/store");
const { silentBrief } = await import("./video-fixture");
type VideoDoctorT = import("../src/video/doctor").VideoDoctor;
type VideoDoctorReportT = import("../src/video/doctor").VideoDoctorReport;
type VideoJobRecordT = import("../src/video/types").VideoJobRecord;
type ToolchainT = import("../src/video/toolchain").Toolchain;
type GateToolsT = import("../src/video/gate").GateTools;

const ok = (json: unknown = {}) => ({ ok: true, json, error: null, offline: false });

/** A gate result: two steps, the second the one that decides, with a finding when it fails and a warning either way. */
function verdict(pass: boolean): unknown {
  return {
    ok: pass,
    steps: [
      { name: "source", ok: true, detail: "the scene file changed" },
      { name: "length", ok: pass, detail: pass ? "60 s" : "scene two runs long" },
    ],
    findings: pass ? [] : ["scene two runs long"],
    warnings: ["a lint warning to keep"],
    script: null,
    sync: null,
    length: null,
    looked: null,
    copies: null,
    durationSeconds: pass ? 60 : null,
    checkedAt: new Date().toISOString(),
  };
}

const at = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

let home: string;
let store: InstanceType<typeof RecordStore<VideoJobRecordT>>;
let runner: InstanceType<typeof VideoRunner>;
const saved = { STUDIO_HOME: process.env.STUDIO_HOME, STUDIO_DAILY_USD: process.env.STUDIO_DAILY_USD, STUDIO_VIDEO_HANG_MS: process.env.STUDIO_VIDEO_HANG_MS };

function doctor(): VideoDoctorT {
  const report: VideoDoctorReportT = { ok: true, sandbox: true, metal: true, kokoro: true, voices: ["af_heart"], checks: [], checkedAt: new Date().toISOString() };
  return { report: async () => report, current: () => report, start: () => undefined, stop: () => undefined, noteToolchainStop: () => undefined } as unknown as VideoDoctorT;
}

async function plan(steps: Record<string, unknown>[]): Promise<void> {
  await writeFile(path.join(fakeDir, "plan.json"), JSON.stringify(steps), "utf8");
  await rm(path.join(fakeDir, "count"), { force: true });
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "studio-run-record-"));
  process.env.STUDIO_HOME = home;
  delete process.env.STUDIO_DAILY_USD;
  delete process.env.STUDIO_VIDEO_HANG_MS;
  await mkdir(path.join(home, "jobs"), { recursive: true });
  for (const mock of Object.values(catalogMock)) mock.mockReset();
  catalogMock.jobEnqueue.mockResolvedValue(ok({ job: {} }));
  catalogMock.jobClaim.mockResolvedValue(ok({ job: {} }));
  catalogMock.jobFinish.mockResolvedValue(ok());
  catalogMock.jobReview.mockResolvedValue(ok());
  catalogMock.sessionStart.mockResolvedValue(ok());
  catalogMock.sessionEnd.mockResolvedValue(ok());
  catalogMock.videoShow.mockResolvedValue(ok({ video: null }));
  catalogMock.preferenceGet.mockResolvedValue(ok({ value: null }));
  gateMock.verdicts = [];
  gateMock.runVideoGate.mockReset();
  gateMock.runVideoGate.mockImplementation(async () => gateMock.verdicts.shift() ?? verdict(true));
  store = new RecordStore<VideoJobRecordT>("video");
  runner = new VideoRunner(store, {
    doctor: doctor(),
    toolchain: async () => ({ node: process.execPath }) as unknown as ToolchainT,
    gateTools: () => ({}) as GateToolsT,
  });
});

afterEach(async () => {
  await runner.drain();
  await Promise.all(store.list().map((record) => runner.settled(record.id)));
  await rm(home, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterAll(async () => {
  await rm(fakeDir, { recursive: true, force: true });
});

/** Queue a silent video and wait until the runner has written everything about it. */
async function runToEnd(): Promise<VideoJobRecordT> {
  const { record } = await runner.enqueue({ ...silentBrief(), model: "sonnet", idempotencyKey: `run-record-${Date.now()}-${Math.random()}` });
  await until(() => ["failed", "awaiting_review", "cancelled"].includes(store.get(record.id)?.state ?? ""), () => `the job is still ${store.get(record.id)?.state}`, 30_000);
  await runner.settled(record.id);
  return store.get(record.id)!;
}

/** The `job finish` input for a job, the last one the runner sent. */
function finishOf(id: string): { state: string; runFile?: string } {
  const calls = catalogMock.jobFinish.mock.calls.map((call) => (call as unknown[])[0] as { jobId: string; state: string; runFile?: string });
  const mine = calls.filter((input) => input.jobId === id);
  expect(mine.length).toBeGreaterThan(0);
  return mine.at(-1)!;
}

describe("a video job's run record", () => {
  it("keeps one attempt per spawn with its own gate, and hands the whole run to job finish", async () => {
    await plan([
      { version: "2.1.300", turns: 3, cost: 0.02, calls: [{ verb: "api", startedAt: at(0), endedAt: at(0), exitCode: 0 }, { verb: "preview", scenes: ["TB1_WhyItMatters"], startedAt: at(0), endedAt: at(2_000), exitCode: 0, steps: [{ step: "render", exitCode: 0, ms: 1_500 }] }] },
      { version: "2.1.300", turns: 4, cost: 0.03, calls: [{ verb: "build", startedAt: at(0), endedAt: at(5_000), exitCode: 0, steps: [{ step: "render", exitCode: 0, ms: 2_500 }, { step: "narrate", exitCode: 0, ms: 1_000 }] }] },
    ]);
    gateMock.verdicts = [verdict(false), verdict(true)];
    const done = await runToEnd();

    expect(done.state).toBe("awaiting_review");
    expect(done.attempts).toEqual([
      {
        n: 1,
        startedAt: expect.any(String),
        endedAt: expect.any(String),
        turns: 3,
        costUsd: 0.02,
        gate: { ok: false, steps: [{ name: "source", ok: true }, { name: "length", ok: false }], findings: 1, warnings: 1 },
      },
      {
        n: 2,
        startedAt: expect.any(String),
        endedAt: expect.any(String),
        turns: 4,
        costUsd: 0.03,
        gate: { ok: true, steps: [{ name: "source", ok: true }, { name: "length", ok: true }], findings: 0, warnings: 1 },
      },
    ]);
    // Each attempt ends after it starts, and the second starts after the first ends.
    const [first, second] = done.attempts!;
    expect(Date.parse(first!.endedAt!)).toBeGreaterThanOrEqual(Date.parse(first!.startedAt!));
    expect(Date.parse(second!.startedAt!)).toBeGreaterThanOrEqual(Date.parse(first!.endedAt!));
    expect(done.harnessVersion).toBe("2.1.300");

    const finish = finishOf(done.id);
    expect(finish).toMatchObject({ state: "awaiting_review", runFile: path.join(home, "jobs", done.id, "run.json") });
    const run = JSON.parse(await readFile(finish.runFile!, "utf8")) as Record<string, unknown>;
    expect(run).toEqual({
      harness: { name: "claude-code", version: "2.1.300" },
      model: { passed: "sonnet", resolved: "claude-sonnet-5" },
      effort: done.agentEffort?.passed ?? null,
      manualHash: done.manualHash,
      auth: done.agentAuth,
      attempts: done.attempts,
      calls: { api: 1, preview: 1, build: 1 },
      // The render steps only: a preview's 1.5 s and a build's 2.5 s, not the build's narration.
      renderSeconds: 4,
      transcriptPath: `jobs/${done.id}/session.ndjson`,
    });
    expect(done.runRecordError ?? null).toBeNull();
  });

  it("still writes one for a job that failed on its first request", async () => {
    await plan([{ refused: "API Error: 400 This API key is not scoped to a workspace", turns: 1 }]);
    const done = await runToEnd();

    expect(done).toMatchObject({ state: "failed", errorKind: "agent" });
    expect(done.attempts).toHaveLength(1);
    expect(done.attempts![0]).toMatchObject({ n: 1, turns: 1, costUsd: 0.01, gate: null });
    expect(gateMock.runVideoGate).not.toHaveBeenCalled();
    const finish = finishOf(done.id);
    expect(finish.state).toBe("failed");
    const run = JSON.parse(await readFile(finish.runFile!, "utf8")) as { attempts: unknown[]; calls: unknown; renderSeconds: unknown; harness: unknown };
    expect(run.attempts).toEqual(done.attempts);
    // No wrapper call at all: nothing was measured, so no seconds.
    expect(run).toMatchObject({ calls: {}, renderSeconds: null, harness: { name: "claude-code", version: null } });
  });

  it("still writes one for a job cancelled mid-attempt, the attempt with no turns", async () => {
    await plan([{ version: "2.1.300", hangMs: 30_000 }]);
    const { record } = await runner.enqueue({ ...silentBrief(), model: "sonnet", idempotencyKey: `run-record-cancel-${Date.now()}` });
    await until(() => store.get(record.id)?.harnessVersion === "2.1.300", "the agent's init event never reached the record", 20_000);
    await runner.cancel(record.id);
    await until(() => store.get(record.id)?.state === "cancelled", () => `the job is ${store.get(record.id)?.state}`, 20_000);
    await runner.settled(record.id);
    const done = store.get(record.id)!;

    expect(done.attempts).toHaveLength(1);
    // Killed before its result, so it never said how many turns it took; the meter still priced what it streamed.
    expect(done.attempts![0]).toMatchObject({ n: 1, turns: null, gate: null });
    expect(done.attempts![0]!.costUsd).toBeGreaterThan(0);
    const finish = finishOf(done.id);
    expect(finish.state).toBe("cancelled");
    const run = JSON.parse(await readFile(finish.runFile!, "utf8")) as { attempts: unknown[] };
    expect(run.attempts).toEqual(done.attempts);
  });

  it("never fails the job over a record that fails the check: it finishes without one and says why", async () => {
    await plan([{ version: "v".repeat(600), turns: 2, cost: 0.02 }]);
    const done = await runToEnd();

    expect(done.state).toBe("awaiting_review");
    const finish = finishOf(done.id);
    expect(finish.state).toBe("awaiting_review");
    expect(finish.runFile).toBeUndefined();
    expect(done.runRecordError).toContain("harness.version");
    expect(existsSync(path.join(home, "jobs", done.id, "run.json"))).toBe(false);
  });

  it("finishes as before when the catalog refuses the finish", async () => {
    await plan([{ version: "2.1.300", turns: 2, cost: 0.02 }]);
    catalogMock.jobFinish.mockResolvedValue({ ok: false, json: null, error: "catalog job finish exited 1: --run-file: no", offline: false });
    const done = await runToEnd();

    expect(done.state).toBe("awaiting_review");
    expect(done.catalogErrors.at(-1)).toContain("--run-file: no");
  });
});
