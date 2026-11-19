import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { validateBrief, type ValidBrief } from "../src/diagram/brief";

import { allSettled, until } from "./wait";
import { testVocabulary } from "./vocabulary";

/**
 * The run record of a diagram job: the same attempt history and `JobRun`
 * the video runner keeps, through the diagram runner's own loop. The agent,
 * the gate and the catalog are stubbed as in `queue.test.ts`; the agent here
 * feeds the runner the two lines the run record reads, the init event with
 * the CLI's version and a result with the attempt's turns and cost.
 */

const ok = { ok: true, json: {}, error: null, offline: false };

const catalogMock = vi.hoisted(() => ({
  jobEnqueue: vi.fn(),
  jobClaim: vi.fn(),
  jobFinish: vi.fn(),
  jobAccept: vi.fn(),
  jobDiscard: vi.fn(),
  jobReview: vi.fn(),
  sessionStart: vi.fn(),
  sessionEnd: vi.fn(),
  status: vi.fn(),
  diagramShow: vi.fn(async () => ({ ok: false, json: null, error: "unreachable", offline: true })),
  diagramCheckout: vi.fn(async () => ({ ok: false, json: null, error: "unreachable", offline: true })),
}));
vi.mock("../src/data/catalog", () => catalogMock);

const gateMock = vi.hoisted(() => ({ runGate: vi.fn(), narrate: vi.fn(() => "a step") }));
vi.mock("../src/diagram/gate", () => gateMock);

vi.mock("../src/diagram/compare", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/diagram/compare")>()),
  readSide: vi.fn(async () => ({ shapes: 3, bindings: 1, lints: [], svgBytes: null, shot: false, at: new Date().toISOString() })),
}));

vi.mock("../src/diagram/review", () => ({ dirtyFiles: vi.fn(async () => [] as string[]), accept: vi.fn(), discard: vi.fn(), reindex: vi.fn() }));

/** Each attempt's plan: its turns and cost, whether it hangs until stopped. */
const plans: { turns: number | null; cost: number; hang?: boolean }[] = [];
const agentMock = vi.hoisted(() => ({ startAgent: vi.fn(), sweepOrphans: vi.fn(async () => [] as number[]), AgentRun: class {} }));
vi.mock("../src/agent/agent", () => agentMock);

const { Runner } = await import("../src/diagram/runner");
const { JobStore } = await import("../src/data/store");

const outcome = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  exitCode: 0,
  signal: null,
  turns: 9,
  subtype: "success",
  isError: false,
  result: null,
  apiKeySource: null,
  spawnFailed: false,
  denials: [],
  stopReason: null,
  stderr: "",
  ...over,
});

function gate(pass: boolean): Record<string, unknown> {
  return {
    ok: pass,
    steps: [
      { name: "candidate-exists", ok: true, detail: "" },
      { name: "lints", ok: pass, detail: "" },
    ],
    findings: pass ? [] : ["two labels overlap", "an arrow points at nothing"],
    shapes: 12,
    lints: pass ? 0 : 2,
    svg: null,
    exportFailed: false,
    checkedAt: new Date().toISOString(),
  };
}

async function brief(): Promise<ValidBrief> {
  return validateBrief(
    {
      intent: "show how a dot product projects one vector onto another",
      topic: "vector-and-linear-algebra-basics",
      slug: "studio-run-record-fixture",
      title: "Dot product",
      mode: "new",
      elements: [{ label: "vector a" }, { label: "vector b" }],
      relations: [],
      idempotencyKey: `key-${Math.random()}`,
    },
    testVocabulary(),
  );
}

let store: InstanceType<typeof JobStore>;
let runner: InstanceType<typeof Runner>;
let home: string;

beforeEach(() => {
  home = path.join(tmpdir(), `studio-diagram-run-record-${Date.now()}-${Math.random()}`);
  process.env.STUDIO_HOME = home;
  for (const fn of Object.values(catalogMock)) fn.mockReset().mockResolvedValue(ok);
  catalogMock.diagramShow.mockResolvedValue({ ok: false, json: null, error: "unreachable", offline: true });
  catalogMock.diagramCheckout.mockResolvedValue({ ok: false, json: null, error: "unreachable", offline: true });
  plans.length = 0;
  agentMock.startAgent.mockReset().mockImplementation((options: Record<string, unknown>) => {
    const plan = plans.shift() ?? { turns: 1, cost: 0.01 };
    const onLine = options.onLine as (line: string) => void;
    const onInit = options.onInit as (init: Record<string, unknown>) => void;
    onInit({ apiKeySource: "none", model: "claude-sonnet-5", version: "2.1.300" });
    let settle: (value: Record<string, unknown>) => void = () => undefined;
    const done = new Promise<Record<string, unknown>>((resolve) => {
      settle = resolve;
    });
    const usage = { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 20 };
    onLine(JSON.stringify({ type: "assistant", message: { id: `msg-${Math.random()}`, model: "claude-sonnet-5", role: "assistant", content: [], usage } }));
    if (!plan.hang) {
      onLine(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: plan.turns, total_cost_usd: plan.cost, usage }));
      settle(outcome({ turns: plan.turns }));
    }
    return Promise.resolve({ done, stop: async (reason: string) => settle(outcome({ stopReason: reason, exitCode: null, turns: null })) });
  });
  gateMock.runGate.mockReset();
  store = new JobStore();
  runner = new Runner(store);
});

afterEach(async () => {
  await runner.drain();
  await allSettled(runner, store);
  await rm(home, { recursive: true, force: true });
  delete process.env.STUDIO_HOME;
});

function finishOf(id: string): { state: string; runFile?: string } {
  const inputs = catalogMock.jobFinish.mock.calls.map((call) => (call as unknown[])[0] as { jobId: string; state: string; runFile?: string });
  return inputs.filter((input) => input.jobId === id).at(-1)!;
}

describe("a diagram job's run record", () => {
  it("keeps one attempt per spawn with its own gate, and hands the run to job finish", async () => {
    plans.push({ turns: 5, cost: 0.04 }, { turns: 2, cost: 0.01 });
    gateMock.runGate.mockResolvedValueOnce(gate(false)).mockResolvedValueOnce(gate(true));
    const { record } = await runner.enqueue(await brief());
    await until(() => store.get(record.id)?.state === "awaiting_review", () => `the job is ${store.get(record.id)?.state}`);
    await runner.settled(record.id);
    const done = store.get(record.id)!;

    expect(done.attempts).toEqual([
      { n: 1, startedAt: expect.any(String), endedAt: expect.any(String), turns: 5, costUsd: 0.04, gate: { ok: false, steps: [{ name: "candidate-exists", ok: true }, { name: "lints", ok: false }], findings: 2, warnings: 0 } },
      { n: 2, startedAt: expect.any(String), endedAt: expect.any(String), turns: 2, costUsd: 0.01, gate: { ok: true, steps: [{ name: "candidate-exists", ok: true }, { name: "lints", ok: true }], findings: 0, warnings: 0 } },
    ]);
    const finish = finishOf(record.id);
    expect(finish).toMatchObject({ state: "awaiting_review", runFile: path.join(home, "jobs", record.id, "run.json") });
    const run = JSON.parse(await readFile(finish.runFile!, "utf8")) as Record<string, unknown>;
    expect(run).toMatchObject({
      harness: { name: "claude-code", version: "2.1.300" },
      model: { passed: done.agentModel?.passed ?? null, resolved: "claude-sonnet-5" },
      attempts: done.attempts,
      // The diagram runner counts no canvas verbs and times no render.
      calls: {},
      renderSeconds: null,
      transcriptPath: `jobs/${record.id}/session.ndjson`,
    });
  });

  it("still writes one for a job cancelled mid-attempt, and for one cancelled before it started", async () => {
    plans.push({ turns: null, cost: 0, hang: true });
    gateMock.runGate.mockResolvedValue(gate(true));
    const { record } = await runner.enqueue(await brief());
    await until(() => agentMock.startAgent.mock.calls.length >= 1, "the agent never started");
    await runner.cancel(record.id);
    await until(() => store.get(record.id)?.state === "cancelled", () => `the job is ${store.get(record.id)?.state}`);
    await runner.settled(record.id);
    const done = store.get(record.id)!;
    expect(done.attempts).toHaveLength(1);
    expect(done.attempts![0]).toMatchObject({ n: 1, turns: null, gate: null });
    const run = JSON.parse(await readFile(finishOf(record.id).runFile!, "utf8")) as { attempts: unknown[] };
    expect(run.attempts).toEqual(done.attempts);

    await runner.drain();
    const { record: queued } = await runner.enqueue({ ...(await brief()), slug: "studio-run-record-queued" });
    await runner.cancel(queued.id);
    expect(finishOf(queued.id)).toMatchObject({ state: "cancelled", runFile: path.join(home, "jobs", queued.id, "run.json") });
  });

  it("writes one from the record for a job the runner died under", async () => {
    await runner.drain();
    const { record } = await runner.enqueue(await brief());
    await store.update(record.id, {
      state: "running",
      sessionId: `studio-${record.id}`,
      attempts: [{ n: 1, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), turns: 4, costUsd: 0.02, gate: null }],
    });
    await runner.reconcile();
    const finish = finishOf(record.id);
    expect(finish.state).toBe("interrupted");
    const run = JSON.parse(await readFile(finish.runFile!, "utf8")) as { attempts: { n: number }[] };
    expect(run.attempts.map((attempt) => attempt.n)).toEqual([1]);
  });
});
