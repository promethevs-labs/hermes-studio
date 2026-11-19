import type { AddressInfo } from "node:net";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { candidatePath, candidateSvgPath, targetPath, targetSvgPath } from "../src/paths";
import type { JobRecord } from "../src/data/store";
import type { Runner } from "../src/diagram/runner";
import type { VideoDoctor, VideoDoctorReport } from "../src/video/doctor";
import type { VideoJobRecord } from "../src/video/types";

import { narratedBrief } from "./video-fixture";
import { topicListAnswer } from "./vocabulary";

/**
 * Why a person discarded a job: the optional `{ tags, note }` body of
 * `POST /api/jobs/{id}/discard`, for a video and for a diagram, over a real
 * socket. No body, an empty one or `{}` discards exactly as before; a valid
 * reason reaches the catalog's discard and the job view's `review`; a tag
 * outside `RATING_TAGS_DOWN` or a note past the limit answers 400 and leaves
 * the job in review.
 */

vi.mock("../src/canvas/canvas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/canvas/canvas")>();
  return { ...actual, doctor: vi.fn(async () => ({ code: 0, signal: null, stdout: "", stderr: "", json: null, timedOut: false })) };
});

const answer = (json: unknown = {}) => ({ ok: true, json, error: null, offline: false });
const catalogMock = vi.hoisted(() => ({
  topicList: vi.fn(),
  status: vi.fn(),
  jobEnqueue: vi.fn(),
  jobDiscard: vi.fn(),
  jobReview: vi.fn(),
  videoShow: vi.fn(),
  preferenceGet: vi.fn(),
}));
vi.mock("../src/data/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/data/catalog")>();
  return { ...actual, ...catalogMock };
});

const { createApi } = await import("../src/api");
const { Mirrors } = await import("../src/canvas/mirrors");
const { JobStore, RecordStore } = await import("../src/data/store");
const { VideoRunner } = await import("../src/video/runner");

let server: ReturnType<typeof createApi>;
let base: string;
let videoStore: InstanceType<typeof RecordStore<VideoJobRecord>>;
let diagramStore: InstanceType<typeof JobStore>;
let home: string;

const report: VideoDoctorReport = { ok: true, sandbox: true, metal: true, kokoro: true, voices: ["af_heart"], checks: [], checkedAt: new Date().toISOString() };
const doctor = { report: async () => report, current: () => report, start: () => undefined, stop: () => undefined } as unknown as VideoDoctor;

beforeEach(async () => {
  home = path.join(tmpdir(), `studio-discard-reason-${Date.now()}-${Math.random()}`);
  process.env.STUDIO_HOME = home;
  for (const mock of Object.values(catalogMock)) mock.mockReset();
  catalogMock.topicList.mockResolvedValue(topicListAnswer());
  catalogMock.status.mockResolvedValue(answer());
  catalogMock.jobEnqueue.mockResolvedValue(answer({ job: {} }));
  catalogMock.jobDiscard.mockResolvedValue(answer());
  catalogMock.jobReview.mockResolvedValue(answer());
  catalogMock.videoShow.mockResolvedValue(answer({ video: null }));
  catalogMock.preferenceGet.mockResolvedValue(answer({ value: null }));
  videoStore = new RecordStore<VideoJobRecord>("video");
  diagramStore = new JobStore();
  const videoRunner = new VideoRunner(videoStore, { doctor });
  await videoRunner.drain();
  const runner = { busy: 0, capStatus: () => ({ capUsd: null, exceeded: false, totalUsd: 0, jobs: 0, oldestCountedAt: null, oldestAgesOutAt: null, plannerUsd: 0, plannerTurns: 0 }) } as unknown as Runner;
  server = createApi({ store: diagramStore, runner, mirrors: new Mirrors(), video: { store: videoStore, runner: videoRunner, doctor } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
  delete process.env.STUDIO_HOME;
});

/** A POST as the web app's route handler sends one: JSON, with or without a body. */
const post = (url: string, body?: string) =>
  fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body }) });

async function videoInReview(): Promise<VideoJobRecord> {
  const response = await post("/api/jobs", JSON.stringify({ kind: "video", ...narratedBrief(), topic: "tcp-congestion-control", idempotencyKey: `k-${Math.random()}` }));
  expect(response.status).toBe(201);
  const { jobId } = (await response.json()) as { jobId: string };
  return videoStore.update(jobId, { state: "awaiting_review" });
}

const SLUG = "studio-discard-reason-fixture";

async function diagramInReview(): Promise<JobRecord> {
  const id = `job-discard-${Math.random().toString(16).slice(2)}`;
  await mkdir(path.join(home, "jobs", id), { recursive: true });
  return diagramStore.create({
    id,
    kind: "diagram",
    state: "awaiting_review",
    phase: "ready",
    brief: {
      intent: "show the projection",
      topic: "vector-and-linear-algebra-basics",
      slug: SLUG,
      title: "Dot product",
      mode: "new",
      elements: [{ label: "vector a" }],
      relations: [],
      concepts: [],
      idempotencyKey: id,
    },
    targetPath: targetPath(SLUG),
    targetSvgPath: targetSvgPath(SLUG),
    candidatePath: candidatePath(id, SLUG),
    candidateSvgPath: candidateSvgPath(id, SLUG),
    topic: "vector-and-linear-algebra-basics",
    slug: SLUG,
    attempt: 1,
    sessionId: null,
    agentSessionId: null,
    parentJobId: null,
    changes: null,
    idempotencyKey: id,
    targetHashBefore: null,
    requestedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    reviewedAt: null,
    heartbeatAt: null,
    cancelRequestedAt: null,
    exitCode: 0,
    turns: 3,
    costUsd: null,
    costSource: null,
    gate: null,
    errorKind: null,
    error: null,
    written: [],
    indexed: false,
    catalogErrors: [],
  });
}

const kinds = [
  { kind: "video", make: async () => (await videoInReview()).id, state: (id: string) => videoStore.get(id)?.state },
  { kind: "diagram", make: async () => (await diagramInReview()).id, state: (id: string) => diagramStore.get(id)?.state },
] as const;

describe.each(kinds)("discarding a $kind job", ({ make, state }) => {
  it.each([
    ["no body", undefined],
    ["an empty body", ""],
    ["{}", "{}"],
    ["empty tags and a blank note", '{"tags":[],"note":"   "}'],
  ])("with %s discards with no reason, as it always did", async (_label, body) => {
    const id = await make();
    const response = await post(`/api/jobs/${id}/discard`, body);
    expect(response.status).toBe(200);
    expect(state(id)).toBe("discarded");
    expect(catalogMock.jobDiscard).toHaveBeenCalledWith(id, undefined);
    const shown = (await (await fetch(`${base}/api/jobs/${id}`)).json()) as { review: unknown };
    expect(shown.review).toBeNull();
  });

  it("keeps the reason, hands it to the catalog's discard, and shows it on the job list and the job", async () => {
    const id = await make();
    const response = await post(`/api/jobs/${id}/discard`, JSON.stringify({ tags: ["too-slow", "voice", "too-slow"], note: "  the voice drags in scene two  " }));
    expect(response.status).toBe(200);
    expect(state(id)).toBe("discarded");
    const reason = { tags: ["too-slow", "voice"], note: "the voice drags in scene two" };
    expect(catalogMock.jobDiscard).toHaveBeenCalledWith(id, reason);
    const shown = (await (await fetch(`${base}/api/jobs/${id}`)).json()) as { review: Record<string, unknown> };
    expect(shown.review).toEqual({ verdict: "discard", ...reason, at: expect.any(String) });
    const listed = (await (await fetch(`${base}/api/jobs`)).json()) as { jobs: { jobId: string; review: unknown }[] };
    expect(listed.jobs.find((job) => job.jobId === id)?.review).toEqual(shown.review);
  });

  it.each([
    ["a tag that is not a down tag", JSON.stringify({ tags: ["clear"] }), '"clear" is not a tag'],
    ["a tag nobody defined", JSON.stringify({ tags: ["ugly"], note: "no" }), '"ugly"'],
    ["a note past the limit", JSON.stringify({ note: "x".repeat(2_001) }), "at most 2000 characters"],
    ["tags that are not a list", JSON.stringify({ tags: "too-slow" }), "Tags are a list"],
    ["a body that is not an object", "[1]", "or nothing"],
  ])("answers 400 for %s and discards nothing", async (_label, body, says) => {
    const id = await make();
    const response = await post(`/api/jobs/${id}/discard`, body);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(says);
    expect(state(id)).toBe("awaiting_review");
    expect(catalogMock.jobDiscard).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not JSON and discards nothing", async () => {
    const id = await make();
    const response = await post(`/api/jobs/${id}/discard`, "{not json");
    expect(response.status).toBe(400);
    expect(state(id)).toBe("awaiting_review");
  });
});
