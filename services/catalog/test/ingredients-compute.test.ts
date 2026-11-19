import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { asset, assetIngredients as ingredientsTable, COMMONS_OWNER, learner, LOCAL_LEARNER_ID, ownerScope } from "@hermes/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assetIngredients } from "../src/index/ingredients";
import {
  computeIngredientsForTool,
  computeStudioIngredients,
  manimkcLibraryNames,
  resolveTopicsRoot,
  storeToolIngredients,
} from "../src/index/ingredients-scan";
import { BLENDERKC, MANIMKC, REMOTIONKC, REVIDEOKC, type TopicsReport } from "../src/index/video-tool";
import { migratedScratchDatabase, probe, type Scratch } from "./scratch-database";
import { storedBlob } from "./stored-blob";

/**
 * The compute half of the ingredients scan on fake topic trees under the OS
 * temp directory, and the store half on a scratch database. Nothing reads the
 * real tools or the real catalog.
 */

const reachable = await probe();
const OTHER = "owner-b";

let work: string;

async function write(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

/** A report topic with one rendered section naming `files`, and one unrendered section. */
function topic(topicPath: string, video: string, files: string[], extra: Record<string, unknown> = {}) {
  return {
    path: topicPath,
    sections: [
      {
        section: "narrated",
        files: files.map((file) => ({ file, scenes: ["S1_One", "S2_Two"] })),
        deliverable: { path: video, exists: true, duration: 61.5 },
        ...extra,
      },
      { section: "silent", files: [], deliverable: { path: `${video}.silent`, exists: false } },
    ],
  };
}

const SCENE = [
  "from manimlib import *",
  "from cslib import *",
  "",
  "class S1_One(Scene):",
  "    def construct(self):",
  "        t = caption('x')",
  "        self.play(FadeIn(t), FadeOut(t))",
  "",
].join("\n");

beforeAll(async () => {
  work = await mkdtemp(path.join(tmpdir(), "ingredients-compute-"));
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("computeIngredientsForTool", () => {
  it("scans manimkc's section files under the report's topicsRoot, with its library names", async () => {
    const checkout = path.join(work, "manim-checkout");
    const topicsRoot = path.join(work, "manim-topics");
    await write(path.join(checkout, "lib", "cslib.py"), "def caption(s):\n    return s\n\ndef body(s):\n    return s\n");
    await write(path.join(topicsRoot, "demo", "one", "scene.py"), SCENE);
    const report = {
      topicsRoot,
      topics: [
        topic("demo/one", "out/demo/one/one.mp4", ["scene.py"]),
        // The second topic names a file that is not there.
        topic("demo/two", "out/demo/two/two.mp4", ["gone.py"]),
      ],
      drift: {},
    } as unknown as TopicsReport;

    const computed = await computeIngredientsForTool(MANIMKC, report, checkout);

    expect(computed.videos).toHaveLength(1);
    const one = computed.videos[0]!;
    expect(one.assetId).toBe("manimkc:out/demo/one/one.mp4");
    expect(one.durationSeconds).toBe(61.5);
    // The report names two scenes, which wins over counting `construct`.
    expect(one.ingredients.sceneCount).toBe(2);
    expect(one.ingredients.calls).toEqual({ FadeIn: 1, FadeOut: 1, caption: 1 });
    expect(one.ingredients.metrics).toMatchObject({ helperCalls: 1, animationCalls: 2, plays: 1, fadeShare: 1 });
    expect(computed.skipped).toHaveLength(1);
    expect(computed.skipped[0]).toMatchObject({ id: "manimkc:out/demo/two/two.mp4" });
    expect(computed.skipped[0]!.reason).toContain("gone.py");
  });

  it("notes a missing library instead of failing, and counts no star-imported helper", async () => {
    const topicsRoot = path.join(work, "manim-topics-nolib");
    await write(path.join(topicsRoot, "demo", "one", "scene.py"), SCENE);
    const report = { topicsRoot, topics: [topic("demo/one", "out/demo/one/one.mp4", ["scene.py"])], drift: {} } as unknown as TopicsReport;
    const computed = await computeIngredientsForTool(MANIMKC, report, path.join(work, "no-such-checkout"));
    expect(computed.notes.join()).toContain("library was not found");
    expect(computed.videos[0]!.ingredients.metrics.helperCalls).toBe(0);
    expect(await manimkcLibraryNames(path.join(work, "no-such-checkout"))).toBeNull();
  });

  it("reads blenderkc's files from the default topics folder", async () => {
    const checkout = path.join(work, "blender-checkout");
    await write(
      path.join(checkout, "topics", "demo", "gpu", "shots", "A1_Intro.py"),
      "from blenderkc import kit\n\ndef build(shot):\n    kit.rigs.dark_studio(shot)\n",
    );
    const report = { topics: [topic("demo/gpu", "out/demo/gpu/gpu.mp4", ["shots/A1_Intro.py"])], drift: {} } as unknown as TopicsReport;
    const computed = await computeIngredientsForTool(BLENDERKC, report, checkout, { env: {} });
    expect(computed.skipped).toEqual([]);
    expect(computed.videos[0]).toMatchObject({ assetId: "blenderkc:out/demo/gpu/gpu.mp4" });
    expect(computed.videos[0]!.ingredients.calls).toEqual({ "rigs.dark_studio": 1 });
    expect(computed.videos[0]!.ingredients.metrics.uses3d).toBe(true);
  });

  it("scans every .ts and .tsx under a TypeScript topic, skipping node_modules, dist and dot folders", async () => {
    const checkout = path.join(work, "remotion-checkout");
    const topics = path.join(work, "remotion-topics");
    await write(path.join(checkout, ".env"), `# the tool's own dotenv\nREMOTIONKC_TOPICS=${topics}\n`);
    const dir = path.join(topics, "demo", "chart");
    await write(path.join(dir, "composition.tsx"), 'import { spring } from "remotion";\nimport { ramp } from "#lib";\nspring();\nramp(1);\n');
    await write(path.join(dir, "parts", "Scene2.tsx"), 'import { Tex } from "#lib";\nexport const A = () => <Tex />;\n');
    await write(path.join(dir, "node_modules", "dep", "index.tsx"), "export const x = 1;\n");
    await write(path.join(dir, "dist", "out.ts"), "export const y = 1;\n");
    await write(path.join(dir, ".cache", "z.ts"), "export const z = 1;\n");
    await write(path.join(dir, "notes.md"), "not source\n");
    const report = { topics: [topic("demo/chart", "out/demo/chart/chart.mp4", [])], drift: {} } as unknown as TopicsReport;

    const computed = await computeIngredientsForTool(REMOTIONKC, report, checkout, { env: {} });

    expect(computed.skipped).toEqual([]);
    const only = computed.videos[0]!;
    expect(only.assetId).toBe("remotionkc:out/demo/chart/chart.mp4");
    expect(only.ingredients.metrics.files).toBe(2);
    expect(only.ingredients.metrics).toMatchObject({ helperCalls: 2, engineCalls: 1 });
    // The report's files have no `scenes`, and a TypeScript scan has no count of its own.
    expect(only.ingredients.sceneCount).toBeNull();
  });

  it("skips, and does not throw, for a topic folder that is not there or a topics value that is relative", async () => {
    const missing = { topics: [topic("demo/none", "out/demo/none/none.mp4", [])], drift: {} } as unknown as TopicsReport;
    const empty = await computeIngredientsForTool(REVIDEOKC, missing, path.join(work, "revideo"), { env: {} });
    expect(empty.videos).toEqual([]);
    expect(empty.skipped).toHaveLength(1);

    const relative = await computeIngredientsForTool(REVIDEOKC, missing, work, { env: { REVIDEOKC_TOPICS: "relative/topics" } });
    expect(relative.skipped[0]!.reason).toContain("must be an absolute path");

    const odd = { topics: [{ path: "../../etc", sections: [{ deliverable: { path: "out/x.mp4", exists: true } }] }, null, { path: 7 }] } as unknown as TopicsReport;
    const refused = await computeIngredientsForTool(MANIMKC, { ...odd, topicsRoot: work } as TopicsReport, work);
    expect(refused.videos).toEqual([]);
    expect(refused.skipped[0]!.reason).toContain("leaves the topics folder");
  });

  it("resolves the topics root from the report, the environment, the checkout's dotenv, then the checkout", async () => {
    const checkout = path.join(work, "root-order");
    await write(path.join(checkout, ".env"), `export REVIDEOKC_TOPICS="${path.join(work, "from-dotenv")}"\n`);
    const empty = { topics: [] } as unknown as TopicsReport;
    expect(await resolveTopicsRoot(REVIDEOKC, { ...empty, topicsRoot: "/from/report" } as TopicsReport, checkout, {})).toEqual({ dir: "/from/report" });
    expect(await resolveTopicsRoot(REVIDEOKC, empty, checkout, { REVIDEOKC_TOPICS: "/from/env" })).toEqual({ dir: "/from/env" });
    expect(await resolveTopicsRoot(REVIDEOKC, empty, checkout, {})).toEqual({ dir: path.join(work, "from-dotenv") });
    expect(await resolveTopicsRoot(REVIDEOKC, empty, path.join(work, "bare"), {})).toEqual({ dir: path.join(work, "bare", "topics") });
  });
});

describe("computeStudioIngredients", () => {
  it("scans the scene files of a studio source with the brief's tool", () => {
    const manim = computeStudioIngredients(
      { files: { "scene.py": SCENE, "topic.yml": "topic: x\n" }, brief: {} },
      58.4,
      ["caption"],
    );
    if ("problem" in manim) throw new Error(manim.problem);
    expect(manim.tool).toBe("manimkc");
    expect(manim.durationSeconds).toBe(58.4);
    expect(manim.ingredients.metrics).toMatchObject({ files: 1, helperCalls: 1 });

    const ts = computeStudioIngredients(
      { files: { "scene.tsx": 'import { ramp } from "#lib";\nramp(1);\n', "narration.json": "[]" }, brief: { tool: "revideokc" } },
      null,
    );
    if ("problem" in ts) throw new Error(ts.problem);
    expect(ts.tool).toBe("revideokc");
    expect(ts.ingredients.metrics).toMatchObject({ files: 1, helperCalls: 1 });
  });

  it("answers with a reason, not a throw, for a source it cannot read", () => {
    expect(computeStudioIngredients(null, null)).toEqual({ problem: "the video's source holds no files" });
    expect(computeStudioIngredients({ files: { "topic.yml": "x" }, brief: {} }, null)).toEqual({
      problem: "the video's source holds no scene files",
    });
    expect(computeStudioIngredients({ files: { "a.py": "x = 1" }, brief: { tool: "unknown" } }, null)).toEqual({
      problem: "the brief names a video tool the scanner does not know",
    });
  });
});

describe.skipIf(!reachable.ok)("storeToolIngredients", () => {
  let scratch: Scratch;
  const MINE = "manimkc:out/demo/one/one.mp4";
  const THEIRS = "manimkc:out/demo/other/other.mp4";
  const scope = ownerScope(LOCAL_LEARNER_ID);

  async function video(id: string, ownerId: string) {
    await scratch.db.insert(asset).values({
      id,
      kind: "video",
      path: id.replace("manimkc:", ""),
      blobKey: await storedBlob(scratch.db, id, "mp4"),
      sourceRepo: "manimkc",
      ownerId,
    });
  }

  const computation = (scene: string, extra: string[] = []) => {
    const ing = (assetId: string) => ({
      assetId,
      topicPath: "demo/one",
      durationSeconds: 61.5,
      ingredients: computeStudioIngredients({ files: { "scene.py": scene }, brief: {} }, 61.5, ["caption"]),
    });
    const videos = [MINE, ...extra].map(ing).map((v) => {
      if ("problem" in v.ingredients) throw new Error(v.ingredients.problem);
      return { ...v, ingredients: v.ingredients.ingredients };
    });
    return { tool: "manimkc" as const, videos, skipped: [], notes: [] };
  };

  beforeAll(async () => {
    scratch = await migratedScratchDatabase();
    await scratch.db.insert(learner).values([{ id: LOCAL_LEARNER_ID }, { id: OTHER }, { id: COMMONS_OWNER }]).onConflictDoNothing();
    await video(MINE, LOCAL_LEARNER_ID);
    await video(THEIRS, OTHER);
  }, 60_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  it("writes a row, leaves it alone on a second run, and rewrites it when forced or when the source moves", async () => {
    const first = await storeToolIngredients(scratch.db, scope, computation(SCENE));
    expect(first).toMatchObject({ scanned: 1, written: 1, unchanged: 0, skipped: [] });
    const row = await assetIngredients(scratch.db, scope, MINE);
    expect(row).toMatchObject({ tool: "manimkc", durationSeconds: 61.5, scannerVersion: 1 });
    expect(row!.calls).toEqual({ FadeIn: 1, FadeOut: 1, caption: 1 });

    const again = await storeToolIngredients(scratch.db, scope, computation(SCENE));
    expect(again).toMatchObject({ written: 0, unchanged: 1 });
    const computedAt = (await assetIngredients(scratch.db, scope, MINE))!.computedAt;
    expect(computedAt).toBe(row!.computedAt);

    const forced = await storeToolIngredients(scratch.db, scope, computation(SCENE), { force: true });
    expect(forced).toMatchObject({ written: 1, unchanged: 0 });

    const changed = await storeToolIngredients(scratch.db, scope, computation(`${SCENE}        Write(t)\n`));
    expect(changed.written).toBe(1);
    expect((await assetIngredients(scratch.db, scope, MINE))!.calls).toMatchObject({ Write: 1 });
  });

  it("rewrites a row whose duration moved, and a row from another scanner version", async () => {
    const moved = computation(SCENE);
    moved.videos[0]!.durationSeconds = 70;
    expect((await storeToolIngredients(scratch.db, scope, moved)).written).toBe(1);
    expect((await assetIngredients(scratch.db, scope, MINE))!.durationSeconds).toBe(70);

    await scratch.db.update(ingredientsTable).set({ scannerVersion: 2 }).where(eq(ingredientsTable.assetId, MINE));
    expect((await storeToolIngredients(scratch.db, scope, moved)).written).toBe(1);
    expect((await assetIngredients(scratch.db, scope, MINE))!.scannerVersion).toBe(1);
  });

  it("skips, with a reason, a video the catalog does not hold and one the owner cannot read", async () => {
    const result = await storeToolIngredients(
      scratch.db,
      scope,
      computation(SCENE, ["manimkc:out/demo/unknown/unknown.mp4", THEIRS]),
    );
    expect(result.skipped.map((s) => s.id).sort()).toEqual([THEIRS, "manimkc:out/demo/unknown/unknown.mp4"].sort());
    expect(result.skipped.every((s) => s.reason.includes("no such video"))).toBe(true);
    expect(await assetIngredients(scratch.db, ownerScope(OTHER), THEIRS)).toBeNull();
  });

  it("carries the compute half's skips into its own", async () => {
    const result = await storeToolIngredients(scratch.db, scope, {
      ...computation(SCENE),
      skipped: [{ id: "manimkc:out/x.mp4", reason: "gone.py cannot be read" }],
    });
    expect(result.skipped).toEqual([{ id: "manimkc:out/x.mp4", reason: "gone.py cannot be read" }]);
  });
});
