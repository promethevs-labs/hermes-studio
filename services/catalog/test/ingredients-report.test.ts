import { describe, expect, it } from "vitest";

import {
  evalReport,
  formatEvalReport,
  reportCritic,
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
    extra({ state: "failed", costUsd: 1, errorKind: "gate" }),
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

  it("lists unused helpers from the library names and leaves the share alone", () => {
    const withLib = evalReport(sample, [], [
      "body",
      "caption",
      "mono",
      "heading",
      "stack",
      "card",
    ]);
    expect(withLib.corpus.helperTop5Share).toBe(0.8);
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

describe("evalReport: where a rating is counted", () => {
  const rated = (assetId: string, rating: NonNullable<ReportVideo["rating"]>, model: string) =>
    video({ assetId, rating, job: job({ model, manualHash: `${model}-manual` }) });

  it("counts a rating that names its job under that job's model and prompt version, and a rating with none under the video's", () => {
    const r = evalReport([
      // Judged model-a's cut; model-b has since replaced it.
      rated("a", { value: -1, tags: ["same-look"], job: { model: "model-a", manualHash: "model-a-manual" }, stale: true }, "model-b"),
      // No job named: it goes with the video's own row.
      rated("b", { value: 1, tags: [] }, "model-b"),
      // Names a job that left no record of its model.
      rated("c", { value: 1, tags: [], job: { model: null, manualHash: null } }, "model-b"),
    ]);
    const model = (key: string) => r.byModel.find((g) => g.key === key)!;
    expect([model("model-a").rated, model("model-a").down]).toEqual([1, 1]);
    expect([model("model-b").rated, model("model-b").up]).toEqual([1, 1]);
    expect(model("unknown").rated).toBe(1);
    expect(model("model-a").videos).toBe(0);
    expect(r.byManual.find((g) => g.key === "model-a-manual")!.rated).toBe(1);
    expect(r.byManual.find((g) => g.key === "(none)")!.rated).toBe(1);
    // By tool, and in total, every rating counts under the video.
    expect(r.byTool).toHaveLength(1);
    expect(r.byTool[0]!.rated).toBe(3);
    expect(r.totals.rated).toBe(3);
  });

  it("counts a rating that is not of the video as it is now", () => {
    const r = evalReport([
      rated("a", { value: 1, tags: [], stale: true }, "m"),
      rated("b", { value: 1, tags: [], stale: false }, "m"),
      rated("c", { value: 1, tags: [] }, "m"),
      // A cleared rating is not a rating, stale or not.
      rated("d", { value: 0, tags: [], stale: true }, "m"),
    ]);
    expect(r.totals.staleRatings).toBe(1);
    expect(r.byTool[0]!.staleRatings).toBe(1);
  });

  it("counts every finished job once, whether or not a video still stands on it", () => {
    const r = evalReport(
      [video({ assetId: "a", job: job({ state: "accepted" }) })],
      [extra({ state: "accepted" }), extra({ state: "accepted" }), extra({ state: "discarded" }), extra({ state: "cancelled" })],
    );
    expect([r.totals.accepted, r.totals.discarded, r.totals.failed, r.totals.acceptRate]).toEqual([3, 1, 0, 0.75]);
  });
});

describe("failure causes in the accept rate", () => {
  /** A failed job that never ran: the shape of an expired login. */
  const expiredLogin = () => extra({ state: "failed", errorKind: "agent", turns: null, costUsd: null });
  const gateFailure = () => extra({ state: "failed", errorKind: "gate", turns: 12, costUsd: 3 });

  it("leaves infrastructure failures out of the rate and keeps the total", () => {
    const r = evalReport(
      [],
      [
        extra({ state: "accepted" }),
        extra({ state: "discarded" }),
        ...Array.from({ length: 5 }, expiredLogin),
        extra({ state: "failed", errorKind: "timeout" }),
        gateFailure(),
      ],
    );
    const t = r.totals;
    expect([t.accepted, t.discarded, t.failed, t.failedQuality, t.failedInfra]).toEqual([1, 1, 7, 1, 6]);
    expect(t.acceptRate).toBeCloseTo(1 / 3, 3);
    expect(t.failuresByKind).toEqual([
      { kind: "agent", cause: "infrastructure", count: 5, classified: true },
      { kind: "gate", cause: "quality", count: 1, classified: true },
      { kind: "timeout", cause: "infrastructure", count: 1, classified: true },
    ]);
  });

  it("figures a group with only infrastructure failures from its accepted and discarded jobs", () => {
    const r = evalReport(
      [],
      [
        extra({ tool: "tldrawkc", state: "accepted" }),
        extra({ tool: "tldrawkc", state: "discarded" }),
        extra({ tool: "tldrawkc", state: "failed", errorKind: "internal" }),
        extra({ tool: "remotionkc", state: "failed", errorKind: "toolchain" }),
      ],
    );
    expect(r.byTool.find((g) => g.key === "tldrawkc")!.acceptRate).toBe(0.5);
    const only = r.byTool.find((g) => g.key === "remotionkc")!;
    expect([only.failed, only.failedQuality, only.failedInfra]).toEqual([1, 0, 1]);
    // Nothing accepted, discarded or failed on quality: no rate, not 0%.
    expect(only.acceptRate).toBeNull();
  });

  it("gives 75% for the owner's real shape: 3 accepted, 1 gate failure, 32 agent failures with no turns", () => {
    const r = evalReport(
      [],
      [
        ...Array.from({ length: 3 }, () => extra({ tool: "tldrawkc", state: "accepted" })),
        extra({ tool: "tldrawkc", state: "failed", errorKind: "gate", turns: 14, costUsd: 2.1 }),
        ...Array.from({ length: 19 }, () => extra({ tool: "tldrawkc", state: "failed", errorKind: "agent", turns: null, costUsd: null })),
        ...Array.from({ length: 13 }, () => extra({ tool: "tldrawkc", state: "failed", errorKind: "agent", turns: 0, costUsd: 0 })),
      ],
    );
    const t = r.totals;
    expect([t.accepted, t.failed, t.failedQuality, t.failedInfra]).toEqual([3, 33, 1, 32]);
    expect(t.acceptRate).toBe(0.75);
    expect(r.byTool[0]!.acceptRate).toBe(0.75);
    expect(r.byModel[0]!.acceptRate).toBe(0.75);
    expect(r.byManual[0]!.acceptRate).toBe(0.75);
  });

  it("counts a failed job behind a video the same way", () => {
    const r = evalReport([
      video({ assetId: "a", job: job({ state: "failed", errorKind: "internal", turns: null, costUsd: null }) }),
      video({ assetId: "b", job: job({ state: "failed", errorKind: "gate" }) }),
    ]);
    expect([r.totals.failedQuality, r.totals.failedInfra, r.totals.acceptRate]).toEqual([1, 1, 0]);
  });

  it("still spends on every job: the other-jobs figure counts infrastructure failures", () => {
    const r = evalReport([], [expiredLogin(), extra({ state: "failed", errorKind: "toolchain", costUsd: 0.5 })]);
    expect(r.totals.wastedUsd).toBe(0.5);
    const paid = evalReport([], [extra({ state: "failed", errorKind: "agent", turns: null, costUsd: 0.25 })]);
    // It cost money, so it did work: quality, and it counts in the rate.
    expect([paid.totals.failedQuality, paid.totals.wastedUsd]).toEqual([1, 0.25]);
  });

  it("lists an unknown kind by name in the report, and counts it as infrastructure", () => {
    const r = evalReport([], [extra({ state: "accepted" }), extra({ state: "failed", errorKind: "meteor" }), extra({ state: "failed", errorKind: null })]);
    expect(r.totals.failedInfra).toBe(2);
    expect(r.totals.acceptRate).toBe(1);
    expect(r.totals.failuresByKind.map((f) => [f.kind, f.classified])).toEqual([
      ["(none)", false],
      ["meteor", false],
    ]);
    const text = formatEvalReport(r);
    expect(text).toContain("meteor 1 (not classified yet)");
    expect(text).toContain("(none) 1 (not classified yet)");
  });

  it("keeps the old JSON keys and adds the new ones", () => {
    const g = JSON.parse(JSON.stringify(evalReport([], [extra({ state: "failed", errorKind: "gate" })]))).totals;
    for (const key of ["accepted", "discarded", "failed", "acceptRate", "wastedUsd", "staleRatings", "discardTags"]) {
      expect(g).toHaveProperty(key);
    }
    expect(g.failed).toBe(1);
    expect(g.failedQuality).toBe(1);
    expect(g.failedInfra).toBe(0);
    expect(g.failuresByKind).toEqual([{ kind: "gate", cause: "quality", count: 1, classified: true }]);
  });

  it("shows the causes in the text, with the infrastructure line only when there is one", () => {
    const without = formatEvalReport(evalReport([], [gateFailure()]));
    expect(without).not.toContain("Infrastructure failures");
    const withInfra = formatEvalReport(
      evalReport([], [extra({ state: "accepted" }), gateFailure(), ...Array.from({ length: 32 }, expiredLogin)]),
    );
    expect(withInfra).toContain("quality failures 1, accept rate 50%");
    expect(withInfra).toMatch(/Infrastructure failures {5}32, left out of the accept rate: agent 32/);
  });

  it("matches the layout of the owner's real shape", () => {
    const text = formatEvalReport(
      evalReport(
        [],
        [
          ...Array.from({ length: 3 }, () => extra({ tool: "tldrawkc", state: "accepted" })),
          extra({ tool: "tldrawkc", state: "failed", errorKind: "gate", turns: 14, costUsd: 2.1 }),
          ...Array.from({ length: 32 }, () => ({ ...expiredLogin(), tool: "tldrawkc" })),
        ],
      ),
    );
    expect(text.split("\n\nBy model")[0]).toMatchInlineSnapshot(`
      "Totals

        Videos                      0
        Rated                       0 (up 0, down 0, up share -; 0 of an older version)
        Jobs                        accepted 3, discarded 0, quality failures 1, accept rate 75%
        Cost per video              mean -, median -
        Wall time                   median -
        Spent on other jobs         $8.10
        Look                        variety -, top 5 helpers -, fade -, 3D -
        Infrastructure failures     32, left out of the accept rate: agent 32

      By tool

      Tool      videos  rated  up  down  up %  accepted  discard  quality  infra  accept  older
      --------  ------  -----  --  ----  ----  --------  -------  -------  -----  ------  -----
      tldrawkc       0      0   0     0     -         3        0        1     32     75%      0
        older: ratings of an older version of the video than it is now.
        quality, infra: failed jobs by cause. Infra failures are left out of the accept rate.

      Tool      cost mean  cost median  turns  wall median  variety  top 5  fade  3D  critic
      --------  ---------  -----------  -----  -----------  -------  -----  ----  --  ------
      tldrawkc          -            -      -            -        -      -     -   -       -"
    `);
  });

  it("fits 100 columns with the longest group name", () => {
    const long = "a-model-name-that-is-long-enough-to-be-clipped";
    const text = formatEvalReport(
      evalReport(
        [video({ assetId: "a", job: job({ model: long, costUsd: 1234.5 }), rating: { value: 1, tags: [] } })],
        [extra({ model: long, state: "failed", errorKind: "agent", turns: null, costUsd: null })],
      ),
    );
    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
  });
});

describe("a job's critic", () => {
  const scores = (accuracy: number, layout: number, relevance: number, variety: number, pacing: number) => ({
    accuracy,
    layout,
    relevance,
    variety,
    pacing,
  });
  const critic = (s: ReturnType<typeof scores>) => ({ model: "opus", costUsd: 0.01, scores: s, defects: 1, notes: 0 });
  const attempt = (n: number, c?: ReturnType<typeof critic> | null) => ({
    n,
    startedAt: null,
    endedAt: null,
    turns: 1,
    costUsd: 0.1,
    gate: null,
    ...(c === undefined ? {} : { critic: c }),
  });

  it("is the last attempt that has one, passing over an attempt with none or a null one", () => {
    expect(reportCritic([attempt(1, critic(scores(1, 1, 1, 1, 1))), attempt(2, critic(scores(5, 4, 4, 3, 3)))])).toEqual({
      mean: 3.8,
      scores: scores(5, 4, 4, 3, 3),
    });
    // Attempt 3 was not judged and attempt 4's critic gave nothing: attempt 2 stands.
    expect(reportCritic([attempt(1, critic(scores(1, 1, 1, 1, 1))), attempt(2, critic(scores(2, 2, 2, 2, 3))), attempt(3), attempt(4, null)])).toEqual({
      mean: 2.2,
      scores: scores(2, 2, 2, 2, 3),
    });
    expect(reportCritic([attempt(1), attempt(2, null)])).toBeNull();
    expect(reportCritic([])).toBeNull();
    expect(reportCritic(undefined)).toBeNull();
    expect(reportCritic(null)).toBeNull();
  });

  it("is a dash in every critic column and no totals line when no job has one", () => {
    const report = evalReport(sample, [extra()]);
    expect(report.totals.critic).toEqual({
      n: 0,
      mean: null,
      scores: { accuracy: null, layout: null, relevance: null, variety: null, pacing: null },
    });
    const text = formatEvalReport(report);
    expect(text).not.toContain("Critic");
    const rows = text.split("\n").filter((line) => line.startsWith("manimkc "));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatch(/\s-$/);
  });

  it("averages over the jobs that have one, the extras too, and groups each under its own job", () => {
    const report = evalReport(
      [
        video({ assetId: "a", job: job({ model: "opus", critic: { mean: 4, scores: scores(5, 4, 4, 3, 4) } }) }),
        video({ assetId: "b", job: job({ model: "opus", critic: null }) }),
        video({ assetId: "c", job: job({ model: "sonnet" }) }),
        // A rating that names another job moves the rating, never the critic.
        video({
          assetId: "d",
          rating: { value: -1, tags: [], job: { model: "haiku", manualHash: null }, stale: true },
          job: job({ model: "sonnet", critic: { mean: 2, scores: scores(2, 2, 2, 2, 2) } }),
        }),
      ],
      [extra({ model: "opus", state: "discarded", critic: { mean: 3, scores: scores(3, 4, 3, 2, 3) } }), extra({ model: "opus" })],
    );
    expect(report.totals.critic).toEqual({
      n: 3,
      mean: 3,
      scores: { accuracy: 3.3333, layout: 3.3333, relevance: 3, variety: 2.3333, pacing: 3 },
    });
    const model = (key: string) => report.byModel.find((g) => g.key === key)!;
    expect(model("opus").critic).toEqual({ n: 2, mean: 3.5, scores: { accuracy: 4, layout: 4, relevance: 3.5, variety: 2.5, pacing: 3.5 } });
    expect(model("sonnet").critic).toMatchObject({ n: 1, mean: 2 });
    expect(model("haiku").critic).toMatchObject({ n: 0, mean: null });

    const text = formatEvalReport(report);
    expect(text).toContain("  Critic                      3.0 over 3 jobs (accuracy 3.3, layout 3.3, relevance 3.0, variety 2.3,\n");
    expect(text).toContain("pacing 3.0)\n");
    expect(text).not.toContain(String.fromCharCode(0x2014));
    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
    const costRow = (key: string) => text.split("\n").find((line) => line.startsWith(`${key} `) && line.includes("$"))!;
    expect(costRow("opus")).toMatch(/\s3\.5$/);
    expect(costRow("sonnet")).toMatch(/\s2\.0$/);
  });

  it("says job for one job", () => {
    const text = formatEvalReport(evalReport([video({ assetId: "a", job: job({ critic: { mean: 4.2, scores: scores(5, 4, 4, 4, 4) } }) })]));
    expect(text).toContain("4.2 over 1 job (accuracy 5.0");
  });
});

describe("formatEvalReport", () => {
  const report = evalReport(sample, [
    extra({ reviewTags: ["too busy"] }),
    extra({ state: "failed", errorKind: "gate" }),
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
        Rated                       2 (up 1, down 1, up share 50%; 0 of an older version)
        Jobs                        accepted 3, discarded 1, quality failures 1, accept rate 60%
        Cost per video              mean $2.00, median $2.00
        Wall time                   median 15.0m
        Spent on other jobs         $4.00
        Look                        variety 0.60, top 5 helpers 80%, fade 75%, 3D 50%

        Rating tags: pacing 2, clear 1
        Discard tags: too busy 1

      By tool

      Tool        videos  rated  up  down  up %  accepted  discard  quality  infra  accept  older
      ----------  ------  -----  --  ----  ----  --------  -------  -------  -----  ------  -----
      manimkc          2      2   1     1   50%         2        1        1      0     50%      0
      remotionkc       2      0   0     0     -         1        0        0      0    100%      0
        older: ratings of an older version of the video than it is now.
        quality, infra: failed jobs by cause. Infra failures are left out of the accept rate.

      Tool        cost mean  cost median  turns  wall median  variety  top 5  fade   3D  critic
      ----------  ---------  -----------  -----  -----------  -------  -----  ----  ---  ------
      manimkc         $2.00        $2.00   15.0        15.0m     0.60    80%   75%  50%       -
      remotionkc          -            -      -            -        -      -     -    -       -

        manimkc rating tags: pacing 2, clear 1
        manimkc discard tags: too busy 1

      By model

      Model     videos  rated  up  down  up %  accepted  discard  quality  infra  accept  older
      --------  ------  -----  --  ----  ----  --------  -------  -------  -----  ------  -----
      (no job)       1      0   0     0     -         0        0        0      0       -      0
      opus           2      2   1     1   50%         2        1        1      0     50%      0
      sonnet         1      0   0     0     -         1        0        0      0    100%      0
        older: ratings of an older version of the video than it is now.
        quality, infra: failed jobs by cause. Infra failures are left out of the accept rate.

      Model     cost mean  cost median  turns  wall median  variety  top 5  fade   3D  critic
      --------  ---------  -----------  -----  -----------  -------  -----  ----  ---  ------
      (no job)          -            -      -            -        -      -     -    -       -
      opus          $2.00        $2.00   15.0        15.0m     0.60    80%   75%  50%       -
      sonnet            -            -      -            -        -      -     -    -       -

        opus rating tags: pacing 2, clear 1
        opus discard tags: too busy 1

      By prompt version

      Manual    videos  rated  up  down  up %  accepted  discard  quality  infra  accept  older
      --------  ------  -----  --  ----  ----  --------  -------  -------  -----  ------  -----
      (no job)       1      0   0     0     -         0        0        0      0       -      0
      (none)         1      0   0     0     -         1        0        0      0    100%      0
      abcdef01       2      2   1     1   50%         2        1        1      0     50%      0
        older: ratings of an older version of the video than it is now.
        quality, infra: failed jobs by cause. Infra failures are left out of the accept rate.

      Manual    cost mean  cost median  turns  wall median  variety  top 5  fade   3D  critic
      --------  ---------  -----------  -----  -----------  -------  -----  ----  ---  ------
      (no job)          -            -      -            -        -      -     -    -       -
      (none)            -            -      -            -        -      -     -    -       -
      abcdef01      $2.00        $2.00   15.0        15.0m     0.60    80%   75%  50%       -

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
