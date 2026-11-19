import { describe, expect, it } from "vitest";

import {
  checkJobReview,
  checkJobRun,
  cleanRating,
  isStudioRelativePath,
  JOB_RUN_LIMITS,
  type JobRun,
  RATING_LIMITS,
  RATING_PROMPT_PREFERENCE_PREFIX,
  RATING_TAG_LABELS,
  RATING_TAGS_DOWN,
  RATING_TAGS_UP,
  ratingPromptKey,
  ratingTagsFor,
} from "./shared";

/**
 * The eval records' vocabulary: a learner's rating of an asset, and the
 * runner's and a person's records on a job. Pure, so the page that sends a
 * rating and the writer that stores it refuse the same input.
 */

describe("rating tags", () => {
  it("labels every tag, in sentence case, and no tag is in both lists", () => {
    const all = [...RATING_TAGS_DOWN, ...RATING_TAGS_UP];
    expect(Object.keys(RATING_TAG_LABELS).sort()).toEqual([...all].sort());
    expect(new Set(all).size).toBe(all.length);
    for (const label of Object.values(RATING_TAG_LABELS)) {
      expect(label[0]).toBe(label[0]?.toUpperCase());
      expect(label.slice(1)).toBe(label.slice(1).toLowerCase());
    }
  });

  it("gives each value its own list", () => {
    expect(ratingTagsFor(-1)).toBe(RATING_TAGS_DOWN);
    expect(ratingTagsFor(1)).toBe(RATING_TAGS_UP);
    expect(ratingTagsFor(0)).toEqual([]);
  });
});

describe("cleanRating", () => {
  it("cleans a thumbs down: tags once each in the order given, the note trimmed", () => {
    expect(cleanRating({ value: -1, tags: ["too-slow", "voice", "too-slow"], note: "  the narration drags \n" })).toEqual({
      ok: true,
      rating: { value: -1, tags: ["too-slow", "voice"], note: "the narration drags" },
    });
  });

  it("takes a thumbs up with no tags and no note, and a blank note as none", () => {
    expect(cleanRating({ value: 1 })).toEqual({ ok: true, rating: { value: 1, tags: [], note: null } });
    expect(cleanRating({ value: 1, tags: ["clear"], note: "   " })).toEqual({
      ok: true,
      rating: { value: 1, tags: ["clear"], note: null },
    });
  });

  it("takes 0 as a cleared rating, which carries no tags", () => {
    expect(cleanRating({ value: 0 })).toEqual({ ok: true, rating: { value: 0, tags: [], note: null } });
    const refused = cleanRating({ value: 0, tags: ["clear"] });
    expect(refused).toEqual({ ok: false, reason: expect.stringContaining("carries no tags") });
  });

  it("refuses a tag from the other value's list, or from no list", () => {
    expect(cleanRating({ value: 1, tags: ["too-slow"] })).toEqual({ ok: false, reason: expect.stringContaining("clear") });
    expect(cleanRating({ value: -1, tags: ["clear"] })).toEqual({ ok: false, reason: expect.stringContaining("same-look") });
    expect(cleanRating({ value: -1, tags: ["boring"] }).ok).toBe(false);
    expect(cleanRating({ value: -1, tags: "too-slow" }).ok).toBe(false);
    expect(cleanRating({ value: -1, tags: [3] }).ok).toBe(false);
  });

  it("refuses a value that is not -1, 0 or 1", () => {
    for (const value of [2, -2, 0.5, "1", null, undefined, true]) {
      expect(cleanRating({ value }).ok, JSON.stringify(value)).toBe(false);
    }
  });

  it("refuses a note past the limit rather than cutting it, and one that is not text", () => {
    expect(cleanRating({ value: -1, note: "x".repeat(RATING_LIMITS.maxNoteChars) }).ok).toBe(true);
    expect(cleanRating({ value: -1, note: "x".repeat(RATING_LIMITS.maxNoteChars + 1) })).toEqual({
      ok: false,
      reason: expect.stringContaining(`${RATING_LIMITS.maxNoteChars}`),
    });
    expect(cleanRating({ value: -1, note: 12 }).ok).toBe(false);
  });

  it("holds every down tag at once inside the limit", () => {
    expect(RATING_TAGS_DOWN.length).toBeLessThanOrEqual(RATING_LIMITS.maxTags);
    expect(cleanRating({ value: -1, tags: [...RATING_TAGS_DOWN] }).ok).toBe(true);
  });
});

describe("the rating prompt preference", () => {
  it("keys one row per asset, the way favorite: and playback: do", () => {
    expect(RATING_PROMPT_PREFERENCE_PREFIX).toBe("ratingPrompt:");
    expect(ratingPromptKey("manimkc:out/a/b.mp4")).toBe("ratingPrompt:manimkc:out/a/b.mp4");
  });
});

/** A run record with every field, which each case below changes one field of. */
function run(overrides: Partial<Record<keyof JobRun, unknown>> = {}): Record<string, unknown> {
  return {
    harness: { name: "claude", version: "2.1.319" },
    model: { passed: "sonnet", resolved: "claude-sonnet-5-5" },
    effort: "high",
    manualHash: "abc123",
    auth: "login",
    attempts: [
      {
        n: 1,
        startedAt: "2026-11-20T10:00:00.000Z",
        endedAt: "2026-11-20T10:04:00.000Z",
        turns: 12,
        costUsd: 0.42,
        gate: { ok: false, steps: [{ name: "lint", ok: false }], findings: 2, warnings: 1 },
      },
      { n: 2, startedAt: null, endedAt: null, turns: null, costUsd: null, gate: null },
    ],
    calls: { "canvas run": 4, "canvas inspect": 2 },
    renderSeconds: 31.5,
    transcriptPath: "jobs/job-1/transcript.ndjson",
    ...overrides,
  };
}

describe("checkJobRun", () => {
  it("takes a whole record and gives back the checked fields", () => {
    const input = run();
    const checked = checkJobRun(input);
    expect(checked).toEqual({ ok: true, run: run() });
    // Rebuilt from the checked fields, never the caller's own object.
    if (checked.ok) expect(checked.run).not.toBe(input);
  });

  it("takes null wherever the shape allows it", () => {
    const sparse = run({
      harness: { name: "claude", version: null },
      model: { passed: null, resolved: null },
      effort: null,
      manualHash: null,
      auth: null,
      attempts: [],
      calls: {},
      renderSeconds: null,
      transcriptPath: null,
    });
    expect(checkJobRun(sparse).ok).toBe(true);
  });

  it("refuses an absolute or escaping transcript path, as candidate_path does", () => {
    for (const transcriptPath of ["/Users/me/.hermes/studio/jobs/x.ndjson", "C:/studio/x", "../x", "jobs/../../x", "jobs\\x", "jobs//x", ""]) {
      const checked = checkJobRun(run({ transcriptPath }));
      expect(checked.ok, transcriptPath).toBe(false);
      if (!checked.ok) expect(checked.reason).toContain("STUDIO_HOME");
    }
    expect(isStudioRelativePath("jobs/a/transcript.ndjson")).toBe(true);
  });

  it("refuses a missing field, an unknown one, and one of the wrong kind", () => {
    const missing = run();
    delete missing["calls"];
    expect(checkJobRun(missing)).toEqual({ ok: false, reason: expect.stringContaining("missing: calls") });
    expect(checkJobRun({ ...run(), extra: 1 })).toEqual({ ok: false, reason: expect.stringContaining("unknown fields: extra") });
    expect(checkJobRun(run({ harness: { name: "" , version: null } })).ok).toBe(false);
    expect(checkJobRun(run({ harness: { name: "claude" } })).ok).toBe(false);
    expect(checkJobRun(run({ model: "sonnet" })).ok).toBe(false);
    expect(checkJobRun(run({ effort: 3 })).ok).toBe(false);
    expect(checkJobRun(run({ calls: { run: -1 } })).ok).toBe(false);
    expect(checkJobRun(run({ calls: { run: 1.5 } })).ok).toBe(false);
    expect(checkJobRun(run({ calls: [] })).ok).toBe(false);
    expect(checkJobRun(run({ renderSeconds: -1 })).ok).toBe(false);
    expect(checkJobRun(run({ renderSeconds: Number.NaN })).ok).toBe(false);
    expect(checkJobRun([]).ok).toBe(false);
    expect(checkJobRun(null).ok).toBe(false);
  });

  it("checks each attempt and its gate", () => {
    const attempt = { n: 1, startedAt: null, endedAt: null, turns: null, costUsd: null, gate: null };
    expect(checkJobRun(run({ attempts: [{ ...attempt, n: 0 }] })).ok).toBe(false);
    expect(checkJobRun(run({ attempts: [{ ...attempt, startedAt: "yesterday-ish" }] })).ok).toBe(false);
    expect(checkJobRun(run({ attempts: [{ ...attempt, turns: -1 }] })).ok).toBe(false);
    expect(checkJobRun(run({ attempts: [{ ...attempt, costUsd: "0.1" }] })).ok).toBe(false);
    const { gate: _gate, ...withoutGate } = attempt;
    expect(checkJobRun(run({ attempts: [withoutGate] })).ok).toBe(false);
    expect(checkJobRun(run({ attempts: [{ ...attempt, colour: "red" }] })).ok).toBe(false);
    const gate = { ok: true, steps: [], findings: 0, warnings: 0 };
    expect(checkJobRun(run({ attempts: [{ ...attempt, gate }] })).ok).toBe(true);
    expect(checkJobRun(run({ attempts: [{ ...attempt, gate: { ...gate, ok: "yes" } }] })).ok).toBe(false);
    expect(checkJobRun(run({ attempts: [{ ...attempt, gate: { ...gate, steps: [{ name: "lint" }] } }] })).ok).toBe(false);
    expect(checkJobRun(run({ attempts: [{ ...attempt, gate: { ...gate, findings: -1 } }] })).ok).toBe(false);
    expect(checkJobRun(run({ attempts: [{ ...attempt, gate: { ...gate, more: 1 } }] })).ok).toBe(false);
  });

  it("bounds the lists, so one record cannot grow without limit", () => {
    const attempt = { n: 1, startedAt: null, endedAt: null, turns: null, costUsd: null, gate: null };
    expect(checkJobRun(run({ attempts: Array.from({ length: JOB_RUN_LIMITS.maxAttempts + 1 }, () => attempt) })).ok).toBe(false);
    const calls = Object.fromEntries(Array.from({ length: JOB_RUN_LIMITS.maxCalls + 1 }, (_, i) => [`tool-${i}`, 1]));
    expect(checkJobRun(run({ calls })).ok).toBe(false);
    expect(checkJobRun(run({ effort: "x".repeat(JOB_RUN_LIMITS.maxChars + 1) })).ok).toBe(false);
  });
});

describe("checkJobReview", () => {
  const at = "2026-11-20T10:00:00.000Z";

  it("takes a verdict with down tags and a note", () => {
    expect(checkJobReview({ verdict: "discard", tags: ["wrong", "wrong", "voice"], note: " off topic ", at })).toEqual({
      ok: true,
      review: { verdict: "discard", tags: ["wrong", "voice"], note: "off topic", at },
    });
    expect(checkJobReview({ verdict: "accept", tags: [], note: null, at }).ok).toBe(true);
  });

  it("refuses an unknown verdict, an up tag, a long note, a bad instant and a stray field", () => {
    expect(checkJobReview({ verdict: "maybe", tags: [], note: null, at }).ok).toBe(false);
    expect(checkJobReview({ verdict: "accept", tags: ["clear"], note: null, at }).ok).toBe(false);
    expect(checkJobReview({ verdict: "revise", tags: [], note: "x".repeat(RATING_LIMITS.maxNoteChars + 1), at }).ok).toBe(false);
    expect(checkJobReview({ verdict: "revise", tags: [], note: null, at: "soon" }).ok).toBe(false);
    expect(checkJobReview({ verdict: "revise", tags: [], note: null, at, by: "me" }).ok).toBe(false);
    expect(checkJobReview("discard").ok).toBe(false);
  });
});
