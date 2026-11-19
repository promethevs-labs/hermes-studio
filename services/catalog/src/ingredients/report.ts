/**
 * The evaluation report: pure math over videos, their recorded ingredients,
 * the owner's ratings and the jobs that made them.
 *
 * The input types are declared here, structurally, and do not import the
 * database's row types. The code that reads the catalog adapts its rows to
 * these, so the report stays testable on plain objects.
 */

import type { IngredientMetrics } from "./scan";

export interface ReportVideo {
  assetId: string;
  tool: string;
  title: string;
  durationSeconds: number | null;
  ingredients: {
    calls: Record<string, number>;
    metrics: IngredientMetrics;
    sceneCount: number | null;
  } | null;
  rating: { value: -1 | 0 | 1; tags: string[] } | null;
  job: {
    model: string | null;
    effort: string | null;
    manualHash: string | null;
    costUsd: number | null;
    turns: number | null;
    wallSeconds: number | null;
    attempts: number | null;
    state: string;
  } | null;
}

/** A job that made no video: failed, discarded or cancelled. */
export interface ReportJob {
  kind: string;
  tool: string;
  state: string;
  model: string | null;
  manualHash: string | null;
  costUsd: number | null;
  turns: number | null;
  wallSeconds: number | null;
  reviewTags: string[];
}

export interface Stat {
  /** How many rows had the number. */
  n: number;
  mean: number | null;
  median: number | null;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface GroupRow {
  key: string;
  videos: number;
  rated: number;
  up: number;
  down: number;
  upShare: number | null;
  tagCounts: TagCount[];
  costUsd: Stat;
  turns: Stat;
  wallSeconds: Stat;
  meanVariety: number | null;
  meanFadeShare: number | null;
  meanHelperTop5Share: number | null;
  uses3dShare: number | null;
  accepted: number;
  discarded: number;
  failed: number;
  /** accepted / (accepted + discarded + failed), null with no such job. */
  acceptRate: number | null;
  discardTags: TagCount[];
  /** Money spent on jobs that made no video. */
  wastedUsd: number;
}

export interface CallRow {
  name: string;
  calls: number;
  share: number;
}

export interface CorpusSummary {
  videosWithIngredients: number;
  totalCalls: number;
  topCalls: CallRow[];
  helperTop5Share: number | null;
  fadeShare: number | null;
  /** Library helpers with at most one call, when the library's names are known. */
  underusedHelpers: string[];
}

export interface EvalReport {
  totals: GroupRow;
  byTool: GroupRow[];
  byModel: GroupRow[];
  byManual: GroupRow[];
  corpus: CorpusSummary;
}

/** Job states that count in an accept rate. */
export const ACCEPTED_STATE = "accepted";
export const REJECTED_STATES: readonly string[] = ["discarded", "failed"];

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

function round(x: number, places: number): number {
  const f = 10 ** places;
  return Math.round(x * f) / f;
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function stat(values: Array<number | null | undefined>): Stat {
  const xs = values.filter((v): v is number => typeof v === "number");
  const m = mean(xs);
  const md = median(xs);
  return {
    n: xs.length,
    mean: m === null ? null : round(m, 4),
    median: md === null ? null : round(md, 4),
  };
}

function meanOrNull(values: Array<number | null | undefined>): number | null {
  const m = mean(values.filter((v): v is number => typeof v === "number"));
  return m === null ? null : round(m, 4);
}

function tally(tags: string[]): TagCount[] {
  const counts = new Map<string, number>();
  for (const t of tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) =>
      b.count !== a.count ? b.count - a.count : a.tag < b.tag ? -1 : 1,
    );
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

function groupRow(
  key: string,
  videos: ReportVideo[],
  jobs: ReportJob[],
): GroupRow {
  const rated = videos.filter((v) => v.rating !== null && v.rating.value !== 0);
  const up = rated.filter((v) => v.rating!.value === 1).length;
  const down = rated.filter((v) => v.rating!.value === -1).length;
  const withJob = videos.flatMap((v) => (v.job ? [v.job] : []));
  const metrics = videos.flatMap((v) =>
    v.ingredients ? [v.ingredients.metrics] : [],
  );

  const states = [
    ...withJob.map((j) => j.state),
    ...jobs.map((j) => j.state),
  ];
  const accepted = states.filter((s) => s === ACCEPTED_STATE).length;
  const discarded = states.filter((s) => s === "discarded").length;
  const failed = states.filter((s) => s === "failed").length;
  const decided = accepted + discarded + failed;

  return {
    key,
    videos: videos.length,
    rated: rated.length,
    up,
    down,
    upShare: rated.length === 0 ? null : round(up / rated.length, 4),
    tagCounts: tally(rated.flatMap((v) => v.rating!.tags)),
    costUsd: stat(withJob.map((j) => j.costUsd)),
    turns: stat(withJob.map((j) => j.turns)),
    wallSeconds: stat(withJob.map((j) => j.wallSeconds)),
    meanVariety: meanOrNull(metrics.map((m) => m.variety)),
    meanFadeShare: meanOrNull(metrics.map((m) => m.fadeShare)),
    meanHelperTop5Share: meanOrNull(metrics.map((m) => m.helperTop5Share)),
    uses3dShare:
      metrics.length === 0
        ? null
        : round(metrics.filter((m) => m.uses3d).length / metrics.length, 4),
    accepted,
    discarded,
    failed,
    acceptRate: decided === 0 ? null : round(accepted / decided, 4),
    discardTags: tally(
      jobs.filter((j) => j.state === "discarded").flatMap((j) => j.reviewTags),
    ),
    wastedUsd: round(
      jobs.reduce((s, j) => s + (j.costUsd ?? 0), 0),
      4,
    ),
  };
}

function groupBy(
  videos: ReportVideo[],
  jobs: ReportJob[],
  videoKey: (v: ReportVideo) => string,
  jobKey: (j: ReportJob) => string,
): GroupRow[] {
  const vs = new Map<string, ReportVideo[]>();
  const js = new Map<string, ReportJob[]>();
  for (const v of videos) {
    const k = videoKey(v);
    vs.set(k, [...(vs.get(k) ?? []), v]);
  }
  for (const j of jobs) {
    const k = jobKey(j);
    js.set(k, [...(js.get(k) ?? []), j]);
  }
  const keys = [...new Set([...vs.keys(), ...js.keys()])].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return keys.map((k) => groupRow(k, vs.get(k) ?? [], js.get(k) ?? []));
}

const NO_JOB = "(no job)";
const UNKNOWN = "unknown";
const NO_MANUAL = "(none)";

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

function corpusSummary(
  videos: ReportVideo[],
  libraryNames: readonly string[] | undefined,
): CorpusSummary {
  const withIng = videos.flatMap((v) => (v.ingredients ? [v.ingredients] : []));
  const calls = new Map<string, number>();
  for (const ing of withIng)
    for (const [name, n] of Object.entries(ing.calls))
      calls.set(name, (calls.get(name) ?? 0) + n);
  const total = [...calls.values()].reduce((s, v) => s + v, 0);
  const sorted = [...calls.entries()].sort((a, b) =>
    b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : 1,
  );
  const topCalls = sorted.slice(0, 20).map(([name, n]) => ({
    name,
    calls: n,
    share: total === 0 ? 0 : round(n / total, 4),
  }));

  // The share of the five busiest helpers: each video's own share, averaged
  // by its helper calls. The calls table cannot say which names are helpers.
  let weight = 0;
  let acc = 0;
  for (const ing of withIng) {
    const share = ing.metrics.helperTop5Share;
    if (share === null) continue;
    weight += ing.metrics.helperCalls;
    acc += share * ing.metrics.helperCalls;
  }
  const helperTop5Share = weight === 0 ? null : round(acc / weight, 4);

  let animations = 0;
  let fades = 0;
  for (const ing of withIng) {
    const { animationCalls, fadeShare } = ing.metrics;
    if (fadeShare === null) continue;
    animations += animationCalls;
    fades += fadeShare * animationCalls;
  }

  const underusedHelpers =
    libraryNames === undefined
      ? []
      : [...new Set(libraryNames)]
          .filter((name) => (calls.get(name) ?? 0) <= 1)
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return {
    videosWithIngredients: withIng.length,
    totalCalls: total,
    topCalls,
    helperTop5Share,
    fadeShare: animations === 0 ? null : round(fades / animations, 4),
    underusedHelpers,
  };
}

/**
 * Builds the report. `extraJobs` are jobs that made no video (failed,
 * discarded, cancelled); they feed the accept rates and the discard tags.
 * `libraryNames` are the library's helper names; they only fill the corpus
 * section's list of helpers nobody uses.
 */
export function evalReport(
  videos: ReportVideo[],
  extraJobs: ReportJob[] = [],
  libraryNames?: readonly string[],
): EvalReport {
  return {
    totals: groupRow("all", videos, extraJobs),
    byTool: groupBy(
      videos,
      extraJobs,
      (v) => v.tool,
      (j) => j.tool,
    ),
    byModel: groupBy(
      videos,
      extraJobs,
      (v) => (v.job ? (v.job.model ?? UNKNOWN) : NO_JOB),
      (j) => j.model ?? UNKNOWN,
    ),
    byManual: groupBy(
      videos,
      extraJobs,
      (v) => (v.job ? (v.job.manualHash ?? NO_MANUAL) : NO_JOB),
      (j) => j.manualHash ?? NO_MANUAL,
    ),
    corpus: corpusSummary(videos, libraryNames),
  };
}

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

const NAME_WIDTH = 26;
const LINE_WIDTH = 100;

function pct(x: number | null): string {
  return x === null ? "-" : `${Math.round(x * 100)}%`;
}

function dec(x: number | null, places: number): string {
  return x === null ? "-" : x.toFixed(places);
}

function usd(x: number | null): string {
  return x === null ? "-" : `$${x.toFixed(x < 1 ? 3 : 2)}`;
}

function secs(x: number | null): string {
  if (x === null) return "-";
  if (x < 90) return `${Math.round(x)}s`;
  return `${(x / 60).toFixed(1)}m`;
}

function clip(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, width - 1)}…`;
}

/** An aligned table: first column left, the rest right. */
function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, c) =>
    Math.max(h.length, ...rows.map((r) => (r[c] ?? "").length)),
  );
  const fmt = (cells: string[]) =>
    cells
      .map((cell, c) =>
        c === 0 ? cell.padEnd(widths[c] ?? 0) : cell.padStart(widths[c] ?? 0),
      )
      .join("  ")
      .trimEnd();
  return [fmt(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(fmt)];
}

function wrap(prefix: string, items: string[]): string[] {
  const indent = " ".repeat(prefix.length);
  const lines: string[] = [];
  let cur = prefix;
  let first = true;
  for (const item of items) {
    const piece = first ? item : `, ${item}`;
    if (!first && cur.length + piece.length > LINE_WIDTH) {
      lines.push(`${cur},`);
      cur = indent + item;
    } else cur += piece;
    first = false;
  }
  lines.push(cur);
  return lines;
}

function tagLine(label: string, tags: TagCount[]): string[] {
  if (tags.length === 0) return [];
  return wrap(
    `  ${label}: `,
    tags.slice(0, 8).map((t) => `${t.tag} ${t.count}`),
  );
}

function groupSection(title: string, rows: GroupRow[], keyLabel: string): string[] {
  const out = [title, ""];
  if (rows.length === 0) return [...out, "  No videos.", ""];
  out.push(
    ...table(
      [keyLabel, "videos", "rated", "up", "down", "up share", "accepted", "discarded", "failed", "accept rate"],
      rows.map((r) => [
        clip(r.key, NAME_WIDTH),
        String(r.videos),
        String(r.rated),
        String(r.up),
        String(r.down),
        pct(r.upShare),
        String(r.accepted),
        String(r.discarded),
        String(r.failed),
        pct(r.acceptRate),
      ]),
    ),
    "",
    ...table(
      [keyLabel, "cost mean", "cost median", "turns", "wall median", "variety", "top 5", "fade", "3D"],
      rows.map((r) => [
        clip(r.key, NAME_WIDTH),
        usd(r.costUsd.mean),
        usd(r.costUsd.median),
        dec(r.turns.median, 1),
        secs(r.wallSeconds.median),
        dec(r.meanVariety, 2),
        pct(r.meanHelperTop5Share),
        pct(r.meanFadeShare),
        pct(r.uses3dShare),
      ]),
    ),
  );
  const tags = rows.flatMap((r) => [
    ...tagLine(`${clip(r.key, NAME_WIDTH)} rating tags`, r.tagCounts),
    ...tagLine(`${clip(r.key, NAME_WIDTH)} discard tags`, r.discardTags),
  ]);
  if (tags.length > 0) out.push("", ...tags);
  out.push("");
  return out;
}

/** Renders the report as plain text for a terminal 100 columns wide. */
export function formatEvalReport(report: EvalReport): string {
  const t = report.totals;
  const out: string[] = [];

  out.push("Totals", "");
  const kv = (label: string, value: string) =>
    `  ${label.padEnd(28)}${value}`;
  out.push(
    kv("Videos", String(t.videos)),
    kv("Rated", `${t.rated} (up ${t.up}, down ${t.down}, up share ${pct(t.upShare)})`),
    kv(
      "Jobs",
      `accepted ${t.accepted}, discarded ${t.discarded}, failed ${t.failed}, accept rate ${pct(t.acceptRate)}`,
    ),
    kv("Cost per video", `mean ${usd(t.costUsd.mean)}, median ${usd(t.costUsd.median)}`),
    kv("Wall time", `median ${secs(t.wallSeconds.median)}`),
    kv("Spent on jobs with no video", usd(t.wastedUsd)),
    kv(
      "Look",
      `variety ${dec(t.meanVariety, 2)}, top 5 helpers ${pct(t.meanHelperTop5Share)}, fade ${pct(t.meanFadeShare)}, 3D ${pct(t.uses3dShare)}`,
    ),
  );
  const totalTags = [
    ...tagLine("Rating tags", t.tagCounts),
    ...tagLine("Discard tags", t.discardTags),
  ];
  if (totalTags.length > 0) out.push("", ...totalTags);
  out.push("");

  out.push(...groupSection("By tool", report.byTool, "Tool"));
  out.push(...groupSection("By model", report.byModel, "Model"));
  out.push(
    ...groupSection(
      "By prompt version",
      report.byManual.map((r) => ({
        ...r,
        key: r.key.startsWith("(") ? r.key : r.key.slice(0, 8),
      })),
      "Manual",
    ),
  );

  const c = report.corpus;
  out.push("Corpus calls", "");
  if (c.videosWithIngredients === 0) {
    out.push("  No video has recorded ingredients yet.");
  } else {
    out.push(
      `  ${c.videosWithIngredients} videos, ${c.totalCalls} calls. Top 5 helpers ${pct(c.helperTop5Share)} of helper calls, fade ${pct(c.fadeShare)} of animation calls.`,
      "",
      ...table(
        ["Name", "calls", "share"],
        c.topCalls.map((r) => [
          clip(r.name, NAME_WIDTH + 14),
          String(r.calls),
          pct(r.share),
        ]),
      ),
    );
    if (c.underusedHelpers.length > 0) {
      out.push(
        "",
        ...wrap(
          `  Library helpers with one call or none (${c.underusedHelpers.length}): `,
          c.underusedHelpers,
        ),
      );
    }
  }
  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}
