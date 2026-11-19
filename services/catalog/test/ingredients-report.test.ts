import { describe, expect, it } from "vitest";

import {
  evalReport,
  formatEvalReport,
  type ReportJob,
  type ReportVideo,
} from "../src/ingredients/report";
import type { IngredientMetrics } from "../src/ingredients/scan";

/** Plain objects in the shapes the report takes; no database involved. */

function metrics(over: Partial<IngredientMetrics> = {}): IngredientMetrics {
  return {
    files: 1,
    lines: 100,
    plays: 0,
    voiceovers: 0,
    rateFuncs: 0,
    helperCalls: 10,
    distinctHelpers: 3,
    helperTop5Share: 0.8,
    animationCalls: 10,
    distinctAnimations: 2,
    fadeShare: 0.5,
    engineCalls: 5,
    distinctEngine: 2,
    uses3d: false,
    variety: 0.6,
    ...over,
  };
}

function video(over: Partial<ReportVideo> & { assetId: string }): ReportVideo {
  return {
    tool: "manimkc",
    title: over.assetId,
    durationSeconds: 60,
    ingredients: null,
    rating: null,
    job: null,
    ...over,
  };
}

function job(over: Partial<NonNullable<ReportVideo["job"]>> = {}) {
  return {
    model: "opus",
    effort: "high",
    manualHash: "abcdef0123456789",
    costUsd: 1,
    turns: 10,
    wallSeconds: 600,
    attempts: 1,
    state: "accepted",
    ...over,
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

const sample: ReportVideo[] = [
  video({
    assetId: "a",
    rating: { value: 1, tags: ["clear", "pacing"] },
    job: job({ costUsd: 1, turns: 10, wallSeconds: 600 }),
    ingredients: {
      calls: { body: 6, caption: 2, FadeIn: 5, FadeOut: 5 },
      metrics: metrics({ variety: 0.5, uses3d: true }),
      sceneCount: 4,
    },
  }),
  video({
    assetId: "b",
    rating: { value: -1, tags: ["pacing"] },
    job: job({ costUsd: 3, turns: 20, wallSeconds: 1200 }),
    ingredients: {
      calls: { body: 4, mono: 1, FadeIn: 5 },
      metrics: metrics({ variety: 0.7, fadeShare: 1, animationCalls: 5 }),
      sceneCount: 2,
    },
  }),
  video({
    assetId: "c",
    tool: "remotionkc",
    rating: { value: 0, tags: [] },
    job: job({ model: "sonnet", manualHash: null, costUsd: null, turns: null, wallSeconds: null }),
  }),
  video({ assetId: "d", tool: "remotionkc" }),
];

describe("evalReport", () => {
  const r = evalReport(sample, [
    extra({ state: "discarded", reviewTags: ["too busy", "pacing"], costUsd: 2 }),
    extra({ state: "failed", costUsd: 1 }),
    extra({ state: "cancelled", costUsd: 4 }),
    extra({ tool: "remotionkc", model: "sonnet", manualHash: null, state: "discarded", reviewTags: ["too busy"] }),
  ]);

  it("totals videos, ratings and tags", () => {
    expect(r.totals.videos).toBe(4);
    // A rating of 0 is not a rating.
    expect(r.totals.rated).toBe(2);
    expect(r.totals.up).toBe(1);
    expect(r.totals.down).toBe(1);
    expect(r.totals.upShare).toBe(0.5);
    expect(r.totals.tagCounts).toEqual([
      { tag: "pacing", count: 2 },
      { tag: "clear", count: 1 },
    ]);
  });

  it("takes mean and median over the rows that have the number", () => {
    expect(r.totals.costUsd).toEqual({ n: 2, mean: 2, median: 2 });
    expect(r.totals.turns).toEqual({ n: 2, mean: 15, median: 15 });
    expect(r.totals.wallSeconds).toEqual({ n: 2, mean: 900, median: 900 });
    const three = evalReport([
      video({ assetId: "x", job: job({ costUsd: 1 }) }),
      video({ assetId: "y", job: job({ costUsd: 2 }) }),
      video({ assetId: "z", job: job({ costUsd: 10 }) }),
    ]);
    expect(three.totals.costUsd.median).toBe(2);
    expect(three.totals.costUsd.mean).toBe(4.3333);
  });

  it("averages the look over videos that have ingredients", () => {
    expect(r.totals.meanVariety).toBe(0.6);
    expect(r.totals.meanFadeShare).toBe(0.75);
    expect(r.totals.meanHelperTop5Share).toBe(0.8);
    expect(r.totals.uses3dShare).toBe(0.5);
  });

  it("figures accept rate over accepted, discarded and failed jobs", () => {
    // Four jobs on videos, all accepted, plus one discarded and one failed
    // here, and the cancelled job is left out of the figure.
    expect(r.totals.accepted).toBe(3);
    expect(r.totals.discarded).toBe(2);
    expect(r.totals.failed).toBe(1);
    expect(r.totals.acceptRate).toBe(0.5);
    expect(r.totals.discardTags).toEqual([
      { tag: "too busy", count: 2 },
      { tag: "pacing", count: 1 },
    ]);
    expect(r.totals.wastedUsd).toBe(9);
  });

  it("groups by tool, model and prompt version", () => {
    expect(r.byTool.map((g) => [g.key, g.videos])).toEqual([
      ["manimkc", 2],
      ["remotionkc", 2],
    ]);
    expect(r.byTool[0]!.acceptRate).toBe(0.5);
    expect(r.byModel.map((g) => g.key)).toEqual(["(no job)", "opus", "sonnet"]);
    const opus = r.byModel.find((g) => g.key === "opus")!;
    expect(opus.videos).toBe(2);
    expect(opus.accepted).toBe(2);
    expect(opus.discarded).toBe(1);
    expect(opus.acceptRate).toBe(0.5);
    expect(r.byManual.map((g) => g.key)).toEqual([
      "(no job)",
      "(none)",
      "abcdef0123456789",
    ]);
  });

  it("uses null for a group with nothing to average", () => {
    const g = r.byModel.find((x) => x.key === "(no job)")!;
    expect(g.videos).toBe(1);
    expect(g.upShare).toBeNull();
    expect(g.costUsd).toEqual({ n: 0, mean: null, median: null });
    expect(g.meanVariety).toBeNull();
    expect(g.uses3dShare).toBeNull();
    expect(g.acceptRate).toBeNull();
    const empty = evalReport([]);
    expect(empty.totals.videos).toBe(0);
    expect(empty.totals.upShare).toBeNull();
    expect(empty.byTool).toEqual([]);
    expect(empty.corpus.topCalls).toEqual([]);
    expect(empty.corpus.helperTop5Share).toBeNull();
    expect(empty.corpus.fadeShare).toBeNull();
  });

  it("builds the corpus call table", () => {
    expect(r.corpus.videosWithIngredients).toBe(2);
    expect(r.corpus.totalCalls).toBe(28);
    expect(r.corpus.topCalls.slice(0, 3)).toEqual([
      { name: "FadeIn", calls: 10, share: 0.3571 },
      { name: "body", calls: 10, share: 0.3571 },
      { name: "FadeOut", calls: 5, share: 0.1786 },
    ]);
    expect(r.corpus.fadeShare).toBe(0.6667);
    expect(r.corpus.helperTop5Share).toBe(0.8);
    expect(r.corpus.underusedHelpers).toEqual([]);
  });

  it("computes the helper share and unused helpers from the library names", () => {
    const withLib = evalReport(sample, [], [
      "body",
      "caption",
      "mono",
      "heading",
      "stack",
      "card",
    ]);
    expect(withLib.corpus.helperTop5Share).toBe(1);
    expect(withLib.corpus.underusedHelpers).toEqual(["card", "heading", "mono", "stack"]);
  });

  it("caps the call table at 20 names", () => {
    const calls: Record<string, number> = {};
    for (let i = 0; i < 30; i++) calls[`n${String(i).padStart(2, "0")}`] = 1;
    const big = evalReport([
      video({ assetId: "q", ingredients: { calls, metrics: metrics(), sceneCount: null } }),
    ]);
    expect(big.corpus.topCalls).toHaveLength(20);
    expect(big.corpus.topCalls[0]!.name).toBe("n00");
  });
});

describe("formatEvalReport", () => {
  const report = evalReport(sample, [
    extra({ reviewTags: ["too busy"] }),
    extra({ state: "failed" }),
  ]);
  const text = formatEvalReport(report);

  it("puts the sections in order with sentence-case headings", () => {
    const heads = ["Totals", "By tool", "By model", "By prompt version", "Corpus calls"];
    const at = heads.map((h) => text.indexOf(`\n${h}\n`) + 1 || text.indexOf(`${h}\n`));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("has no em dash, no all-caps words and fits 100 columns", () => {
    expect(text).not.toContain("—");
    expect(text).not.toMatch(/\b[A-Z]{4,}\b/);
    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
  });

  it("shows the prompt version as its first 8 characters", () => {
    expect(text).toContain("abcdef01");
    expect(text).not.toContain("abcdef0123");
  });

  it("renders null as a dash and handles an empty report", () => {
    expect(text).toContain("-");
    const empty = formatEvalReport(evalReport([]));
    expect(empty).toContain("No videos.");
    expect(empty).toContain("No video has recorded ingredients yet.");
  });

  it("matches the layout", () => {
    expect(text).toMatchInlineSnapshot(`
      "Totals

        Videos                      4
        Rated                       2 (up 1, down 1, up share 50%)
        Jobs                        accepted 3, discarded 1, failed 1, accept rate 60%
        Cost per video              mean $2.00, median $2.00
        Wall time                   median 15.0m
        Spent on jobs with no video $4.00
        Look                        variety 0.60, top 5 helpers 80%, fade 75%, 3D 50%

        Rating tags: pacing 2, clear 1
        Discard tags: too busy 1

      By tool

      Tool        videos  rated  up  down  up share  accepted  discarded  failed  accept rate
      ----------  ------  -----  --  ----  --------  --------  ---------  ------  -----------
      manimkc          2      2   1     1       50%         2          1       1          50%
      remotionkc       2      0   0     0         -         1          0       0         100%

      Tool        cost mean  cost median  turns  wall median  variety  top 5  fade   3D
      ----------  ---------  -----------  -----  -----------  -------  -----  ----  ---
      manimkc         $2.00        $2.00   15.0        15.0m     0.60    80%   75%  50%
      remotionkc          -            -      -            -        -      -     -    -

        manimkc rating tags: pacing 2, clear 1
        manimkc discard tags: too busy 1

      By model

      Model     videos  rated  up  down  up share  accepted  discarded  failed  accept rate
      --------  ------  -----  --  ----  --------  --------  ---------  ------  -----------
      (no job)       1      0   0     0         -         0          0       0            -
      opus           2      2   1     1       50%         2          1       1          50%
      sonnet         1      0   0     0         -         1          0       0         100%

      Model     cost mean  cost median  turns  wall median  variety  top 5  fade   3D
      --------  ---------  -----------  -----  -----------  -------  -----  ----  ---
      (no job)          -            -      -            -        -      -     -    -
      opus          $2.00        $2.00   15.0        15.0m     0.60    80%   75%  50%
      sonnet            -            -      -            -        -      -     -    -

        opus rating tags: pacing 2, clear 1
        opus discard tags: too busy 1

      By prompt version

      Manual    videos  rated  up  down  up share  accepted  discarded  failed  accept rate
      --------  ------  -----  --  ----  --------  --------  ---------  ------  -----------
      (no job)       1      0   0     0         -         0          0       0            -
      (none)         1      0   0     0         -         1          0       0         100%
      abcdef01       2      2   1     1       50%         2          1       1          50%

      Manual    cost mean  cost median  turns  wall median  variety  top 5  fade   3D
      --------  ---------  -----------  -----  -----------  -------  -----  ----  ---
      (no job)          -            -      -            -        -      -     -    -
      (none)            -            -      -            -        -      -     -    -
      abcdef01      $2.00        $2.00   15.0        15.0m     0.60    80%   75%  50%

        abcdef01 rating tags: pacing 2, clear 1
        abcdef01 discard tags: too busy 1

      Corpus calls

        2 videos, 28 calls. Top 5 helpers 80% of helper calls, fade 67% of animation calls.

      Name     calls  share
      -------  -----  -----
      FadeIn      10    36%
      body        10    36%
      FadeOut      5    18%
      caption      2     7%
      mono         1     4%
      "
    `);
  });
});
