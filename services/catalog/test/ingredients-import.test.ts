import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { assetIngredients as ingredientsTable } from "@hermes/schema";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runImportCommand } from "../src/commands/index-command";
import { migratedScratchDatabase, probe, type Scratch } from "./scratch-database";
import { SEED } from "./seed";

/**
 * The ingredients step of `catalog import`: after a tool's rows land, the
 * import scans each rendered video's source and records it. blenderkc stands
 * in for the tools (a Python CLI, as the real one is), as
 * `blenderkc-import.test.ts` does. A scan that fails is a note, and the import
 * still succeeds.
 */

const reachable = await probe();

const VIDEO = "out/agents/loops/loops.mp4";
const SHOT = ["from blenderkc import kit", "", "def build(shot):", "    kit.rigs.dark_studio(shot)", "    kit.geo.box('a', 1)", ""].join("\n");

describe.skipIf(!reachable.ok)("ingredients in catalog import", () => {
  let scratch: Scratch;
  let work: string;
  let checkout: string;
  let dataRoot: string;
  const keys = ["DATABASE_URL", "MANIMKC_ROOT", "BLENDERKC_ROOT", "BLENDERKC_TOPICS"] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  async function put(file: string, text: string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }

  beforeAll(async () => {
    scratch = await migratedScratchDatabase();
    work = await mkdtemp(path.join(tmpdir(), "ingredients-import-"));
    checkout = path.join(work, "blenderkc");
    dataRoot = path.join(work, "blenderkc-home");
    await put(path.join(dataRoot, VIDEO), "loops render");
    await put(path.join(checkout, "topics", "agents", "loops", "shots", "AG1_Intro.py"), SHOT);
    const report = {
      outRoot: dataRoot,
      topics: [
        {
          path: "agents/loops",
          title: "The loops video",
          topic: "agent-tool-use-and-reasoning-loops",
          concepts: [],
          sections: [
            {
              section: "narrated",
              files: [{ file: "shots/AG1_Intro.py", scenes: ["AG1_Intro"] }],
              output: "loops.mp4",
              deliverable: { path: VIDEO, exists: true, duration: 12, sidecars: {} },
            },
          ],
        },
      ],
      drift: { orphans: [], unrendered: [] },
    };
    await put(
      path.join(checkout, "tools", "cli", "blenderkc"),
      `import sys\nsys.stdout.write(${JSON.stringify(JSON.stringify(report))})\n`,
    );
    process.env["DATABASE_URL"] = scratch.url;
    process.env["MANIMKC_ROOT"] = path.join(work, "no-manimkc");
    process.env["BLENDERKC_ROOT"] = checkout;
    delete process.env["BLENDERKC_TOPICS"];
  }, 60_000);

  afterAll(async () => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await scratch?.drop();
    if (work !== undefined) await rm(work, { recursive: true, force: true });
  });

  const notesOf = (result: Awaited<ReturnType<typeof runImportCommand>>) =>
    result.sources.find((s) => s.source === "blenderkc")?.notes ?? [];
  const rows = () => scratch.db.select().from(ingredientsTable);

  it("records each rendered video's ingredients and says so in the import's notes", async () => {
    const result = await runImportCommand({ dir: SEED });
    expect(notesOf(result)).toContain("ingredients: 1 written, 0 unchanged");
    const [row] = await rows();
    expect(row).toMatchObject({
      assetId: `blenderkc:${VIDEO}`,
      tool: "blenderkc",
      durationSeconds: 12,
      sceneCount: 1,
      scannerVersion: 2,
    });
    expect(row!.calls).toEqual({ "geo.box": 1, "rigs.dark_studio": 1 });
  });

  it("leaves the row and the notes alone when nothing moved", async () => {
    const before = (await rows())[0]!;
    const result = await runImportCommand({ dir: SEED });
    expect(notesOf(result).some((n) => n.startsWith("ingredients"))).toBe(false);
    expect((await rows())[0]!.computedAt).toEqual(before.computedAt);
  });

  it("notes a scan that cannot write, and the import still succeeds", async () => {
    // Move the table away so every write and read of it fails, then change the source.
    await put(path.join(checkout, "topics", "agents", "loops", "shots", "AG1_Intro.py"), `${SHOT}    kit.geo.box('b', 2)\n`);
    await scratch.db.run(sql`alter table asset_ingredients rename to asset_ingredients_away`);
    try {
      const result = await runImportCommand({ dir: SEED });
      expect(result.sources.map((s) => s.source)).toContain("blenderkc");
      expect(notesOf(result).join("\n")).toMatch(/ingredients: 0 written, 0 unchanged, 1 skipped \(blenderkc:out\/agents\/loops\/loops\.mp4: /);
    } finally {
      await scratch.db.run(sql`alter table asset_ingredients_away rename to asset_ingredients`);
    }
    // The next import makes up what the failed one missed.
    const again = await runImportCommand({ dir: SEED });
    expect(notesOf(again)).toContain("ingredients: 1 written, 0 unchanged");
    expect((await rows())[0]!.calls).toMatchObject({ "geo.box": 2 });
  });

  it("forwards what makes a scan incomplete, so it does not look whole", async () => {
    // A topic folder past the cut-off for TypeScript tools: the compute half says so in its notes.
    const { computeIngredientsForTool } = await import("../src/index/ingredients-tools");
    const { BLENDERKC } = await import("../src/index/video-tool");
    const noTopics = await computeIngredientsForTool(
      BLENDERKC,
      { topics: [] } as never,
      checkout,
      { env: { BLENDERKC_TOPICS: "relative/path" } },
    );
    expect(noTopics.notes.join()).toContain("must be an absolute path");

    // Through the import: the same note lands in the tool's notes.
    const previous = process.env["BLENDERKC_TOPICS"];
    process.env["BLENDERKC_TOPICS"] = "relative/path";
    try {
      const result = await runImportCommand({ dir: SEED });
      expect(notesOf(result).join("\n")).toContain("ingredients: BLENDERKC_TOPICS must be an absolute path");
    } finally {
      if (previous === undefined) delete process.env["BLENDERKC_TOPICS"];
      else process.env["BLENDERKC_TOPICS"] = previous;
    }
  });

  it("notes a topic whose source cannot be read and imports the rest", async () => {
    await rm(path.join(checkout, "topics", "agents", "loops", "shots", "AG1_Intro.py"));
    const result = await runImportCommand({ dir: SEED });
    expect(notesOf(result).join("\n")).toContain("AG1_Intro.py cannot be read");
    // The stored row stays: a scan that cannot read a source does not delete what it knew.
    expect(await rows()).toHaveLength(1);
  });
});
