import { createHash } from "node:crypto";

import { asset, assetJob, assetRating, COMMONS_OWNER, job, learner, LOCAL_LEARNER_ID, topic } from "@hermes/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations } from "../src/migrations";
import { partialMigrations } from "./partial-migrations";
import { currentRating, listCurrentRatings, rateAsset, ratingHistory, StateError } from "../src/state";
import { createScratchDatabase, migratedScratchDatabase, probe, type Scratch, sqlstate } from "./scratch-database";
import { storedBlob } from "./stored-blob";

/**
 * `asset_rating`: a learner's thumbs up or down on an asset, as an
 * append-only log.
 *
 * Held here: every rating is a new row and the newest is current; a 0 clears
 * it and reads distinguishably from "never rated"; tags are checked against
 * the value; an asset the learner cannot read, or that does not exist, is
 * refused; another learner's ratings stay theirs; the job that made the
 * asset and the bytes that were rated are snapshotted; a pruned asset keeps
 * its ratings; and the table refuses what the writer would never store.
 */

const reachable = await probe();
const OTHER = "owner-b";
const MINE = "link:mine";
const COMMONS = "link:commons";
const THEIRS = "link:theirs";

function link(id: string, ownerId: string) {
  return { id, kind: "link", url: `https://example.com/${id}`, title: id, sourceRepo: "hermes", ownerId };
}

const rate = (assetId: string, value: number, extra: { tags?: string[]; note?: string | null; learnerId?: string } = {}) =>
  rateAsset(scratch.db, { learnerId: extra.learnerId ?? LOCAL_LEARNER_ID, assetId, value, tags: extra.tags, note: extra.note, surface: "library" });

let scratch: Scratch;

describe.skipIf(!reachable.ok)("asset_rating", () => {
  beforeAll(async () => {
    scratch = await migratedScratchDatabase();
    await scratch.db
      .insert(learner)
      .values([{ id: LOCAL_LEARNER_ID }, { id: OTHER }, { id: COMMONS_OWNER }])
      .onConflictDoNothing();
    await scratch.db.insert(topic).values({ slug: "alpha", title: "Alpha", domain: "testing" });
  }, 60_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  beforeEach(async () => {
    await scratch.db.delete(assetRating);
    await scratch.db.delete(assetJob);
    await scratch.db.delete(job);
    await scratch.db.delete(asset);
    await scratch.db.insert(asset).values([link(MINE, LOCAL_LEARNER_ID), link(COMMONS, COMMONS_OWNER), link(THEIRS, OTHER)]);
  });

  it("appends every rating and reads the newest back as current", async () => {
    const first = await rate(MINE, -1, { tags: ["too-slow", "voice", "too-slow"], note: "  drags in the middle " });
    expect(first).toMatchObject({
      assetId: MINE,
      value: -1,
      tags: ["too-slow", "voice"],
      note: "drags in the middle",
      surface: "library",
      jobId: null,
      assetHash: null,
    });
    expect(Date.parse(first.at)).not.toBeNaN();

    const second = await rate(MINE, 1, { tags: ["clear"] });
    expect(await currentRating(scratch.db, LOCAL_LEARNER_ID, MINE)).toEqual(second);
    expect((await ratingHistory(scratch.db, LOCAL_LEARNER_ID, MINE)).map((r) => r.id)).toEqual([second.id, first.id]);
    expect(await scratch.db.select().from(assetRating)).toHaveLength(2);
  });

  it("orders two ratings in one millisecond by the order they were written", async () => {
    const at = new Date("2026-11-20T10:00:00.000Z");
    await scratch.db.insert(assetRating).values([
      { id: "z-first", learnerId: LOCAL_LEARNER_ID, assetId: MINE, value: -1, surface: "library", at },
      { id: "a-second", learnerId: LOCAL_LEARNER_ID, assetId: MINE, value: 1, surface: "library", at },
    ]);
    expect((await currentRating(scratch.db, LOCAL_LEARNER_ID, MINE))?.id).toBe("a-second");
    expect((await listCurrentRatings(scratch.db, LOCAL_LEARNER_ID)).map((r) => r.id)).toEqual(["a-second"]);
  });

  it("takes a 0 as a clear: a row of its own, distinguishable from never rated", async () => {
    expect(await currentRating(scratch.db, LOCAL_LEARNER_ID, MINE)).toBeNull();
    await rate(MINE, -1, { tags: ["wrong"] });
    const cleared = await rate(MINE, 0);
    expect(cleared).toMatchObject({ value: 0, tags: [], note: null });
    expect(await currentRating(scratch.db, LOCAL_LEARNER_ID, MINE)).toEqual(cleared);
    expect(await ratingHistory(scratch.db, LOCAL_LEARNER_ID, MINE)).toHaveLength(2);
  });

  it("checks tags against the value, and refuses a bad value, note or surface", async () => {
    await expect(rate(MINE, 1, { tags: ["too-slow"] })).rejects.toThrow(RangeError);
    await expect(rate(MINE, -1, { tags: ["clear"] })).rejects.toThrow(RangeError);
    await expect(rate(MINE, 0, { tags: ["wrong"] })).rejects.toThrow(/carries no tags/);
    await expect(rate(MINE, 2)).rejects.toThrow(RangeError);
    await expect(rate(MINE, -1, { note: "x".repeat(2001) })).rejects.toThrow(/2000/);
    await expect(
      rateAsset(scratch.db, { learnerId: LOCAL_LEARNER_ID, assetId: MINE, value: 1, surface: "email" }),
    ).rejects.toThrow(/surface/);
    expect(await scratch.db.select().from(assetRating)).toEqual([]);
  });

  it("refuses an asset the learner cannot read, and one that does not exist", async () => {
    await expect(rate(THEIRS, 1)).rejects.toThrow(StateError);
    await expect(rate("link:nowhere", 1)).rejects.toThrow(StateError);
    expect(await scratch.db.select().from(assetRating)).toEqual([]);
    // The commons is readable by everyone, so it can be rated.
    await expect(rate(COMMONS, 1)).resolves.toMatchObject({ value: 1 });
  });

  it("keeps one learner's ratings from another", async () => {
    await rate(COMMONS, -1, { tags: ["same-look"] });
    await rate(COMMONS, 1, { learnerId: OTHER, tags: ["good-visuals"] });
    expect((await currentRating(scratch.db, LOCAL_LEARNER_ID, COMMONS))?.value).toBe(-1);
    expect((await currentRating(scratch.db, OTHER, COMMONS))?.value).toBe(1);
    expect(await ratingHistory(scratch.db, OTHER, COMMONS)).toHaveLength(1);
    expect((await listCurrentRatings(scratch.db, OTHER)).map((r) => r.assetId)).toEqual([COMMONS]);
    expect(await currentRating(scratch.db, OTHER, MINE)).toBeNull();
  });

  it("lists the newest rating per asset, clears included", async () => {
    await rate(MINE, -1);
    await rate(COMMONS, 1);
    await rate(MINE, 0);
    const listed = await listCurrentRatings(scratch.db, LOCAL_LEARNER_ID);
    expect(listed.map((r) => [r.assetId, r.value])).toEqual([
      [MINE, 0],
      [COMMONS, 1],
    ]);
  });

  it("snapshots the job that made the asset, and the bytes that were rated", async () => {
    const video = "manimkc:out/alpha/lec01.mp4";
    const blobKey = await storedBlob(scratch.db, video, "mp4");
    await scratch.db.insert(asset).values({
      id: video,
      kind: "video",
      path: "out/alpha/lec01.mp4",
      blobKey,
      sourceRepo: "manimkc",
      ownerId: LOCAL_LEARNER_ID,
    });
    // No content hash on the row: the blob's sha256 stands in.
    const blobHash = createHash("sha256").update(video).digest("hex");
    expect((await rate(video, 1)).assetHash).toBe(blobHash);

    await scratch.db.update(asset).set({ contentHash: "a".repeat(64) }).where(eq(asset.id, video));
    for (const [id, writtenAt] of [
      ["job-old", new Date("2026-11-01T00:00:00Z")],
      ["job-new", new Date("2026-11-10T00:00:00Z")],
    ] as const) {
      await scratch.db.insert(job).values({ id, kind: "video", topicSlug: "alpha", targetPath: `videos/${id}.mp4`, idempotencyKey: id });
      await scratch.db.insert(assetJob).values({ assetId: video, jobId: id, contentHash: "a".repeat(64), bytes: 1, writtenAt });
    }
    const rated = await rate(video, -1, { tags: ["too-long"] });
    expect(rated.jobId).toBe("job-new");
    expect(rated.assetHash).toBe("a".repeat(64));
  });

  it("keeps a pruned asset's ratings, with no foreign key to stop the prune", async () => {
    await rate(MINE, 1);
    await scratch.db.delete(asset).where(eq(asset.id, MINE));
    expect((await currentRating(scratch.db, LOCAL_LEARNER_ID, MINE))?.value).toBe(1);
    expect((await listCurrentRatings(scratch.db, LOCAL_LEARNER_ID)).map((r) => r.assetId)).toEqual([MINE]);
    // A rating of a pruned asset is refused until it is written back.
    await expect(rate(MINE, -1)).rejects.toThrow(StateError);
  });

  it("refuses in the table what the writer never stores", async () => {
    const base = { learnerId: LOCAL_LEARNER_ID, assetId: MINE, surface: "library" };
    const bad = [
      { ...base, id: "v", value: 2 },
      { ...base, id: "s", value: 1, surface: "email" },
      { ...base, id: "t", value: 1, tags: "clear" },
      { ...base, id: "t2", value: 1, tags: "[1,2,3,4,5,6,7,8,9]" },
      { ...base, id: "c", value: 0, tags: '["clear"]' },
      { ...base, id: "n", value: 1, note: "" },
      { ...base, id: "n2", value: 1, note: " padded" },
      { ...base, id: "n3", value: 1, note: "x".repeat(2001) },
    ];
    for (const row of bad) {
      const error = await scratch.db
        .insert(assetRating)
        .values(row)
        .then(() => null, (caught: unknown) => caught);
      expect(sqlstate(error), row.id).toBe("23514");
    }
  });

  it("goes with its learner", async () => {
    await scratch.db.insert(learner).values({ id: "leaving" });
    await rate(COMMONS, 1, { learnerId: "leaving" });
    await scratch.db.delete(learner).where(eq(learner.id, "leaving"));
    expect(await scratch.db.select().from(assetRating).where(eq(assetRating.learnerId, "leaving"))).toEqual([]);
  });
});

describe.skipIf(!reachable.ok)("asset ratings before 0005", () => {
  let behind: Scratch;

  beforeAll(async () => {
    behind = await createScratchDatabase();
    await applyMigrations(behind.db);
    await behind.db.execute(sql`drop table asset_rating`);
    await behind.db.insert(asset).values(link(MINE, LOCAL_LEARNER_ID));
  }, 60_000);

  afterAll(async () => {
    await behind?.drop();
  });

  it("reads as never rated, and refuses a write with the command to run", async () => {
    expect(await currentRating(behind.db, LOCAL_LEARNER_ID, MINE)).toBeNull();
    expect(await ratingHistory(behind.db, LOCAL_LEARNER_ID, MINE)).toEqual([]);
    expect(await listCurrentRatings(behind.db, LOCAL_LEARNER_ID)).toEqual([]);
    await expect(
      rateAsset(behind.db, { learnerId: LOCAL_LEARNER_ID, assetId: MINE, value: 1, surface: "library" }),
    ).rejects.toThrow(/catalog -- migrate/);
  });
});

describe.skipIf(!reachable.ok)("0005 on a database that already holds jobs", () => {
  let upgraded: Scratch;
  let folder: string;

  beforeAll(async () => {
    upgraded = await createScratchDatabase();
    // 0000 to 0004: the journal as it stood before the eval records.
    folder = await partialMigrations(5);
    await applyMigrations(upgraded.db, { folder });
    await upgraded.db.execute(sql`insert into learner (id) values (${LOCAL_LEARNER_ID}) on conflict do nothing`);
    await upgraded.db.execute(sql`insert into topic (slug, title, domain) values ('alpha', 'Alpha', 'testing')`);
    await upgraded.db.execute(
      sql`insert into job (id, kind, topic_slug, target_path, idempotency_key) values ('old-job', 'diagram', 'alpha', 'learn/assets/old.tldr', 'old-key')`,
    );
  }, 60_000);

  afterAll(async () => {
    await upgraded?.drop();
  });

  it("adds the two columns in place: the job keeps its row, and no other table is rebuilt", async () => {
    const before = await upgraded.db.execute<{ rowid: number }>(sql`select rowid from job where id = 'old-job'`);
    const tablesBefore = await upgraded.db.execute<{ name: string; sql: string }>(
      sql`select name, sql from sqlite_master where type = 'table' and name not like '\_\_drizzle%' escape '\\' order by name`,
    );
    await applyMigrations(upgraded.db);

    const after = await upgraded.db.execute<{ rowid: number; run: string | null; review: string | null }>(
      sql`select rowid, run, review from job where id = 'old-job'`,
    );
    expect(after.rows).toEqual([{ rowid: before.rows[0]!.rowid, run: null, review: null }]);

    // Every table that existed keeps its CREATE statement, but `job`, which
    // only gains the two columns.
    const tablesAfter = new Map(
      (await upgraded.db.execute<{ name: string; sql: string }>(sql`select name, sql from sqlite_master where type = 'table'`)).rows.map(
        (row) => [row.name, row.sql],
      ),
    );
    for (const { name, sql: created } of tablesBefore.rows) {
      if (name === "job") {
        // ALTER TABLE ADD COLUMN writes the new columns after the last column
        // definition; a rebuild would have rewritten the whole statement.
        const added = ", `run` text, `review` text";
        expect(tablesAfter.get(name)).toContain(added);
        expect(tablesAfter.get(name)?.replace(added, "")).toBe(created);
      } else {
        expect(tablesAfter.get(name), name).toBe(created);
      }
    }
    expect(tablesAfter.has("asset_rating")).toBe(true);
    expect(tablesAfter.has("asset_ingredients")).toBe(true);
  });
});
