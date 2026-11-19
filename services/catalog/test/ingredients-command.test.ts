import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { asset, assetIngredients as ingredientsTable, contentRevision, learner, LOCAL_LEARNER_ID } from "@hermes/schema";
import { count } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { formatIngredientsScan, IngredientsUsage, runIngredientsScan } from "../src/commands/ingredients";
import { migratedScratchDatabase, probe, type Scratch } from "./scratch-database";
import { storedBlob } from "./stored-blob";

/**
 * `catalog ingredients scan` against stand-in tool CLIs and fake topic trees,
 * on a scratch database: the rows it writes, that a second run and `--only`
 * and `--force` behave, that a tool with no CLI, or one whose CLI fails, is a
 * note and not an error, and that it touches no table but `asset_ingredients`.
 */

const reachable = await probe();
const OTHER = "owner-b";
const CATALOG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

/** The real CLI, spawned, so the flags and exit codes are the ones a terminal gets. */
function spawnCatalog(env: Record<string, string>, ...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
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

const MANIM_VIDEO = "manimkc:out/demo/one/one.mp4";
const REMOTION_VIDEO = "remotionkc:out/demo/chart/chart.mp4";

const SCENE = [
  "from manimlib import *",
  "from cslib import *",
  "class S1_One(Scene):",
  "    def construct(self):",
  "        self.play(FadeIn(caption('x')))",
  "",
].join("\n");

describe.skipIf(!reachable.ok)("catalog ingredients scan", () => {
  let scratch: Scratch;
  let work: string;
  const keys = ["DATABASE_URL", "MANIMKC_ROOT", "REMOTIONKC_ROOT", "REVIDEOKC_ROOT", "BLENDERKC_ROOT"] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  const topic = (topicPath: string, video: string, file: string) => ({
    path: topicPath,
    sections: [
      {
        section: "narrated",
        files: [{ file, scenes: ["S1_One"] }],
        deliverable: { path: video, exists: true, duration: 40 },
      },
    ],
  });

  async function put(file: string, text: string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }

  async function cli(file: string, body: string): Promise<void> {
    await put(file, body);
    await chmod(file, 0o755);
  }

  async function video(id: string) {
    await scratch.db.insert(asset).values({
      id,
      kind: "video",
      path: id.slice(id.indexOf(":") + 1),
      blobKey: await storedBlob(scratch.db, id, "mp4"),
      sourceRepo: id.startsWith("manimkc") ? "manimkc" : "remotionkc",
      ownerId: LOCAL_LEARNER_ID,
    });
  }

  beforeAll(async () => {
    scratch = await migratedScratchDatabase();
    work = await mkdtemp(path.join(tmpdir(), "ingredients-command-"));
    await scratch.db.insert(learner).values([{ id: LOCAL_LEARNER_ID }, { id: OTHER }]).onConflictDoNothing();

    // manimkc: a Python stand-in CLI that names its topics root, one topic with its file and one without.
    const manim = path.join(work, "manimkc");
    const manimTopics = path.join(work, "manim-topics");
    await put(path.join(manim, "lib", "cslib.py"), "def caption(s):\n    return s\n");
    await put(path.join(manimTopics, "demo", "one", "scene.py"), SCENE);
    const manimReport = {
      outRoot: manim,
      topicsRoot: manimTopics,
      topics: [topic("demo/one", "out/demo/one/one.mp4", "scene.py"), topic("demo/two", "out/demo/two/two.mp4", "gone.py")],
      drift: { orphans: [], unrendered: [] },
    };
    await cli(
      path.join(manim, "tools", "cli", "manimkc"),
      `#!/usr/bin/env python3\nimport sys\nsys.stdout.write(${JSON.stringify(JSON.stringify(manimReport))})\n`,
    );

    // remotionkc: a node stand-in, whose topics root comes from the checkout's dotenv as the real one's does.
    const remotion = path.join(work, "remotionkc");
    const remotionTopics = path.join(work, "remotion-topics");
    await put(path.join(remotion, ".env"), `REMOTIONKC_TOPICS=${remotionTopics}\n`);
    await put(
      path.join(remotionTopics, "demo", "chart", "composition.tsx"),
      'import { spring } from "remotion";\nimport { ramp } from "#lib";\nspring();\nramp(1);\nramp(2);\n',
    );
    const remotionReport = {
      outRoot: remotion,
      topics: [topic("demo/chart", "out/demo/chart/chart.mp4", "composition.tsx")],
      drift: { orphans: [], unrendered: [] },
    };
    await cli(
      path.join(remotion, "tools", "cli", "remotionkc.mjs"),
      `process.stdout.write(${JSON.stringify(JSON.stringify(remotionReport))});\n`,
    );

    // revideokc: a CLI that fails. blenderkc: no checkout at all.
    const revideo = path.join(work, "revideokc");
    await cli(path.join(revideo, "tools", "cli", "revideokc.mjs"), "process.stderr.write('boom');\nprocess.exit(1);\n");

    process.env["DATABASE_URL"] = scratch.url;
    process.env["MANIMKC_ROOT"] = manim;
    process.env["REMOTIONKC_ROOT"] = remotion;
    process.env["REVIDEOKC_ROOT"] = revideo;
    process.env["BLENDERKC_ROOT"] = path.join(work, "no-blenderkc");
    await video(MANIM_VIDEO);
    await video(REMOTION_VIDEO);
  }, 60_000);

  afterAll(async () => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await scratch?.drop();
    if (work !== undefined) await rm(work, { recursive: true, force: true });
  });

  const rows = () => scratch.db.select().from(ingredientsTable).orderBy(ingredientsTable.assetId);
  const bySource = (result: Awaited<ReturnType<typeof runIngredientsScan>>) =>
    Object.fromEntries(result.sources.map((s) => [s.source, s]));
  const tableCount = async (table: typeof asset | typeof contentRevision) =>
    (await scratch.db.select({ n: count() }).from(table))[0]!.n;

  it("writes a row per readable video and touches no other table", async () => {
    const assetsBefore = await tableCount(asset);
    const revisionsBefore = await tableCount(contentRevision);

    const result = await runIngredientsScan({});
    const by = bySource(result);

    expect(result).toMatchObject({ ok: true, command: "ingredients scan", owner: LOCAL_LEARNER_ID, force: false });
    expect(result.sources.map((s) => s.source)).toEqual(["manimkc", "remotionkc", "revideokc", "blenderkc", "studio"]);
    expect(by["manimkc"]).toMatchObject({ ran: true, scanned: 2, written: 1, unchanged: 0 });
    expect(by["manimkc"]!.skipped).toHaveLength(1);
    expect(by["manimkc"]!.skipped[0]).toMatchObject({ id: "manimkc:out/demo/two/two.mp4" });
    expect(by["remotionkc"]).toMatchObject({ ran: true, scanned: 1, written: 1, unchanged: 0, skipped: [] });
    expect(by["studio"]).toMatchObject({ ran: true, scanned: 0, written: 0 });

    const stored = await rows();
    expect(stored.map((r) => [r.assetId, r.tool, r.durationSeconds, r.sceneCount])).toEqual([
      [MANIM_VIDEO, "manimkc", 40, 1],
      [REMOTION_VIDEO, "remotionkc", 40, 1],
    ]);
    expect(stored[0]!.calls).toEqual({ FadeIn: 1, caption: 1 });
    expect(stored[1]!.calls).toEqual({ ramp: 2, spring: 1 });

    expect(await tableCount(asset)).toBe(assetsBefore);
    expect(await tableCount(contentRevision)).toBe(revisionsBefore);
  });

  it("says a tool with no CLI, or whose CLI fails, was not run, and still exits clean", async () => {
    const result = await runIngredientsScan({});
    const by = bySource(result);
    expect(by["blenderkc"]).toMatchObject({ ran: false, scanned: 0 });
    expect(by["blenderkc"]!.notes[0]).toContain("no blenderkc CLI");
    expect(by["revideokc"]).toMatchObject({ ran: false });
    expect(by["revideokc"]!.notes[0]).toMatch(/^failed: .*boom/s);
    const text = formatIngredientsScan(result);
    expect(text).toContain("blenderkc   not run");
    expect(text).toContain("skipped manimkc:out/demo/two/two.mp4");
  });

  it("is idempotent, rewrites everything with --force, and keeps to --only", async () => {
    const second = await runIngredientsScan({});
    expect(bySource(second)["manimkc"]).toMatchObject({ written: 0, unchanged: 1 });
    expect(bySource(second)["remotionkc"]).toMatchObject({ written: 0, unchanged: 1 });

    const forced = await runIngredientsScan({ force: true });
    expect(forced.force).toBe(true);
    expect(bySource(forced)["manimkc"]).toMatchObject({ written: 1, unchanged: 0 });
    expect(bySource(forced)["remotionkc"]).toMatchObject({ written: 1, unchanged: 0 });

    const only = await runIngredientsScan({ only: "remotionkc", force: true });
    expect(only.sources.map((s) => s.source)).toEqual(["remotionkc"]);
    const two = await runIngredientsScan({ only: "studio,manimkc" });
    expect(two.sources.map((s) => s.source)).toEqual(["manimkc", "studio"]);
    await expect(runIngredientsScan({ only: "everything" })).rejects.toBeInstanceOf(IngredientsUsage);
    expect((await rows()).length).toBe(2);
  });

  it("scans only what the owner can read", async () => {
    const result = await runIngredientsScan({ owner: OTHER, only: "manimkc" });
    expect(result.owner).toBe(OTHER);
    expect(bySource(result)["manimkc"]).toMatchObject({ written: 0, unchanged: 0 });
    expect(bySource(result)["manimkc"]!.skipped.map((s) => s.id).sort()).toEqual([
      MANIM_VIDEO,
      "manimkc:out/demo/two/two.mp4",
    ]);
  });

  it("parses its flags at the real CLI: --json, --only, --force, and exit 2 for a wrong invocation", async () => {
    const env = { DATABASE_URL: scratch.url, MANIMKC_ROOT: process.env["MANIMKC_ROOT"] as string, REMOTIONKC_ROOT: process.env["REMOTIONKC_ROOT"] as string };
    const ran = await spawnCatalog(env, "ingredients", "scan", "--only", "remotionkc", "--force", "--json");
    expect(ran.code).toBe(0);
    const parsed = JSON.parse(ran.stdout) as { command: string; force: boolean; sources: Array<{ source: string; written: number }> };
    expect(parsed).toMatchObject({ command: "ingredients scan", force: true });
    expect(parsed.sources).toEqual([expect.objectContaining({ source: "remotionkc", written: 1 })]);

    const bad = await spawnCatalog(env, "ingredients", "scan", "--only", "nope");
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("--only is");
    expect((await spawnCatalog(env, "ingredients", "frob")).code).toBe(2);
    expect((await spawnCatalog(env, "eval", "frob")).code).toBe(2);

    const report = await spawnCatalog(env, "eval", "report", "--json");
    expect(report.code).toBe(0);
    expect(JSON.parse(report.stdout)).toMatchObject({ ok: true, command: "eval report", report: { totals: { videos: 2 } } });
    const text = await spawnCatalog(env, "eval", "report");
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("By prompt version");
  }, 60_000);
});
