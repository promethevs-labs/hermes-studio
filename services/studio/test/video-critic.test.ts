import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { until } from "./wait";

/**
 * The picture check (docs/STUDIO-VIDEOS.md, "The critic"), end to end
 * through the video runner with no paid call: one stand-in `claude` answers
 * both the video agent's spawns and the critic's (told apart by `--tools`),
 * the critic's from `critic-plan.json` (its reply, its init tools, a hang, a
 * refusal), and records each critic spawn's argv, working directory, stdin,
 * settings file and environment. The gate answers from a script, and the
 * backend is manimkc's with the parts that need a real manimkc replaced, its
 * sheets written by the scaffold under the job's `render/`.
 */

// `config.ts` reads the CLI's path once, at import: never the real `claude`.
vi.hoisted(() => {
  process.env.STUDIO_CLAUDE_BIN = "/nonexistent/claude-until-the-fake-is-ready";
});

const FAKE = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const here = path.dirname(process.argv[1]);
const argv = process.argv.slice(2);
const out = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const usage = { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 20 };
const next = (name) => {
  const file = path.join(here, name + "-count");
  const n = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0;
  fs.writeFileSync(file, String(n + 1));
  return n;
};
if (argv.includes("--tools")) {
  let stdin = "";
  process.stdin.on("data", (chunk) => (stdin += chunk));
  process.stdin.on("end", () => {
    const n = next("critic");
    const plan = JSON.parse(fs.readFileSync(path.join(here, "critic-plan.json"), "utf8"));
    const step = plan[Math.min(n, plan.length - 1)] || {};
    const settings = JSON.parse(fs.readFileSync(argv[argv.indexOf("--settings") + 1], "utf8"));
    fs.appendFileSync(
      path.join(here, "critic-calls.ndjson"),
      JSON.stringify({ argv, cwd: process.cwd(), stdin, settings, files: fs.readdirSync(process.cwd()), env: { apiKey: process.env.ANTHROPIC_API_KEY || null, tmp: process.env.CLAUDE_CODE_TMPDIR || null } }) + "\n",
    );
    out({ type: "system", subtype: "init", tools: step.tools || ["Read"], mcp_servers: [], model: "claude-sonnet-5", apiKeySource: "none" });
    out({ type: "assistant", message: { id: "critic_" + n, model: "claude-sonnet-5", role: "assistant", content: [{ type: "text", text: step.reply || "" }], usage } });
    const finish = () => {
      out({ type: "result", subtype: step.refused ? "error_during_execution" : "success", is_error: !!step.refused, result: step.refused || step.reply || "", num_turns: 2, total_cost_usd: step.cost === undefined ? 0.004 : step.cost, usage });
      process.exit(0);
    };
    if (step.hangMs) setTimeout(finish, step.hangMs);
    else finish();
  });
} else {
  const n = next("agent");
  const plan = JSON.parse(fs.readFileSync(path.join(here, "plan.json"), "utf8"));
  const step = plan[Math.min(n, plan.length - 1)] || {};
  const session = argv.includes("--resume") ? argv[argv.indexOf("--resume") + 1] : argv[argv.indexOf("--session-id") + 1];
  out({ type: "system", subtype: "init", session_id: session, tools: ["Bash"], mcp_servers: [], model: "claude-sonnet-5", apiKeySource: "none", claude_code_version: "2.1.300" });
  out({ type: "assistant", message: { id: "msg_" + n, model: "claude-sonnet-5", role: "assistant", content: [{ type: "text", text: "working" }], usage } });
  const finish = () => {
    out({ type: "result", subtype: step.refused ? "error_during_execution" : "success", is_error: !!step.refused, result: step.refused || "done", num_turns: step.turns === undefined ? 2 : step.turns, total_cost_usd: 0.01, usage });
    process.exit(0);
  };
  if (step.hangMs) setTimeout(finish, step.hangMs);
  else finish();
}
`;

const fakeDir = await mkdtemp(path.join(tmpdir(), "fake-critic-claude-"));
await writeFile(path.join(fakeDir, "claude"), FAKE, "utf8");
await chmod(path.join(fakeDir, "claude"), 0o755);
process.env.STUDIO_CLAUDE_BIN = path.join(fakeDir, "claude");

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("a contact sheet")]);
const CLASSES = ["TB1_WhyItMatters", "TB2_Recap"];

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

/** The gate's verdicts in order; `throwOn` makes the nth gate call throw, as a runner fault would. */
const gateMock = vi.hoisted(() => ({ verdicts: [] as boolean[], runVideoGate: vi.fn(), calls: 0, throwOn: 0 }));
vi.mock("../src/video/gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/video/gate")>()),
  runVideoGate: gateMock.runVideoGate,
}));

/** What the scaffold leaves under `render/` as each scene's sheet, and every prompt the agent was given. */
const backendMock = vi.hoisted(() => ({
  sheets: async (_dir: string): Promise<void> => undefined,
  prompts: [] as unknown[],
}));

vi.mock("../src/video/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/video/backend")>();
  const real = actual.backendFor("manimkc");
  const sheetDir = (paths: { render: string }) => path.join(paths.render, "sheets");
  const backend: import("../src/video/backend").VideoBackend = {
    ...real,
    problems: () => [],
    async prepare(job) {
      await mkdir(job.paths.topicDir, { recursive: true });
      await mkdir(job.paths.tmp, { recursive: true });
    },
    async scaffold(job) {
      await writeFile(job.paths.sceneFile, "# the scenes\n", "utf8");
      await mkdir(sheetDir(job.paths), { recursive: true });
      await backendMock.sheets(sheetDir(job.paths));
      return { prefix: "TB", classes: ["TB1_WhyItMatters", "TB2_Recap"] };
    },
    async wrapper(job) {
      await mkdir(job.paths.bin, { recursive: true });
      return "the listing";
    },
    settings: () => ({}) as ReturnType<typeof real.settings>,
    prompt: (request) => {
      backendMock.prompts.push(request);
      return "make the video";
    },
    gateTools: () => ({}) as ReturnType<typeof real.gateTools>,
    sheets: (paths, classes) =>
      classes.map((scene) => ({ id: scene, title: null, file: path.join(sheetDir(paths), `${scene}.sheet.png`), kept: `${scene}.sheet.png`, scenes: [scene] })),
  };
  return { ...actual, backendFor: () => backend };
});

const { CLAUDE_BIN } = await import("../src/config");
if (CLAUDE_BIN !== path.join(fakeDir, "claude")) throw new Error(`the runner would spawn ${CLAUDE_BIN}, not the stand-in`);
const { VideoRunner, FALLBACK_WARNING } = await import("../src/video/runner");
const { RecordStore } = await import("../src/data/store");
const { videoJobRoutes, videoView } = await import("../src/video/routes");
const critic = await import("../src/video/critic");
const { checkJobRun } = await import("@hermes/schema/shared");
const { silentBrief } = await import("./video-fixture");
type VideoDoctorT = import("../src/video/doctor").VideoDoctor;
type VideoDoctorReportT = import("../src/video/doctor").VideoDoctorReport;
type VideoJobRecordT = import("../src/video/types").VideoJobRecord;
type ToolchainT = import("../src/video/toolchain").Toolchain;
type GateToolsT = import("../src/video/gate").GateTools;
type SpendEntryT = import("../src/cost").SpendEntry;

const ok = (json: unknown = {}) => ({ ok: true, json, error: null, offline: false });

/** What the gate's step 5 leaves in `candidate/` for gate call `n`: every file names its call. */
const candidateFiles = (n: number): Record<string, string> => ({
  "two-boxes.mp4": `the video of gate call ${n}`,
  "two-boxes.vtt": `the captions of gate call ${n}`,
  "poster.jpg": `the poster of gate call ${n}`,
  "copies.json": JSON.stringify({ call: n }),
  "source/scenes.py": `# the source of gate call ${n}\n`,
  "source/topic.yml": `topic: networks # ${n}\n`,
  "source/brief.json": "{}\n",
});

/** Step 5's way: `candidate/` deleted and rebuilt, whole on a pass and partial on a fail. */
async function writeCandidate(candidate: string, n: number, pass: boolean): Promise<void> {
  await rm(candidate, { recursive: true, force: true });
  await mkdir(path.join(candidate, "source"), { recursive: true });
  if (!pass) return void (await writeFile(path.join(candidate, "partial.mp4"), `half a video from gate call ${n}`));
  for (const [name, body] of Object.entries(candidateFiles(n))) await writeFile(path.join(candidate, name), body);
}

function verdict(pass: boolean, n?: number): unknown {
  return {
    ok: pass,
    steps: [{ name: "length", ok: pass, detail: pass ? "60 s" : "scene two runs long" }],
    findings: pass ? [] : ["scene two runs long"],
    warnings: [],
    script: pass && n !== undefined ? { classes: CLASSES, changes: [{ scene: CLASSES[0], kind: "reworded", brief: "A request starts.", voiced: [`as voiced on gate call ${n}`] }] } : null,
    sync: null,
    length: null,
    looked: null,
    copies: null,
    durationSeconds: pass ? 60 : null,
    checkedAt: new Date().toISOString(),
  };
}

const SCORES = { accuracy: 4, layout: 3, relevance: 5, variety: 2, pacing: 4 };

/** A critic reply: one fenced block, with prose before it as a model writes. */
function reply(over: Record<string, unknown> = {}): string {
  return `I read both sheets.\n\n\`\`\`critic\n${JSON.stringify({ scores: SCORES, defects: [], notes: ["the two scenes share one layout"], ...over })}\n\`\`\``;
}

const DEFECT = { scene: "TB1_WhyItMatters", problem: "The title overlaps the axis label.", fix: "Move the title up." };

let home: string;
let store: InstanceType<typeof RecordStore<VideoJobRecordT>>;
let runner: InstanceType<typeof VideoRunner>;
let extraSpend: SpendEntryT[];
const saved = Object.fromEntries(
  ["STUDIO_HOME", "STUDIO_DAILY_USD", "STUDIO_VIDEO_CRITIC", "STUDIO_VIDEO_CRITIC_TIMEOUT_MS", "STUDIO_VIDEO_CRITIC_MODEL", "STUDIO_VIDEO_HANG_MS", "ANTHROPIC_API_KEY"].map((key) => [key, process.env[key]]),
);

function doctor(): VideoDoctorT {
  const report: VideoDoctorReportT = { ok: true, sandbox: true, metal: true, kokoro: true, voices: ["af_heart"], checks: [], checkedAt: new Date().toISOString() };
  return { report: async () => report, current: () => report, start: () => undefined, stop: () => undefined, noteToolchainStop: () => undefined } as unknown as VideoDoctorT;
}

async function plans(agent: Record<string, unknown>[], critics: Record<string, unknown>[]): Promise<void> {
  await writeFile(path.join(fakeDir, "plan.json"), JSON.stringify(agent), "utf8");
  await writeFile(path.join(fakeDir, "critic-plan.json"), JSON.stringify(critics), "utf8");
  for (const name of ["agent-count", "critic-count", "critic-calls.ndjson"]) await rm(path.join(fakeDir, name), { force: true });
}

interface CriticCallRecord {
  argv: string[];
  cwd: string;
  stdin: string;
  settings: { permissions: { allow: string[]; deny: string[]; blockReadsOutsideWorkingDirectories: boolean; defaultMode: string } };
  files: string[];
  env: { apiKey: string | null; tmp: string | null };
}

async function criticCalls(): Promise<CriticCallRecord[]> {
  const body = await readFile(path.join(fakeDir, "critic-calls.ndjson"), "utf8").catch(() => "");
  return body
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as CriticCallRecord);
}

async function agentSpawns(): Promise<number> {
  return Number(await readFile(path.join(fakeDir, "agent-count"), "utf8").catch(() => "0"));
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "studio-critic-"));
  process.env.STUDIO_HOME = home;
  for (const key of Object.keys(saved)) if (key !== "STUDIO_HOME") delete process.env[key];
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
  gateMock.calls = 0;
  gateMock.throwOn = 0;
  gateMock.runVideoGate.mockImplementation(async (input: { paths: { candidate: string } }) => {
    gateMock.calls += 1;
    const n = gateMock.calls;
    if (gateMock.throwOn === n) throw new Error("the gate fell over");
    const pass = gateMock.verdicts.shift() ?? true;
    await writeCandidate(input.paths.candidate, n, pass);
    return verdict(pass, n);
  });
  backendMock.prompts = [];
  backendMock.sheets = async (dir) => {
    for (const scene of CLASSES) await writeFile(path.join(dir, `${scene}.sheet.png`), PNG);
  };
  extraSpend = [];
  store = new RecordStore<VideoJobRecordT>("video");
  runner = new VideoRunner(store, {
    doctor: doctor(),
    otherSpend: () => extraSpend,
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

async function enqueue(): Promise<string> {
  const { record } = await runner.enqueue({ ...silentBrief(), model: "sonnet", idempotencyKey: `critic-${Date.now()}-${Math.random()}` });
  return record.id;
}

async function toEnd(id: string): Promise<VideoJobRecordT> {
  await until(() => ["failed", "awaiting_review", "cancelled"].includes(store.get(id)?.state ?? ""), () => `the job is still ${store.get(id)?.state}`, 30_000);
  await runner.settled(id);
  return store.get(id)!;
}

const runToEnd = async (): Promise<VideoJobRecordT> => toEnd(await enqueue());

function lastRunFile(id: string): string | undefined {
  const calls = catalogMock.jobFinish.mock.calls.map((call) => (call as unknown[])[0] as { jobId: string; runFile?: string });
  return calls.filter((input) => input.jobId === id).at(-1)?.runFile;
}

describe("the picture check in the job loop", () => {
  it("scores a build that passed the gate: on the attempt, in the run record, in job.json, and never on the job's cost", async () => {
    await plans([{}], [{ reply: reply(), cost: 0.004 }]);
    const done = await runToEnd();

    expect(done.state).toBe("awaiting_review");
    expect(await agentSpawns()).toBe(1);
    expect(done.attempts).toHaveLength(1);
    expect(done.attempts![0]!.critic).toEqual({ model: "claude-sonnet-5", costUsd: 0.004, scores: SCORES, defects: 0, notes: 1 });
    // The whole text on the record, with the copies it read.
    expect(done.critic).toHaveLength(1);
    expect(done.critic![0]).toMatchObject({ attempt: 1, standalone: false, scores: SCORES, defects: [], notes: ["the two scenes share one layout"], error: null, sentBack: false, calls: 1 });
    expect(done.critic![0]!.sheets.map((sheet) => sheet.id)).toEqual(CLASSES);
    for (const sheet of done.critic![0]!.sheets) expect(sheet.file.startsWith(path.join(home, "jobs", done.id, "critic", "attempt-1", "sheets"))).toBe(true);
    const onDisk = JSON.parse(await readFile(path.join(home, "jobs", done.id, "job.json"), "utf8")) as VideoJobRecordT;
    expect(onDisk.critic?.[0]?.scores).toEqual(SCORES);

    // The run record the catalog is handed carries it, and passes its check.
    const runFile = lastRunFile(done.id);
    expect(runFile).toBeDefined();
    const run = JSON.parse(await readFile(runFile!, "utf8")) as unknown;
    const checked = checkJobRun(run);
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.run.attempts[0]!.critic?.scores).toEqual(SCORES);

    // The job's cost is the agent's alone; the critic's counts in the window.
    expect(done.costUsd).toBe(0.01);
    expect(runner.spend().totalUsd).toBeCloseTo(0.014, 6);
    expect(done.steps.find((step) => step.name === "critic")).toMatchObject({ state: "done", rounds: 1 });
    expect(videoView(done).critic).toEqual({ attempt: 1, attempts: 1, scores: SCORES, defects: [], notes: ["the two scenes share one layout"], sentBack: [] });
  });

  it("sends defects back once, as the next attempt's findings, and never again", async () => {
    await plans([{}, {}], [{ reply: reply({ defects: [DEFECT] }) }, { reply: reply({ defects: [{ ...DEFECT, scene: "recap", problem: "A label runs off the right edge.", fix: "Shorten it." }] }) }]);
    const done = await runToEnd();

    expect(done.state).toBe("awaiting_review");
    expect(await agentSpawns()).toBe(2);
    expect(await criticCalls()).toHaveLength(2);
    expect(backendMock.prompts[1]).toMatchObject({ kind: "retry", findings: ["Scene TB1_WhyItMatters: The title overlaps the axis label. Fix: Move the title up."] });
    expect(done.critic!.map((run) => [run.attempt, run.sentBack, run.defects.length])).toEqual([
      [1, true, 1],
      [2, false, 1],
    ]);
    // A scene named by the brief's name is kept as its class.
    expect(done.critic![1]!.defects[0]!.scene).toBe("TB2_Recap");
    expect(done.attempts!.map((attempt) => attempt.critic?.defects)).toEqual([1, 1]);
    expect(videoView(done).critic).toMatchObject({ attempt: 2, attempts: 2, sentBack: [DEFECT], defects: [{ scene: "TB2_Recap" }] });
  });

  it("sends nothing back when fewer than two attempts would be left after it", async () => {
    await plans([{}, {}], [{ reply: reply({ defects: [DEFECT] }) }]);
    gateMock.verdicts = [false, true];
    const done = await runToEnd();

    expect(done.state).toBe("awaiting_review");
    expect(await agentSpawns()).toBe(2);
    expect(await criticCalls()).toHaveLength(1);
    expect(done.critic).toMatchObject([{ attempt: 2, sentBack: false, defects: [DEFECT] }]);
    expect(videoView(done).critic).toMatchObject({ defects: [DEFECT], sentBack: [] });
  });

  it("in report mode scores and never sends anything back", async () => {
    process.env.STUDIO_VIDEO_CRITIC = "report";
    await plans([{}], [{ reply: reply({ defects: [DEFECT] }) }]);
    const done = await runToEnd();

    expect(await agentSpawns()).toBe(1);
    expect(done.state).toBe("awaiting_review");
    expect(done.critic).toMatchObject([{ attempt: 1, sentBack: false, defects: [DEFECT] }]);
  });

  it("off, never spawns, and the job view has no such step", async () => {
    process.env.STUDIO_VIDEO_CRITIC = "off";
    await plans([{}], [{ reply: reply() }]);
    const done = await runToEnd();

    expect(done.state).toBe("awaiting_review");
    expect(await criticCalls()).toHaveLength(0);
    expect(done.critic).toBeUndefined();
    expect(Object.hasOwn(done.attempts![0]!, "critic")).toBe(false);
    expect(done.steps.some((step) => step.name === "critic")).toBe(false);
    expect(videoView(done).critic).toBeNull();
  });

  it("asks once more after an unusable reply, in the same session, naming what was wrong", async () => {
    await plans([{}], [{ reply: "```critic\n{\"scores\":{\"accuracy\":9}}\n```" }, { reply: reply() }]);
    const done = await runToEnd();

    const calls = await criticCalls();
    expect(calls).toHaveLength(2);
    const sessionId = calls[0]!.argv[calls[0]!.argv.indexOf("--session-id") + 1];
    expect(calls[1]!.argv.slice(-2)).toEqual(["--resume", sessionId]);
    expect(calls[1]!.stdin).toContain("scores.accuracy is a whole number from 1 to 5");
    expect(calls[1]!.stdin).toContain("defects is a list");
    expect(done.critic![0]).toMatchObject({ scores: SCORES, calls: 2, error: null });
    // Both calls' cost.
    expect(done.critic![0]!.costUsd).toBeCloseTo(0.008, 6);
  });

  it("gives no scores after a second unusable reply, and the job goes on to review", async () => {
    await plans([{}], [{ reply: "no block at all" }, { reply: reply({ defects: [{ ...DEFECT, scene: "NoSuchScene" }] }) }]);
    const done = await runToEnd();

    expect(done.state).toBe("awaiting_review");
    expect(done.critic![0]).toMatchObject({ scores: null, calls: 2, error: expect.stringContaining("twice") });
    expect(done.critic![0]!.error).toContain("defects[0].scene is one of the brief's scenes");
    // It ran, and gave none: null on the attempt, which the run record takes.
    expect(done.attempts![0]!.critic).toBeNull();
    expect(checkJobRun(JSON.parse(await readFile(lastRunFile(done.id)!, "utf8"))).ok).toBe(true);
    expect(videoView(done).critic).toBeNull();
  });

  it("stops a critic that does not answer in time", async () => {
    process.env.STUDIO_VIDEO_CRITIC_TIMEOUT_MS = "1000";
    await plans([{}], [{ reply: reply(), hangMs: 30_000 }]);
    const done = await runToEnd();

    expect(done.state).toBe("awaiting_review");
    expect(await criticCalls()).toHaveLength(1);
    expect(done.critic![0]).toMatchObject({ scores: null, calls: 1, error: "the critic did not answer within 1 s" });
  });

  it("records a refused first request and asks nothing more", async () => {
    await plans([{}], [{ refused: "API Error: 400 This model is not available" }]);
    const done = await runToEnd();

    expect(await criticCalls()).toHaveLength(1);
    expect(done.critic![0]!.error).toContain("API Error: 400");
    expect(done.state).toBe("awaiting_review");
  });

  it("stops a critic whose init lists any tool but Read", async () => {
    await plans([{}], [{ reply: reply(), tools: ["Read", "Bash"], hangMs: 30_000 }]);
    const started = Date.now();
    const done = await runToEnd();

    expect(Date.now() - started).toBeLessThan(20_000);
    expect(done.critic![0]).toMatchObject({ scores: null, calls: 1 });
    expect(done.critic![0]!.error).toContain("1 tool(s) besides Read");
    expect(done.critic![0]!.error).toContain("Bash");
    expect(done.state).toBe("awaiting_review");
  });

  it("is skipped when the daily cap is already reached, and says why", async () => {
    process.env.STUDIO_DAILY_USD = "1";
    await plans([{ hangMs: 800 }], [{ reply: reply() }]);
    const id = await enqueue();
    // Over the cap after the job was let in, before its gate passes.
    extraSpend.push({ startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), costUsd: 5 });
    const done = await toEnd(id);

    expect(done.state).toBe("awaiting_review");
    expect(await criticCalls()).toHaveLength(0);
    expect(done.critic![0]).toMatchObject({ scores: null, calls: 0, error: expect.stringContaining("STUDIO_DAILY_USD") });
    expect(Object.hasOwn(done.attempts![0]!, "critic")).toBe(false);
  });

  it("runs no critic when no sheet survives the copy, and names each one", async () => {
    backendMock.sheets = async (dir) => {
      await writeFile(path.join(home, "elsewhere.png"), PNG);
      await symlink(path.join(home, "elsewhere.png"), path.join(dir, `${CLASSES[0]}.sheet.png`));
      await writeFile(path.join(dir, `${CLASSES[1]}.sheet.png`), "not a picture");
    };
    await plans([{}], [{ reply: reply() }]);
    const done = await runToEnd();

    expect(await criticCalls()).toHaveLength(0);
    expect(done.critic![0]).toMatchObject({ scores: null, calls: 0, error: "no contact sheet could be read safely" });
    expect(done.critic![0]!.skipped).toEqual([
      { id: CLASSES[0], reason: expect.stringContaining("symbolic link") },
      { id: CLASSES[1], reason: expect.stringContaining("is not a PNG") },
    ]);
    expect(Object.hasOwn(done.attempts![0]!, "critic")).toBe(false);
  });

  it("stops the critic on a cancel, and the job ends cancelled", async () => {
    await plans([{}], [{ reply: reply(), hangMs: 30_000 }]);
    const id = await enqueue();
    await until(() => existsSync(path.join(fakeDir, "critic-calls.ndjson")), "the critic never started", 20_000);
    expect(store.get(id)?.phase).toBe("critic");
    expect(store.get(id)?.steps.find((step) => step.name === "critic")?.state).toBe("running");
    const started = Date.now();
    await runner.cancel(id);
    const done = await toEnd(id);

    expect(Date.now() - started).toBeLessThan(15_000);
    expect(done.state).toBe("cancelled");
    expect(done.critic![0]).toMatchObject({ scores: null, error: expect.stringContaining("cancelled") });
    expect(await agentSpawns()).toBe(1);
  });
});

describe("falling back to the build that passed", () => {
  const job = (id: string, ...parts: string[]) => path.join(home, "jobs", id, ...parts);

  /** The fallback's promise: attempt 1's build in review, said so, and the retry's own ending kept. */
  async function expectFellBack(done: VideoJobRecordT, retry: { kind: string; error?: string }): Promise<void> {
    expect(done.state).toBe("awaiting_review");
    expect(done.error).toBeNull();
    expect(done.errorKind).toBeNull();
    expect(done.fallback).toMatchObject({ attempt: 1, retryErrorKind: retry.kind });
    if (retry.error !== undefined) expect(done.fallback!.retryError).toContain(retry.error);
    // candidate/ is attempt 1's, byte for byte, and nothing of the retry's is left in it.
    for (const [name, body] of Object.entries(candidateFiles(1))) expect(await readFile(job(done.id, "candidate", name), "utf8")).toBe(body);
    expect(existsSync(job(done.id, "candidate", "partial.mp4"))).toBe(false);
    expect(existsSync(job(done.id, "candidate.passed"))).toBe(false);
    expect(done.passedBuild ?? null).toBeNull();
    // Its gate and lines, with a warning the card shows.
    expect(done.gate!.ok).toBe(true);
    expect(done.gate!.warnings).toContain(FALLBACK_WARNING);
    expect(done.lineChanges[0]!.voiced).toEqual(["as voiced on gate call 1"]);
    // Its defects are open, not sent back.
    expect(videoView(done).critic).toMatchObject({ attempt: 1, defects: [DEFECT], sentBack: [] });
    expect(videoView(done).fallback).toMatchObject({ attempt: 1 });
    // The run record keeps every attempt as it was, and passes its check.
    expect(done.attempts![0]).toMatchObject({ n: 1, gate: { ok: true }, critic: { defects: 1 } });
    expect(checkJobRun(JSON.parse(await readFile(lastRunFile(done.id)!, "utf8"))).ok).toBe(true);
    const finishes = catalogMock.jobFinish.mock.calls.map((call) => (call as unknown[])[0] as { jobId: string; state: string });
    expect(finishes.filter((input) => input.jobId === done.id).map((input) => input.state)).toEqual(["awaiting_review"]);
    const events = await readFile(job(done.id, "session.ndjson"), "utf8");
    expect(events).toContain("so attempt 1's build goes to review");
  }

  it("goes to review with the earlier build when the retry fails the gate on every attempt left, its source and sheets kept from that build", async () => {
    await plans([{}, {}, {}], [{ reply: reply({ defects: [DEFECT] }) }]);
    gateMock.verdicts = [true, false, false];
    const done = await runToEnd();

    expect(await agentSpawns()).toBe(3);
    expect(done.attempts!.map((attempt) => attempt.gate?.ok)).toEqual([true, false, false]);
    await expectFellBack(done, { kind: "gate", error: "scene two runs long" });

    // Accept's cleanup keeps the restored build's source and the critic's copies of its sheets.
    await rm(job(done.id, "render", "sheets", `${CLASSES[0]}.sheet.png`), { force: true });
    await writeFile(job(done.id, "render", "sheets", `${CLASSES[1]}.sheet.png`), Buffer.concat([PNG, Buffer.from(" of the retry")]));
    await runner.cleanup(done, { candidate: false });
    expect(await readFile(job(done.id, "source", "scenes.py"), "utf8")).toBe("# the source of gate call 1\n");
    expect(existsSync(job(done.id, "source", "brief.json"))).toBe(false);
    for (const scene of CLASSES) expect(await readFile(job(done.id, "sheets", `${scene}.sheet.png`))).toEqual(PNG);
  });

  it("goes to review with the earlier build when the retry's first request is refused", async () => {
    await plans([{}, { refused: "API Error: 529 Overloaded", turns: 1 }], [{ reply: reply({ defects: [DEFECT] }) }]);
    const done = await runToEnd();

    expect(await agentSpawns()).toBe(2);
    await expectFellBack(done, { kind: "agent", error: "API Error: 529" });
  });

  it("goes to review with the earlier build when the runner throws during the retry", async () => {
    await plans([{}, {}], [{ reply: reply({ defects: [DEFECT] }) }]);
    gateMock.throwOn = 2;
    const done = await runToEnd();

    await expectFellBack(done, { kind: "internal", error: "the gate fell over" });
  });

  it("goes to review with the earlier build when the retry hangs", async () => {
    process.env.STUDIO_VIDEO_HANG_MS = "30000";
    await plans([{}, { hangMs: 120_000 }], [{ reply: reply({ defects: [DEFECT] }) }]);
    const id = await enqueue();
    await until(() => store.get(id)?.state === "awaiting_review" || store.get(id)?.state === "failed", () => `the job is still ${store.get(id)?.state}`, 60_000);
    await runner.settled(id);

    await expectFellBack(store.get(id)!, { kind: "timeout", error: "ran no command" });
  }, 90_000);

  it("never falls back on a cancel during the retry", async () => {
    await plans([{}, { hangMs: 30_000 }], [{ reply: reply({ defects: [DEFECT] }) }]);
    const id = await enqueue();
    await until(() => existsSync(path.join(fakeDir, "agent-count")) && readFileSync(path.join(fakeDir, "agent-count"), "utf8") === "2", "the retry never started", 20_000);
    await runner.cancel(id);
    const done = await toEnd(id);

    expect(done.state).toBe("cancelled");
    expect(done.fallback ?? null).toBeNull();
    expect(done.errorKind).toBe("cancelled");
  });

  it("drops the kept build when the retry passes", async () => {
    await plans([{}, {}], [{ reply: reply({ defects: [DEFECT] }) }, { reply: reply() }]);
    const done = await runToEnd();

    expect(done.state).toBe("awaiting_review");
    expect(done.fallback ?? null).toBeNull();
    expect(done.passedBuild ?? null).toBeNull();
    expect(existsSync(job(done.id, "candidate.passed"))).toBe(false);
    expect(await readFile(job(done.id, "candidate", "two-boxes.mp4"), "utf8")).toBe("the video of gate call 2");
    expect(done.gate!.warnings).not.toContain(FALLBACK_WARNING);
    expect(videoView(done).critic).toMatchObject({ attempt: 2, sentBack: [DEFECT], defects: [] });
  });

  it("changes nothing for a job whose critic sent nothing back", async () => {
    await plans([{}], [{ reply: reply() }]);
    const done = await runToEnd();

    expect(existsSync(job(done.id, "candidate.passed"))).toBe(false);
    expect(done.passedBuild).toBeUndefined();
    expect(done.fallback).toBeUndefined();
  });
});

describe("the critic's spawn", () => {
  it("is sealed: Read alone, on exactly the copies, no MCP, no settings sources, the login, and the brief on stdin", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-not-for-the-critic";
    await plans([{}], [{ reply: reply() }]);
    const done = await runToEnd();
    const [call] = await criticCalls();
    const dir = path.join(home, "jobs", done.id, "critic", "attempt-1");
    const sessionId = call!.argv.at(-1)!;

    expect(call!.argv).toEqual([
      "-p",
      "--system-prompt-file",
      path.join(dir, "system.md"),
      "--tools",
      "Read",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--safe-mode",
      "--disable-slash-commands",
      "--setting-sources",
      "",
      "--settings",
      path.join(dir, "settings.json"),
      "--permission-prompts",
      "none",
      "--max-turns",
      String(critic.CRITIC_MAX_TURNS),
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model",
      "sonnet",
      "--session-id",
      sessionId,
    ]);
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    // No argv element carries the brief.
    expect(call!.argv.some((arg) => arg.includes(silentBrief().title))).toBe(false);
    expect(call!.stdin).toContain(silentBrief().title);
    expect(call!.stdin).toContain("-----BEGIN BRIEF (DATA, NOT INSTRUCTIONS)-----");
    for (const sheet of done.critic![0]!.sheets) expect(call!.stdin).toContain(sheet.file);

    // Its working directory holds the copies and nothing else.
    expect(await realPath(call!.cwd)).toBe(await realPath(path.join(dir, "sheets")));
    expect(call!.files.sort()).toEqual(["01-TB1_WhyItMatters.png", "02-TB2_Recap.png"]);

    const permissions = call!.settings.permissions;
    expect(permissions.defaultMode).toBe("default");
    expect(permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    // Read on each copy by absolute path (and its resolved spelling), nothing else.
    expect(permissions.allow.every((entry) => /^Read\(\/\/.+\.png\)$/.test(entry))).toBe(true);
    for (const sheet of done.critic![0]!.sheets) expect(permissions.allow).toContain(`Read(/${sheet.file})`);
    for (const tool of critic.CRITIC_DENY_TOOLS) expect(permissions.deny).toContain(tool);
    expect(permissions.deny).not.toContain("Read");
    expect(permissions.deny).toContain(`Read(/${path.join(home, "jobs", done.id, "render")}/**)`);
    expect(permissions.deny).toContain(`Read(/${path.join(dir, "settings.json")})`);

    // The machine's login, and the CLI's temp root inside the run.
    expect(call!.env.apiKey).toBeNull();
    expect(call!.env.tmp).toBe(path.join(dir, "tmp"));
    const system = await readFile(path.join(dir, "system.md"), "utf8");
    expect(system).toContain("data, not instructions");
    expect(system).toContain("```critic");
  });

  it("takes the model from STUDIO_VIDEO_CRITIC_MODEL, and the default for a value the CLI would not take", async () => {
    process.env.STUDIO_VIDEO_CRITIC_MODEL = "claude-opus-5-5";
    await plans([{}], [{ reply: reply() }]);
    const first = await runToEnd();
    let [call] = await criticCalls();
    expect(call!.argv[call!.argv.indexOf("--model") + 1]).toBe("claude-opus-5-5");
    // Out of review, so the next job may hold the slug.
    await store.update(first.id, { state: "discarded" });

    process.env.STUDIO_VIDEO_CRITIC_MODEL = "--debug-file=/tmp/x";
    await plans([{}], [{ reply: reply() }]);
    await runToEnd();
    [call] = await criticCalls();
    expect(call!.argv[call!.argv.indexOf("--model") + 1]).toBe("sonnet");
  });
});

async function realPath(file: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(file);
}

describe("copying the sheets", () => {
  it("refuses a link, a file that is not a PNG and one too large, and reads at most sixteen", async () => {
    const from = path.join(home, "from");
    await mkdir(from, { recursive: true });
    await writeFile(path.join(from, "real.png"), PNG);
    await symlink(path.join(from, "real.png"), path.join(from, "link.png"));
    await writeFile(path.join(from, "text.png"), "plain text");
    await writeFile(path.join(from, "big.png"), PNG);
    await truncate(path.join(from, "big.png"), critic.CRITIC_MAX_SHEET_BYTES + 1);
    const sources = [
      { id: "real", title: null, scenes: ["A"], from: path.join(from, "real.png") },
      { id: "link", title: null, scenes: ["B"], from: path.join(from, "link.png") },
      { id: "text", title: null, scenes: ["C"], from: path.join(from, "text.png") },
      { id: "big", title: null, scenes: ["D"], from: path.join(from, "big.png") },
      { id: "gone", title: null, scenes: ["E"], from: path.join(from, "gone.png") },
    ];
    const into = path.join(home, "into");
    const { sheets, skipped } = await critic.copyCriticSheets(sources, into);
    expect(sheets.map((sheet) => sheet.id)).toEqual(["real"]);
    expect(skipped.map((entry) => entry.id)).toEqual(["link", "text", "big", "gone"]);
    expect(skipped[0]!.reason).toContain("symbolic link");
    expect(skipped[1]!.reason).toContain("not a PNG");
    expect(skipped[2]!.reason).toContain("over the");
    expect(skipped[3]!.reason).toContain("does not exist");
    // A refused copy leaves nothing behind.
    expect(existsSync(path.join(into, "03-text.png"))).toBe(false);

    const many = Array.from({ length: critic.CRITIC_MAX_SHEETS + 2 }, (_, at) => ({ id: `s${at}`, title: null, scenes: [], from: path.join(from, "real.png") }));
    const capped = await critic.copyCriticSheets(many, path.join(home, "many"));
    expect(capped.sheets).toHaveLength(critic.CRITIC_MAX_SHEETS);
    expect(capped.skipped).toHaveLength(2);
    expect(capped.skipped[0]!.reason).toContain(`over the ${critic.CRITIC_MAX_SHEETS} sheets`);
  });
});

describe("reading a reply", () => {
  const scenes = [
    { class: "TB1_WhyItMatters", name: "why_it_matters" },
    { class: "TB2_Recap", name: "recap" },
  ];

  it("takes the last critic block and keeps each scene as its class", () => {
    const read = critic.readCriticReply(`\`\`\`critic\n{}\n\`\`\`\n${reply({ defects: [{ ...DEFECT, scene: "why_it_matters" }] })}`, scenes);
    expect(read).toEqual({ ok: true, value: { scores: SCORES, defects: [DEFECT], notes: ["the two scenes share one layout"] } });
  });

  it("refuses every shape the contract does not allow", () => {
    const problems = (over: Record<string, unknown>): string[] => {
      const read = critic.readCriticReply(reply(over), scenes);
      return read.ok ? [] : read.problems;
    };
    expect(problems({ scores: { ...SCORES, layout: 3.5 } })).toEqual(["scores.layout is a whole number from 1 to 5"]);
    expect(problems({ scores: { ...SCORES, extra: 1 } })).toEqual(["scores has unknown fields: extra"]);
    expect(problems({ verdict: "fine" })).toEqual(["the reply has unknown fields: verdict"]);
    expect(problems({ defects: Array.from({ length: 7 }, () => DEFECT) })).toEqual(["defects has 7 entries, over 6"]);
    expect(problems({ notes: Array.from({ length: 7 }, () => "a note") })).toEqual(["notes has 7 entries, over 6"]);
    expect(problems({ notes: ["two\nlines"] })[0]).toContain("line break or a control character");
    expect(problems({ notes: ["x".repeat(301)] })).toEqual(["notes[0] is 301 characters, over 300"]);
    expect(problems({ defects: [{ ...DEFECT, fix: "" }] })).toEqual(["defects[0].fix is empty"]);
    expect(problems({ defects: [{ ...DEFECT, severity: "high" }] })).toEqual(["defects[0] has unknown fields: severity"]);
    expect(problems({ defects: [{ ...DEFECT, scene: "TB3_Nope" }] })[0]).toContain("defects[0].scene is one of the brief's scenes");
    expect(critic.readCriticReply("```critic\nnot json\n```", scenes)).toMatchObject({ ok: false, problems: [expect.stringContaining("not JSON")] });
    expect(critic.readCriticReply("no block", scenes)).toEqual({ ok: false, problems: ["there is no fenced block tagged critic"] });
  });
});

describe("the standalone route", () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const segments = url.pathname.split("/").filter((part) => part !== "");
      const record = store.get(segments[2] ?? "");
      if (record === undefined) {
        response.writeHead(404).end();
        return;
      }
      void videoJobRoutes(request, response, segments, request.method ?? "GET", url, record, { store, runner });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = async (id: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const answer = await fetch(`${base}/api/jobs/${id}/critic`, { method: "POST" });
    return { status: answer.status, body: (await answer.json()) as Record<string, unknown> };
  };

  /** A job made with the critic off, accepted, its sheets kept as a verdict keeps them and its render gone. */
  async function acceptedJob(): Promise<VideoJobRecordT> {
    process.env.STUDIO_VIDEO_CRITIC = "off";
    await plans([{}], [{ reply: reply({ defects: [DEFECT] }) }]);
    const done = await runToEnd();
    await runner.cleanup(done, { candidate: false });
    await store.update(done.id, { state: "accepted" });
    delete process.env.STUDIO_VIDEO_CRITIC;
    return store.get(done.id)!;
  }

  it("scores a video made before the critic from its kept sheets, retries nothing, and keeps the run as standalone", async () => {
    const job = await acceptedJob();
    expect(existsSync(path.join(home, "jobs", job.id, "render"))).toBe(false);
    const answer = await post(job.id);

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ jobId: job.id, critic: { standalone: true, attempt: null, scores: SCORES, defects: [DEFECT], error: null } });
    expect(await agentSpawns()).toBe(1);
    const [call] = await criticCalls();
    expect(call!.files.sort()).toEqual(["01-TB1_WhyItMatters.png", "02-TB2_Recap.png"]);
    const record = store.get(job.id)!;
    expect(record.state).toBe("accepted");
    expect(record.critic).toMatchObject([{ standalone: true, sentBack: false }]);
    // Never on an attempt: it judged no attempt the job ran.
    expect(Object.hasOwn(record.attempts![0]!, "critic")).toBe(false);
    expect(videoView(record).critic).toMatchObject({ attempt: 1, attempts: 1, defects: [DEFECT], sentBack: [] });
  });

  it("answers 503 when the critic is off, 409 with no sheet left or for a job still running, and 429 under the cap", async () => {
    const job = await acceptedJob();
    process.env.STUDIO_VIDEO_CRITIC = "off";
    expect((await post(job.id)).status).toBe(503);
    delete process.env.STUDIO_VIDEO_CRITIC;

    process.env.STUDIO_DAILY_USD = "0.001";
    const capped = await post(job.id);
    expect(capped.status).toBe(429);
    expect(capped.body.error).toContain("STUDIO_DAILY_USD");
    delete process.env.STUDIO_DAILY_USD;

    await rm(path.join(home, "jobs", job.id, "sheets"), { recursive: true, force: true });
    const bare = await post(job.id);
    expect(bare.status).toBe(409);
    expect(bare.body.error).toContain("no contact sheet");

    await store.update(job.id, { state: "running" });
    expect((await post(job.id)).status).toBe(409);
    await store.update(job.id, { state: "accepted" });
    expect(await criticCalls()).toHaveLength(0);
  });
});
