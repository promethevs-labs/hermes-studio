import { asset, assetIngredients as ingredientsTable, COMMONS_OWNER, learner, LOCAL_LEARNER_ID, ownerScope } from "@hermes/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { IndexError } from "../src/index/errors";
import { assetIngredients, listAssetIngredients, upsertAssetIngredients } from "../src/index/ingredients";
import { migratedScratchDatabase, probe, type Scratch, sqlstate } from "./scratch-database";
import { storedBlob } from "./stored-blob";

/**
 * `asset_ingredients`: what a video was made of, one row per video, derived
 * from its source. A later change computes the values; this holds the store:
 * a scan replaces the row, the owner is the asset's, a scoped read keeps
 * another owner's rows out, the row goes with its asset, and the table holds
 * both JSON columns to objects.
 */

const reachable = await probe();
const OTHER = "owner-b";
const MINE = "manimkc:out/alpha/mine.mp4";
const THEIRS = "manimkc:out/alpha/theirs.mp4";

const scan = (assetId: string, overrides: Partial<Parameters<typeof upsertAssetIngredients>[1]> = {}) => ({
  assetId,
  tool: "manimkc",
  scannerVersion: 1,
  sourceHash: "b".repeat(64),
  sceneCount: 4,
  durationSeconds: 92.5,
  calls: { Write: 3, FadeIn: 7 },
  metrics: { wordsPerMinute: 148 },
  ...overrides,
});

describe.skipIf(!reachable.ok)("asset_ingredients", () => {
  let scratch: Scratch;

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

  beforeAll(async () => {
    scratch = await migratedScratchDatabase();
    await scratch.db
      .insert(learner)
      .values([{ id: LOCAL_LEARNER_ID }, { id: OTHER }, { id: COMMONS_OWNER }])
      .onConflictDoNothing();
  }, 60_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  beforeEach(async () => {
    await scratch.db.delete(ingredientsTable);
    await scratch.db.delete(asset);
    await video(MINE, LOCAL_LEARNER_ID);
    await video(THEIRS, OTHER);
  });

  it("stores a scan under the asset's owner and replaces it on the next", async () => {
    const first = await upsertAssetIngredients(scratch.db, scan(MINE));
    expect(first).toMatchObject({ assetId: MINE, ownerId: LOCAL_LEARNER_ID, sceneCount: 4, calls: { Write: 3, FadeIn: 7 } });

    await upsertAssetIngredients(scratch.db, scan(MINE, { scannerVersion: 2, sceneCount: 5, calls: {}, metrics: {} }));
    const read = await assetIngredients(scratch.db, ownerScope(LOCAL_LEARNER_ID), MINE);
    expect(read).toMatchObject({ scannerVersion: 2, sceneCount: 5, calls: {}, metrics: {} });
    expect(await scratch.db.select().from(ingredientsTable)).toHaveLength(1);
  });

  it("reads only what the scope can read", async () => {
    await upsertAssetIngredients(scratch.db, scan(MINE));
    await upsertAssetIngredients(scratch.db, scan(THEIRS));
    expect((await upsertAssetIngredients(scratch.db, scan(THEIRS))).ownerId).toBe(OTHER);
    expect(await assetIngredients(scratch.db, ownerScope(LOCAL_LEARNER_ID), THEIRS)).toBeNull();
    expect((await listAssetIngredients(scratch.db, ownerScope(LOCAL_LEARNER_ID))).map((r) => r.assetId)).toEqual([MINE]);
    expect((await listAssetIngredients(scratch.db, ownerScope(OTHER))).map((r) => r.assetId)).toEqual([THEIRS]);
  });

  it("refuses a missing asset and malformed calls or metrics by name", async () => {
    await expect(upsertAssetIngredients(scratch.db, scan("manimkc:out/nowhere.mp4"))).rejects.toThrow(IndexError);
    await expect(upsertAssetIngredients(scratch.db, scan(MINE, { calls: { Write: -1 } }))).rejects.toThrow(/whole count/);
    await expect(
      upsertAssetIngredients(scratch.db, scan(MINE, { metrics: [] as unknown as Record<string, unknown> })),
    ).rejects.toThrow(/metrics/);
  });

  it("goes with its asset when an import prunes it", async () => {
    await upsertAssetIngredients(scratch.db, scan(MINE));
    await scratch.db.delete(asset).where(eq(asset.id, MINE));
    expect(await scratch.db.select().from(ingredientsTable)).toEqual([]);
  });

  it("holds both JSON columns to objects in the table", async () => {
    for (const [field, value] of [
      ["calls", "[]"],
      ["metrics", '"x"'],
      ["calls", "not json"],
    ] as const) {
      const error = await scratch.db
        .execute(
          // Raw, since drizzle's json mode would serialise the value itself.
          sql.raw(`insert into asset_ingredients (asset_id, owner_id, tool, scanner_version, source_hash, calls, metrics)
           values ('${MINE}', 'local', 'manimkc', 1, 'h', ${field === "calls" ? `'${value}'` : "'{}'"}, ${field === "metrics" ? `'${value}'` : "'{}'"})`),
        )
        .then(() => null, (caught: unknown) => caught);
      expect(error, `${field} ${value}`).not.toBeNull();
    }
    const versionError = await scratch.db
      .insert(ingredientsTable)
      .values({ ...scan(MINE, { scannerVersion: 0 }), ownerId: LOCAL_LEARNER_ID })
      .then(() => null, (caught: unknown) => caught);
    expect(sqlstate(versionError)).toBe("23514");
  });
});
