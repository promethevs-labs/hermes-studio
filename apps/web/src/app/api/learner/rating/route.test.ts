import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { asset, assetRating, learner } from "@hermes/schema";
import { RATING_LIMITS, ratingPromptKey } from "@hermes/schema/shared";

import {
  clearTables,
  migratedScratchDatabase,
  probe,
  type Scratch,
} from "../../../../../../../services/catalog/test/scratch-database";
import {
  ASSETS,
  seedAssets,
  seedContent,
} from "../../../../../../../services/catalog/test/state-fixture";
import { storedBlob } from "../../../../../../../services/catalog/test/stored-blob";

const signedIn = vi.hoisted(() => ({ value: true }));
vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  isSignedIn: async () => signedIn.value,
}));

/**
 * `POST /api/learner/rating`, and the one new key family the preference route
 * takes (`ratingPrompt:<asset id>`), against a scratch database. Its own file
 * for the reason `../favorite/route.test.ts` gives: the import has to follow
 * the scratch database being made.
 */

const reachable = await probe();

const ORIGIN = "http://localhost:3000";

function request(path: string, body: unknown, origin: string | null = ORIGIN): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json", host: "localhost:3000" };
  if (origin !== null) headers.origin = origin;
  return new Request(`${ORIGIN}/api/learner/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

describe.skipIf(!reachable.ok)("POST /api/learner/rating", () => {
  let scratch: Scratch;
  let rating: (req: Request) => Promise<Response>;
  let preference: (req: Request) => Promise<Response>;
  let state: typeof import("@hermes/catalog/state");
  let previousDatabaseUrl: string | undefined;

  beforeAll(async () => {
    scratch = await migratedScratchDatabase();
    await seedContent(scratch.db);
    await seedAssets(scratch.db);
    // An asset of another owner's: the scope the write looks it up under must not reach it.
    await scratch.db.insert(learner).values({ id: "someone-else" }).onConflictDoNothing();
    await scratch.db
      .insert(asset)
      .values({
        id: "fx:theirs",
        kind: "video",
        path: "out/theirs/theirs.mp4",
        sourceRepo: "manimkc",
        ownerId: "someone-else",
        blobKey: await storedBlob(scratch.db, "fx:theirs", "mp4"),
      })
      .onConflictDoNothing();
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = scratch.url;
    const [ratingRoute, preferenceRoute, loaded] = await Promise.all([
      import("./route"),
      import("../preference/route"),
      import("@hermes/catalog/state"),
    ]);
    rating = ratingRoute.POST;
    preference = preferenceRoute.POST;
    state = loaded;
  }, 60_000);

  afterAll(async () => {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await scratch?.drop();
  });

  beforeEach(async () => {
    signedIn.value = true;
    await clearTables(scratch.db, ["asset_rating", "preference"]);
  });

  const call = async (body: unknown, origin?: string | null) => {
    const response = await rating(request("rating", body, origin));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const rows = () => scratch.db.select().from(assetRating);

  it("stores a thumbs down with its tags and note on the library surface, and answers the stored rating", async () => {
    const answer = await call({
      assetId: ASSETS.video,
      value: -1,
      tags: ["too-slow", "voice", "too-slow"],
      note: "  starts slowly  ",
    });
    expect(answer.status).toBe(200);
    expect(answer.body.result).toMatchObject({
      assetId: ASSETS.video,
      value: -1,
      tags: ["too-slow", "voice"],
      note: "starts slowly",
    });
    const [row] = await rows();
    expect(row).toMatchObject({ assetId: ASSETS.video, learnerId: "local", value: -1, surface: "library" });
    expect(JSON.parse(row!.tags)).toEqual(["too-slow", "voice"]);
    expect((await state.currentRating(scratch.db, "local", ASSETS.video))?.value).toBe(-1);
  });

  it("stores a thumbs up with up tags, and a clear as a row of its own", async () => {
    expect((await call({ assetId: ASSETS.video, value: 1, tags: ["clear"] })).status).toBe(200);
    expect((await call({ assetId: ASSETS.video, value: 0 })).status).toBe(200);
    expect(await rows()).toHaveLength(2);
    expect((await state.currentRating(scratch.db, "local", ASSETS.video))?.value).toBe(0);
  });

  it("takes a bare value, with no tags or note", async () => {
    const answer = await call({ assetId: ASSETS.video, value: 1 });
    expect(answer.status).toBe(200);
    expect(answer.body.result).toMatchObject({ value: 1, tags: [], note: null });
  });

  it("refuses tags that do not belong to the value, naming them, and stores nothing", async () => {
    const wrongWay = await call({ assetId: ASSETS.video, value: 1, tags: ["voice"] });
    expect(wrongWay.status).toBe(400);
    expect(wrongWay.body.error).toMatch(/voice/);
    const cleared = await call({ assetId: ASSETS.video, value: 0, tags: ["clear"] });
    expect(cleared.status).toBe(400);
    const unknown = await call({ assetId: ASSETS.video, value: -1, tags: ["boring"] });
    expect(unknown.status).toBe(400);
    expect(await rows()).toHaveLength(0);
  });

  it("refuses a value, a note or a body it cannot take", async () => {
    const long = "x".repeat(RATING_LIMITS.maxNoteChars + 1);
    for (const body of [
      { assetId: ASSETS.video, value: 2 },
      { assetId: ASSETS.video, value: "up" },
      { assetId: ASSETS.video },
      { value: 1 },
      { assetId: ASSETS.video, value: -1, note: long },
      { assetId: ASSETS.video, value: -1, note: 7 },
      { assetId: ASSETS.video, value: -1, tags: "voice" },
    ]) {
      expect((await call(body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect(await rows()).toHaveLength(0);
  });

  it("refuses an asset the catalog does not have", async () => {
    const answer = await call({ assetId: "fx:nope", value: 1 });
    expect(answer.status).toBe(400);
    expect(answer.body.error).toMatch(/No asset/);
    expect(await rows()).toHaveLength(0);
  });

  it("refuses another owner's asset as though it were not there", async () => {
    const answer = await call({ assetId: "fx:theirs", value: 1 });
    expect(answer.status).toBe(400);
    expect(answer.body.error).toMatch(/No asset/);
    expect(await rows()).toHaveLength(0);
  });

  it("is the same-origin, signed-in owner's alone", async () => {
    expect((await call({ assetId: ASSETS.video, value: 1 }, "https://evil.example")).status).toBe(403);
    signedIn.value = false;
    const out = await call({ assetId: ASSETS.video, value: 1 });
    expect(out.status).toBe(401);
    expect(await rows()).toHaveLength(0);
  });

  describe("the prompt's dismissal, through the preference route", () => {
    const dismiss = async (key: string, value: unknown) => {
      const response = await preference(request("preference", { key, value }));
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    it("stores { at } under ratingPrompt:<asset id> for an asset the owner can read", async () => {
      const at = "2026-11-20T10:00:00.000Z";
      expect((await dismiss(ratingPromptKey(ASSETS.video), { at })).status).toBe(200);
      expect(await state.readPreference(scratch.db, ratingPromptKey(ASSETS.video))).toEqual({ at });
    });

    it("refuses another owner's asset, an unknown one, an empty id and a value that is not { at }", async () => {
      const at = "2026-11-20T10:00:00.000Z";
      expect((await dismiss(ratingPromptKey("fx:theirs"), { at })).status).toBe(400);
      expect((await dismiss(ratingPromptKey("fx:nope"), { at })).status).toBe(400);
      expect((await dismiss(ratingPromptKey(""), { at })).status).toBe(400);
      for (const value of [true, "yes", {}, { at: "tomorrow" }]) {
        expect((await dismiss(ratingPromptKey(ASSETS.video), value)).status, JSON.stringify(value)).toBe(400);
      }
      expect(await state.readPreference(scratch.db, ratingPromptKey(ASSETS.video))).toBeUndefined();
    });

    it("still refuses any other key it does not list", async () => {
      expect((await dismiss("ratingPromptX", { at: "2026-11-20T10:00:00.000Z" })).status).toBe(400);
      expect((await dismiss("favorite:fx:video", { at: "2026-11-20T10:00:00.000Z" })).status).toBe(400);
    });
  });
});
