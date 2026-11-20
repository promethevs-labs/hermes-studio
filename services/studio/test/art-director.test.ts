import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeClaude, type FakeClaude } from "./fake-claude";
import { topicListAnswer } from "./vocabulary";
import { until } from "./wait";

/**
 * The art director (docs/STUDIO-VIDEOS.md, "The shot plan"), spawned through
 * a stand-in `claude`: its seal, a plan, a refused plan fixed by the one
 * follow-up, a plan refused twice, a timeout, a broken seal; then the draft
 * that runs it inside a planner turn (shots on the card, reuse on unchanged
 * scenes, off, the cap), and `POST /api/video/shots`. No request leaves the
 * machine.
 */

// `config.ts` reads the CLI's path once, at import, so a path that cannot
// run stands in until the fake's is set: an import that reads it early fails
// a test rather than reaching the real `claude`.
vi.hoisted(() => {
  process.env.STUDIO_CLAUDE_BIN = "/nonexistent/claude-until-the-fake-is-ready";
  process.env.STUDIO_VIDEO_KIND = "on";
  // One slot, so a route plan and a planner turn can be seen to share it.
  process.env.STUDIO_PLANNER_CONCURRENCY = "1";
});
let fake: FakeClaude;
const fakeReady = fakeClaude().then((made) => {
  fake = made;
  process.env.STUDIO_CLAUDE_BIN = made.bin;
});
await fakeReady;

const catalogMock = vi.hoisted(() => ({
  draftUpsert: vi.fn(),
  topicList: vi.fn(),
  topicAddDryRun: vi.fn(),
  topicAdd: vi.fn(),
  diagramList: vi.fn(),
  videoList: vi.fn(),
  videoShow: vi.fn(),
}));
vi.mock("../src/data/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/data/catalog")>()),
  ...catalogMock,
}));

const { Drafts } = await import("../src/drafts/drafts");
const { directShots } = await import("../src/drafts/art-director");
const { narratedBrief } = await import("./video-fixture");
const { CLAUDE_BIN } = await import("../src/config");
// Never the real CLI: every spawn here is the fake's.
if (CLAUDE_BIN !== fake!.bin) throw new Error(`the art director would spawn ${CLAUDE_BIN}, not the fake`);
const { JobStore, RecordStore } = await import("../src/data/store");
const { JobRefused, Runner } = await import("../src/diagram/runner");
const { createApi } = await import("../src/api");
const { Mirrors } = await import("../src/canvas/mirrors");
const { withoutShots } = await import("../src/video/brief");

type DraftsT = InstanceType<typeof Drafts>;
const ok = (json: unknown = {}) => ({ ok: true, json, error: null, offline: false });

const brief = (() => {
  const made: Record<string, unknown> = { ...narratedBrief(), topic: "tcp-congestion-control", slug: "tcp-congestion-window" };
  delete made.idempotencyKey;
  return made as unknown as ReturnType<typeof narratedBrief>;
})();

const shot = (type: string) => ({
  type,
  layout: "Left third: the client box; right two thirds: the API and the database",
  motion: "The request slides right as the voice says crosses",
  emphasis: "The API box, ringed in the accent colour",
});
const shotsReply = (types: string[], names = brief.scenes.map((scene) => scene.name)): string =>
  `Here is the plan.\n\n\`\`\`shots\n${JSON.stringify({ scenes: names.map((name, i) => ({ name, shot: shot(types[i]!) })) })}\n\`\`\``;
const videoReply = (video: unknown = { kind: "video", ...brief }): string => `A video.\n\n\`\`\`brief\n${JSON.stringify(video)}\n\`\`\``;

let store: InstanceType<typeof JobStore>;
let drafts: DraftsT;
let runner: { enqueue: ReturnType<typeof vi.fn>; admit: ReturnType<typeof vi.fn>; assertUnderCap: ReturnType<typeof vi.fn>; canvasOpen: () => boolean };

afterAll(async () => {
  await fake.cleanup();
  delete process.env.STUDIO_VIDEO_KIND;
  delete process.env.STUDIO_PLANNER_CONCURRENCY;
});

beforeEach(async () => {
  process.env.STUDIO_HOME = path.join(tmpdir(), `studio-art-director-${Date.now()}-${Math.random()}`);
  process.env.STUDIO_ART_DIRECTOR = "on";
  delete process.env.STUDIO_ART_DIRECTOR_MODEL;
  delete process.env.STUDIO_ART_DIRECTOR_MS;
  await mkdir(process.env.STUDIO_HOME, { recursive: true });
  catalogMock.draftUpsert.mockReset().mockResolvedValue(ok());
  catalogMock.topicList.mockReset().mockResolvedValue(topicListAnswer());
  catalogMock.topicAddDryRun.mockReset().mockResolvedValue(ok({ nearMatches: [] }));
  catalogMock.topicAdd.mockReset().mockResolvedValue(ok());
  catalogMock.diagramList.mockReset().mockResolvedValue(ok({ diagrams: [] }));
  catalogMock.videoList.mockReset().mockResolvedValue(ok({ videos: [] }));
  catalogMock.videoShow.mockReset().mockResolvedValue(ok({ video: null }));
  store = new JobStore();
  runner = { enqueue: vi.fn(), admit: vi.fn(), assertUnderCap: vi.fn(), canvasOpen: () => false };
  await fake.script([]);
  drafts = new Drafts(store, runner as never, { store: new RecordStore("video") as never, runner: { enqueue: vi.fn(), admit: vi.fn() } as never });
});

afterEach(async () => {
  await drafts.drain();
  await rm(process.env.STUDIO_HOME!, { recursive: true, force: true });
  process.env.STUDIO_ART_DIRECTOR = "off";
});

const dir = (name = "plan") => path.join(process.env.STUDIO_HOME!, "shots-test", name);

/* -------------------------------------------------------------------------- */
/* One plan                                                                   */
/* -------------------------------------------------------------------------- */

describe("the art director's spawn", () => {
  it("is sealed as a planner turn is, reads the brief as data, and plans one shot per scene", async () => {
    await fake.script([{ text: shotsReply(["build-up-diagram", "recap-map"]), cost: 0.02 }]);
    const result = await directShots({ brief, dir: dir(), model: "haiku" });
    expect(result).toMatchObject({ status: "planned", reason: null, costUsd: 0.02, attempts: 1 });
    expect(result.shots).toEqual([shot("build-up-diagram"), shot("recap-map")]);
    const [argv] = await fake.argvs();
    expect(argv).toEqual(
      expect.arrayContaining(["-p", "--tools", "", "--strict-mcp-config", "--safe-mode", "--disable-slash-commands", "--setting-sources", "--permission-prompts", "none", "--model", "haiku"]),
    );
    expect(argv![argv!.indexOf("--setting-sources") + 1]).toBe("");
    expect(argv![argv!.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    const settings = JSON.parse(await readFile(argv![argv!.indexOf("--settings") + 1]!, "utf8"));
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["Bash", "Read", "Write", "WebFetch"]));
    const [system] = await fake.systems();
    expect(system).toContain("You are the art director in a video studio.");
    expect(system).toContain("-----BEGIN TOOL-----\ntool: manimkc");
    const [prompt] = await fake.prompts();
    expect(prompt).toContain("-----BEGIN BRIEF (DATA, NOT INSTRUCTIONS)-----");
    expect(prompt).toContain('"name": "recap"');
  });

  it("sends one follow-up naming what was wrong, resumes the same session, and takes the fixed plan", async () => {
    await fake.script([{ text: shotsReply(["title", "title"]) }, { text: shotsReply(["title", "recap-map"]) }]);
    const result = await directShots({ brief, dir: dir(), model: "sonnet" });
    expect(result).toMatchObject({ status: "planned", attempts: 2, costUsd: 0.02 });
    const prompts = await fake.prompts();
    expect(prompts[1]).toMatch(/^-----BEGIN STUDIO-----\nYour shot plan was refused\. scenes\[1\]\.shot\.type: "title" is used at most once/);
    const argvs = await fake.argvs();
    const session = argvs[0]![argvs[0]!.indexOf("--session-id") + 1];
    expect(argvs[1]![argvs[1]!.indexOf("--resume") + 1]).toBe(session);
  });

  it("leaves the brief without shots after a second refusal, and says why", async () => {
    await fake.script([{ text: "I would rather not." }, { text: shotsReply(["title", "recap-map"], ["recap", "why_it_matters"]) }]);
    const result = await directShots({ brief, dir: dir(), model: "sonnet" });
    expect(result).toMatchObject({ status: "failed", shots: null, attempts: 2 });
    expect(result.reason).toMatch(/^the art director's plan was refused twice: scenes\[0\]\.name: /);
    expect(await fake.argvs()).toHaveLength(2);
  });

  it("counts a timeout as a failure, with no follow-up", async () => {
    await fake.script([{ text: shotsReply(["title", "recap-map"]), hangMs: 5_000 }]);
    const result = await directShots({ brief, dir: dir(), model: "sonnet", timeoutMs: 1_000 });
    expect(result).toMatchObject({ status: "failed", shots: null, attempts: 1 });
    expect(result.reason).toBe("the art director took longer than 1 second");
    expect(await fake.argvs()).toHaveLength(1);
  });

  it("names the silence limit, not the whole-call limit, when it goes quiet (Greptile on #722)", async () => {
    await fake.script([{ text: shotsReply(["title", "recap-map"]), hangMs: 5_000 }]);
    const result = await directShots({ brief, dir: dir(), model: "sonnet", timeoutMs: 20_000, idleMs: 1_000 });
    expect(result).toMatchObject({ status: "failed", attempts: 1 });
    expect(result.reason).toBe("the art director went quiet for 1 second, so it was stopped");
  });

  it("hands each spawn's spend over the moment it ends, before the follow-up starts (Greptile on #722)", async () => {
    await fake.script([{ text: "no plan", cost: 0.02 }, { text: shotsReply(["title", "recap-map"]), cost: 0.03 }]);
    const seen: { costUsd: number | null; spawnsSoFar: number }[] = [];
    await directShots({
      brief,
      dir: dir(),
      model: "sonnet",
      onSpend: async (entry) => {
        seen.push({ costUsd: entry.costUsd, spawnsSoFar: (await fake.argvs()).length });
      },
    });
    expect(seen).toEqual([
      { costUsd: 0.02, spawnsSoFar: 1 },
      { costUsd: 0.03, spawnsSoFar: 2 },
    ]);
  });

  it("stops a spawn whose init lists a tool, before its reply is read", async () => {
    await fake.script([{ text: shotsReply(["title", "recap-map"]), tools: ["Bash"], hangMs: 2_000 }]);
    const result = await directShots({ brief, dir: dir(), model: "sonnet" });
    expect(result).toMatchObject({ status: "failed", shots: null, attempts: 1 });
    expect(result.reason).toMatch(/^the art director started with 1 tool\(s\) and 0 MCP server\(s\) \(Bash\), where it must have none, so it was stopped/);
  });
});

/* -------------------------------------------------------------------------- */
/* Inside a planner turn                                                      */
/* -------------------------------------------------------------------------- */

async function videoTurn(id: string, text = "make the video"): Promise<void> {
  await drafts.send(id, `@video ${text}`, [{ kind: "video", start: 0, end: 6 }]);
  await drafts.settled(id);
}

describe("a planner turn with a valid video brief", () => {
  it("plans the shots before the brief lands, so the slot and the card carry them, and counts the spend", async () => {
    await fake.script([{ text: videoReply(), cost: 0.05 }, { text: shotsReply(["build-up-diagram", "recap-map"]), cost: 0.02 }]);
    const { record } = await drafts.create({});
    const states: boolean[] = [];
    await drafts.subscribe(record.id, 0, (event) => {
      if (event.event === "state") states.push((event.data as { planningShots?: boolean }).planningShots === true);
    });
    await videoTurn(record.id);
    const view = await drafts.view(record.id);
    const slot = view.slots.video!;
    expect(slot.state).toBe("briefed");
    expect((slot.brief as typeof brief).scenes.map((scene) => scene.shot?.type)).toEqual(["build-up-diagram", "recap-map"]);
    expect(slot.shotNote).toMatchObject({ state: "planned", reason: null, costUsd: 0.02 });
    // The brief event the card is drawn from carries the shots too.
    const card = view.transcript.flatMap((entry) => entry.briefs ?? []).find((entry) => entry.kind === "video");
    expect((card!.brief as typeof brief).scenes[0]!.shot).toEqual(shot("build-up-diagram"));
    expect(view.planningShots).toBe(false);
    // The status line was up while it ran, and down after.
    expect(states).toContain(true);
    expect(states.at(-1)).toBe(false);
    expect(view.costUsd).toBe(0.07);
    expect(drafts.spendEntries().map((entry) => entry.costUsd)).toEqual([0.05, 0.02]);
  });

  it("reuses the plan when a later brief has the same scenes, with no second call", async () => {
    const retitled = { kind: "video", ...brief, title: "Two boxes, again", tool: "revideokc", toolReason: "Depth for the boxes, manimkc the runner-up" };
    await fake.script([{ text: videoReply() }, { text: shotsReply(["build-up-diagram", "recap-map"]) }, { text: videoReply(retitled) }]);
    const { record } = await drafts.create({});
    await videoTurn(record.id);
    await videoTurn(record.id, "as revideokc, retitled");
    expect(await fake.argvs()).toHaveLength(3);
    const slot = (await drafts.view(record.id)).slots.video!;
    expect((slot.brief as typeof brief).title).toBe("Two boxes, again");
    expect((slot.brief as typeof brief).scenes.map((scene) => scene.shot?.type)).toEqual(["build-up-diagram", "recap-map"]);
    expect(slot.shotNote).toMatchObject({ state: "reused", costUsd: 0 });
  });

  it("plans again when a scene's words change", async () => {
    const reworded = { kind: "video", ...brief, scenes: [{ ...brief.scenes[0]!, beats: [{ ...brief.scenes[0]!.beats[0]!, show: "three boxes" }] }, brief.scenes[1]] };
    await fake.script([
      { text: videoReply() },
      { text: shotsReply(["build-up-diagram", "recap-map"]) },
      { text: videoReply(reworded) },
      { text: shotsReply(["comparison", "recap-map"]) },
    ]);
    const { record } = await drafts.create({});
    await videoTurn(record.id);
    await videoTurn(record.id, "three boxes");
    expect(await fake.argvs()).toHaveLength(4);
    const slot = (await drafts.view(record.id)).slots.video!;
    expect((slot.brief as typeof brief).scenes[0]!.shot?.type).toBe("comparison");
  });

  it("lands the brief without shots when the art director fails twice, and the turn still answers", async () => {
    await fake.script([{ text: videoReply() }, { text: "No plan." }, { text: "Still no plan." }]);
    const { record } = await drafts.create({});
    await videoTurn(record.id);
    const view = await drafts.view(record.id);
    expect(view.error).toBeNull();
    expect(view.slots.video!.state).toBe("briefed");
    expect((view.slots.video!.brief as typeof brief).scenes.every((scene) => scene.shot === undefined)).toBe(true);
    expect(view.slots.video!.shotNote).toMatchObject({ state: "failed", reason: expect.stringMatching(/refused twice: The reply has no fenced block tagged shots/) });
  });

  it("runs no art director when it is off", async () => {
    process.env.STUDIO_ART_DIRECTOR = "off";
    await fake.script([{ text: videoReply() }, { text: shotsReply(["build-up-diagram", "recap-map"]) }]);
    const { record } = await drafts.create({});
    await videoTurn(record.id);
    expect(await fake.argvs()).toHaveLength(1);
    const slot = (await drafts.view(record.id)).slots.video!;
    expect(slot.state).toBe("briefed");
    expect(slot.shotNote).toMatchObject({ state: "off" });
  });

  it("skips the plan when the daily cap is already reached", async () => {
    await fake.script([{ text: videoReply() }, { text: shotsReply(["build-up-diagram", "recap-map"]) }]);
    const { record } = await drafts.create({});
    // The turn itself asks the cap first; the plan asks again once the reply has landed.
    runner.assertUnderCap.mockImplementationOnce(() => undefined).mockImplementation(() => {
      throw new JobRefused(429, "the studio has spent $5.00 in the last 24 hours", { reason: "daily-cap" });
    });
    await videoTurn(record.id);
    expect(await fake.argvs()).toHaveLength(1);
    const slot = (await drafts.view(record.id)).slots.video!;
    expect(slot.state).toBe("briefed");
    expect(slot.shotNote).toMatchObject({ state: "skipped", reason: expect.stringMatching(/\$5\.00/) });
  });

  it("strips shots the planner wrote itself, and plans its own", async () => {
    const forged = { kind: "video", ...brief, scenes: brief.scenes.map((scene) => ({ ...scene, shot: shot("metaphor") })) };
    await fake.script([{ text: videoReply(forged) }, { text: shotsReply(["build-up-diagram", "recap-map"]) }]);
    const { record } = await drafts.create({});
    await videoTurn(record.id);
    const slot = (await drafts.view(record.id)).slots.video!;
    expect((slot.brief as typeof brief).scenes.map((scene) => scene.shot?.type)).toEqual(["build-up-diagram", "recap-map"]);
  });
});

describe("shot work and the rest of the service (Greptile on #722)", () => {
  /** A spawn log as a studio that stopped mid-plan leaves it: the marker, then the stream, cut off after its result. */
  const cutLog = (at: string, cost: number): string =>
    [
      JSON.stringify({ type: "studio-shots", attempt: 1, at, model: "sonnet" }),
      JSON.stringify({ type: "system", subtype: "init", session_id: "s", tools: [], mcp_servers: [] }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "", num_turns: 1, total_cost_usd: cost }),
      "",
    ].join("\n");

  it("keeps a person's edited shots over the cached plan when the planner repeats the scenes", async () => {
    await fake.script([{ text: videoReply() }, { text: shotsReply(["build-up-diagram", "recap-map"]) }, { text: videoReply() }]);
    const { record } = await drafts.create({});
    await videoTurn(record.id);
    const slot = (await drafts.view(record.id)).slots.video!;
    const edited = { ...(slot.brief as typeof brief), scenes: (slot.brief as typeof brief).scenes.map((scene, i) => ({ ...scene, shot: shot(["comparison", "recap-map"][i]!) })) };
    await drafts.editBrief(record.id, edited, String(slot.briefSeq), "video");
    await videoTurn(record.id, "the same again");
    // No new art director call, and the person's shots, not the first plan's.
    expect(await fake.argvs()).toHaveLength(3);
    const after = (await drafts.view(record.id)).slots.video!;
    expect((after.brief as typeof brief).scenes.map((scene) => scene.shot?.type)).toEqual(["comparison", "recap-map"]);
  });

  it("writes a draft's first spawn's spend down before its follow-up ends", async () => {
    await fake.script([{ text: videoReply(), cost: 0.05 }, { text: "no plan", cost: 0.02 }, { text: shotsReply(["title", "recap-map"]), cost: 0.03, hangMs: 1_500 }]);
    const { record } = await drafts.create({});
    await drafts.send(record.id, "@video make it", [{ kind: "video", start: 0, end: 6 }]);
    const { draftJsonPath } = await import("../src/paths");
    const onDisk = async () => JSON.parse(await readFile(draftJsonPath(record.id), "utf8")) as { spend: { costUsd: number; what?: string }[] };
    // While the follow-up still runs, the first spawn's spend is on disk.
    const deadline = Date.now() + 10_000;
    let shots: number[] = [];
    for (;;) {
      shots = (await onDisk()).spend.filter((entry) => entry.what === "shots").map((entry) => entry.costUsd);
      if (shots.length === 1 && drafts.busy === 1) break;
      if (Date.now() > deadline) throw new Error(`the first spawn's spend never reached the disk while the follow-up ran (${JSON.stringify(shots)})`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(shots).toEqual([0.02]);
    await drafts.settled(record.id);
    expect((await onDisk()).spend.filter((entry) => entry.what === "shots").map((entry) => entry.costUsd)).toEqual([0.02, 0.03]);
  });

  it("prices a draft's shot spawn a restart found unrecorded, once", async () => {
    const { record } = await drafts.create({});
    await drafts.settled(record.id);
    const { draftDir } = await import("../src/paths");
    const plan = path.join(draftDir(record.id), "shots", "3-abcdef12");
    await mkdir(plan, { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(plan, "session.ndjson"), cutLog(new Date().toISOString(), 0.04), "utf8");
    for (let restart = 0; restart < 2; restart += 1) {
      const again = new Drafts(store, runner as never);
      await again.load();
      await again.reconcile();
      await again.settled(record.id);
      expect(again.spendEntries().map((entry) => entry.costUsd)).toEqual([0.04]);
      expect((await again.view(record.id)).costUsd).toBe(0.04);
    }
  });

  it("prices a route plan a restart found unrecorded, once, on the ledger", async () => {
    const plan = path.join(process.env.STUDIO_HOME!, "shots", "0f0f0f0f-aaaa-4bbb-8ccc-123456789abc");
    await mkdir(plan, { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(plan, "session.ndjson"), cutLog(new Date().toISOString(), 0.04), "utf8");
    for (let restart = 0; restart < 2; restart += 1) {
      const again = new Drafts(store, runner as never);
      await again.load();
      expect(again.spendEntries().map((entry) => entry.costUsd)).toEqual([0.04]);
    }
    expect((await readFile(path.join(process.env.STUDIO_HOME!, "shots", "spend.ndjson"), "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("counts a route plan against the planner slots, and in busy, so a turn waits for it", async () => {
    await fake.script([{ text: shotsReply(["build-up-diagram", "recap-map"]), hangMs: 1_500 }]);
    const { record } = await drafts.create({});
    const planning = drafts.planShots({ brief });
    await until(() => drafts.busy === 1, "the route's art director to be running");
    await expect(drafts.send(record.id, "@video make it", [{ kind: "video", start: 0, end: 6 }])).rejects.toMatchObject({ status: 503, detail: { reason: "planner-busy" } });
    expect(await planning).toMatchObject({ shotPlan: "planned" });
    expect(drafts.busy).toBe(0);
  });

  it("refuses a route plan while a planner turn holds the one slot", async () => {
    await fake.script([{ text: "Narrated, or silent?", hangMs: 1_500 }]);
    const { record } = await drafts.create({});
    await drafts.send(record.id, "@video make it", [{ kind: "video", start: 0, end: 6 }]);
    await expect(drafts.planShots({ brief })).rejects.toMatchObject({ status: 503, detail: { reason: "planner-busy" } });
    await drafts.settled(record.id);
  });

  it("counts a draft's own art director call in busy", async () => {
    await fake.script([{ text: videoReply() }, { text: shotsReply(["build-up-diagram", "recap-map"]), hangMs: 1_000 }]);
    const { record } = await drafts.create({});
    await drafts.send(record.id, "@video make it", [{ kind: "video", start: 0, end: 6 }]);
    await until(() => drafts.busy === 1 && (drafts as unknown as { directing: Map<string, unknown> }).directing.size === 1, "the draft's art director to be running", 10_000);
    await drafts.settled(record.id);
    expect(drafts.busy).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* POST /api/video/shots                                                      */
/* -------------------------------------------------------------------------- */

describe("POST /api/video/shots", () => {
  let server: Server;
  let base: string;
  let real: InstanceType<typeof Runner>;
  const post = (body: unknown) => fetch(`${base}/api/video/shots`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  beforeEach(async () => {
    // A real runner, so the cap reads the route's spend through `extraSpend`.
    real = new Runner(store);
    drafts = new Drafts(store, real);
    real.extraSpend = () => drafts.spendEntries();
    server = createApi({ store, runner: real, mirrors: new Mirrors(), drafts });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    delete process.env.STUDIO_DAILY_USD;
    await real.drain();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("plans a brief's shots and answers them with the cost", async () => {
    await fake.script([{ text: shotsReply(["build-up-diagram", "recap-map"]), cost: 0.03 }]);
    const response = await post({ brief });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { brief: typeof brief; shotPlan: string; costUsd: number };
    expect(body).toMatchObject({ shotPlan: "planned", costUsd: 0.03 });
    expect(body.brief.scenes.map((scene) => scene.shot?.type)).toEqual(["build-up-diagram", "recap-map"]);
    expect(body.brief).not.toHaveProperty("idempotencyKey");
    // On disk for the cap, and read back by a studio that starts again.
    expect(await readFile(path.join(process.env.STUDIO_HOME!, "shots", "spend.ndjson"), "utf8")).toMatch(/"costUsd":0\.03/);
    const again = new Drafts(store, real);
    await again.load();
    expect(again.spendEntries().map((entry) => entry.costUsd)).toEqual([0.03]);
  });

  it("answers a brief that already has a whole plan as reused, with no call", async () => {
    const planned = { ...brief, scenes: brief.scenes.map((scene, i) => ({ ...scene, shot: shot(["build-up-diagram", "recap-map"][i]!) })) };
    const body = (await (await post({ brief: planned })).json()) as { shotPlan: string; costUsd: number };
    expect(body).toEqual(expect.objectContaining({ shotPlan: "reused", costUsd: 0 }));
    expect(await fake.argvs()).toHaveLength(0);
  });

  it("answers failed with the reason, and off when the step is off", async () => {
    await fake.script([{ text: "no" }, { text: "no" }]);
    const failed = (await (await post({ brief })).json()) as { shotPlan: string; reason: string; brief: typeof brief };
    expect(failed).toMatchObject({ shotPlan: "failed", reason: expect.stringMatching(/refused twice/) });
    expect(failed.brief.scenes).toEqual(withoutShots(brief).scenes);
    process.env.STUDIO_ART_DIRECTOR = "off";
    expect(await (await post({ brief })).json()).toMatchObject({ shotPlan: "off", costUsd: 0 });
  });

  it("refuses a brief the validator refuses, naming the field, and anything but a POST", async () => {
    const response = await post({ brief: { ...brief, topic: "no-such-topic" } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ detail: { field: "topic" } });
    expect((await post({})).status).toBe(400);
    expect((await fetch(`${base}/api/video/shots`)).status).toBe(405);
    // The same guard as every POST: a page on another origin is refused.
    const foreign = await fetch(`${base}/api/video/shots`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ brief }) });
    expect(foreign.status).toBe(403);
  });

  it("counts its spend in the daily cap, and refuses as a job is refused once the cap is reached", async () => {
    process.env.STUDIO_DAILY_USD = "0.015";
    await fake.script([{ text: shotsReply(["build-up-diagram", "recap-map"]), cost: 0.01 }]);
    expect((await post({ brief })).status).toBe(200);
    await fake.script([{ text: shotsReply(["build-up-diagram", "recap-map"]), cost: 0.01 }]);
    expect((await post({ brief })).status).toBe(200);
    const refused = await post({ brief });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ detail: { reason: "daily-cap", totalUsd: 0.02 } });
  });
});
