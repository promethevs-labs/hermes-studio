import { checkJobRun, type JobRun } from "@hermes/schema/shared";
import { describe, expect, it } from "vitest";

import { evalReport, formatEvalReport, type ReportJob, type ReportVideo } from "../src/ingredients/report";

/**
 * The report's "by prompt version" groups, keyed on the manual's version when
 * a job has one and on its hash when it does not. A video job's `manualHash`
 * names a file whose text holds the job's own paths, so it differs for every
 * job; `manualVersion` is the hash with those paths set aside. Plain objects,
 * no database.
 */

const V1 = "1111111111111111aaaa";
const V2 = "2222222222222222bbbb";

function video(assetId: string, over: Partial<NonNullable<ReportVideo["job"]>>, rating: ReportVideo["rating"] = null): ReportVideo {
  return {
    assetId,
    tool: "manimkc",
    title: assetId,
    durationSeconds: 60,
    ingredients: null,
    rating,
    job: {
      model: "opus",
      effort: "high",
      manualHash: "abcdef0123456789",
      costUsd: 1,
      turns: 10,
      wallSeconds: 600,
      attempts: 1,
      state: "accepted",
      ...over,
    },
  };
}

function extra(over: Partial<ReportJob> = {}): ReportJob {
  return {
    kind: "video",
    tool: "manimkc",
    state: "discarded",
    model: "opus",
    manualHash: "abcdef0123456789",
    costUsd: 2,
    turns: 5,
    wallSeconds: 300,
    reviewTags: [],
    ...over,
  };
}

// Two video jobs made under one manual: each job's own hash, one version.
const sameManual = [
  video("a", { manualHash: "hash-of-job-a-0000", manualVersion: V1 }),
  video("b", { manualHash: "hash-of-job-b-0000", manualVersion: V1 }),
];

describe("by prompt version: grouping on the manual's version", () => {
  it("puts jobs with different hashes and one version in one group", () => {
    const r = evalReport(sameManual);
    expect(r.byManual.map((g) => [g.key, g.videos, g.keyedOn])).toEqual([[V1, 2, "version"]]);
  });

  it("splits groups by the manual's version, not the hash", () => {
    const r = evalReport([...sameManual, video("c", { manualHash: "hash-of-job-c-0000", manualVersion: V2 })]);
    expect(r.byManual.map((g) => [g.key, g.videos])).toEqual([
      [V1, 2],
      [V2, 1],
    ]);
  });

  it("keeps an old record, with a hash and no version, in its own group keyed on the hash", () => {
    const r = evalReport(
      [...sameManual, video("old", { manualHash: "oldoldoldold0000" })],
      [extra({ manualHash: "oldoldoldold0000" }), extra({ manualHash: null, manualVersion: null })],
    );
    expect(r.byManual.map((g) => [g.key, g.videos, g.keyedOn])).toEqual([
      ["(none)", 0, null],
      [V1, 2, "version"],
      ["oldoldoldold0000", 1, "hash"],
    ]);
    const old = r.byManual.find((g) => g.key === "oldoldoldold0000")!;
    expect(old.accepted).toBe(1);
    expect(old.discarded).toBe(1);
  });

  it("counts a rating under the version of the job it judged", () => {
    const rating = (hash: string): ReportVideo["rating"] => ({
      value: 1,
      tags: [],
      job: { model: "opus", manualHash: hash, manualVersion: V1 },
    });
    const r = evalReport([
      video("a", { manualHash: "hash-of-job-a-0000", manualVersion: V1 }, rating("hash-of-job-a-0000")),
      video("b", { manualHash: "hash-of-job-b-0000", manualVersion: V1 }, rating("hash-of-job-b-0000")),
    ]);
    expect(r.byManual.map((g) => [g.key, g.rated])).toEqual([[V1, 2]]);
  });

  it("keeps every existing --json field of a group and adds keyedOn only to this grouping", () => {
    const r = evalReport(sameManual);
    const { keyedOn, ...rest } = r.byManual[0]!;
    expect(keyedOn).toBe("version");
    expect(Object.keys(rest).sort()).toEqual(Object.keys(r.byModel[0]!).sort());
    expect(Object.hasOwn(r.byTool[0]!, "keyedOn")).toBe(false);
  });

  it("says in the text which groups are keyed on a hash, only when both kinds are there, within 100 columns", () => {
    const mixed = formatEvalReport(evalReport([...sameManual, video("old", { manualHash: "oldoldoldold0000" })]));
    expect(mixed).toContain("11111111  ");
    expect(mixed).toContain("oldoldol*");
    expect(mixed).toContain("*: an older job with no manual version, grouped by its manual's hash.");
    expect(mixed.split("\n").every((line) => line.length <= 100)).toBe(true);
    // A report of one kind adds nothing.
    expect(formatEvalReport(evalReport(sameManual))).not.toContain("*:");
    expect(formatEvalReport(evalReport([video("old", { manualHash: "oldoldoldold0000" })]))).not.toContain("*:");
  });
});

describe("checkJobRun and manualVersion", () => {
  const run: JobRun = {
    harness: { name: "claude-code", version: "2.1.319" },
    model: { passed: "opus", resolved: "claude-opus-5" },
    effort: "high",
    manualHash: "0123456789abcdef",
    auth: "login",
    attempts: [],
    calls: {},
    renderSeconds: null,
    transcriptPath: null,
  };

  it("accepts a record without the field, and returns it without one", () => {
    const checked = checkJobRun(run);
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(Object.hasOwn(checked.run, "manualVersion")).toBe(false);
  });

  it("accepts a record with it, as text or null", () => {
    const withVersion = checkJobRun({ ...run, manualVersion: V1 });
    expect(withVersion.ok && withVersion.run.manualVersion).toBe(V1);
    const withNull = checkJobRun({ ...run, manualVersion: null });
    expect(withNull.ok && withNull.run.manualVersion).toBeNull();
  });

  it("refuses a version that is not text of a sensible length", () => {
    expect(checkJobRun({ ...run, manualVersion: "" }).ok).toBe(false);
    expect(checkJobRun({ ...run, manualVersion: 7 }).ok).toBe(false);
    expect(checkJobRun({ ...run, manualVersion: "x".repeat(600) }).ok).toBe(false);
  });

  it("still refuses a record missing a required field, and an unknown one", () => {
    const { auth: _auth, ...withoutAuth } = run;
    expect(checkJobRun(withoutAuth).ok).toBe(false);
    expect(checkJobRun({ ...run, manualVersions: V1 }).ok).toBe(false);
  });
});
