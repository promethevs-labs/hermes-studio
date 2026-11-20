import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { SHOT_TEXT_LIMITS, type VideoShot } from "@hermes/schema/shared";

import { agentAuth, artDirectorMs, PLANNER_IDLE_MS } from "../config";
import { costFromLog, JobCostMeter, type CostSource, type SpendEntry } from "../cost";
import { BriefError } from "../diagram/brief";
import { checkShotPlan, validateShot, type VideoBrief } from "../video/brief";
import { briefTool } from "../video/tools";
import { artDirectorFollowUp, artDirectorMessage, buildArtDirectorSystemPrompt } from "./art-director-prompt";
import { fencedBlocks, plannerArgv, plannerSettings, startPlanner, type PlannerOutcome, type PlannerRun } from "./planner";

/**
 * The art director (docs/STUDIO-VIDEOS.md, "The shot plan"): one sealed
 * `claude -p` that reads an approved script and answers with one shot per
 * scene, and at most one follow-up when that answer is refused.
 *
 * It is spawned exactly as a planner turn is, through `plannerArgv` and
 * `startPlanner`: no tools, no MCP servers, no settings sources, safe mode, a
 * deny-everything settings file, and a turn whose `system/init` lists any
 * tool or server is stopped before its reply (`PlannerRun`'s C15 check). It
 * always runs on `claude` and the machine's login, whatever harness the
 * conversation's planner uses, since a shot plan is a studio step and not a
 * turn of that conversation.
 *
 * **Its output is untrusted**, as the planner's is: a reply is parsed, every
 * shot goes through the brief validator's own shot rules, and only then is it
 * laid on the brief, which a person still reads on the card.
 */

/** One spawn's spend, structurally a `SpendEntry`, dated at its own end. */
export interface ShotSpend extends SpendEntry {
  startedAt: string;
  finishedAt: string;
  costUsd: number | null;
  costSource: CostSource | null;
}

export interface DirectorResult {
  status: "planned" | "failed";
  /** One shot per scene, in order, when planned. */
  shots: VideoShot[] | null;
  /** Why there is no plan, in a sentence a person can read; null when planned. */
  reason: string | null;
  /** The spawns' summed cost; null when none could be priced. */
  costUsd: number | null;
  spend: ShotSpend[];
  /** How many spawns ran: 1, or 2 after a refused first plan. */
  attempts: number;
}

export type DirectedBrief = Pick<VideoBrief, "title" | "idea" | "audience" | "voice" | "scenes" | "tool">;

export interface DirectInput {
  brief: DirectedBrief;
  /** The plan's own workspace, absolute: its prompt, settings, session log and scratch go here. */
  dir: string;
  model: string;
  /** The limit on each spawn; absent is `STUDIO_ART_DIRECTOR_MS`. */
  timeoutMs?: number;
  /** Silence on a spawn's stdout before it is stopped; absent is `STUDIO_PLANNER_IDLE_MS`. */
  idleMs?: number;
  /**
   * Told of each spawn's spend the moment it ends, before the next one
   * starts, so a caller can write it down then: a crash during the
   * follow-up must not lose the first call's cost.
   */
  onSpend?: (entry: ShotSpend) => Promise<void>;
  /** Told of each spawn as it starts, and of null when it ends, so the caller can stop it. */
  track?: (run: PlannerRun | null) => void;
  /** Asked before each spawn: true stops before paying for another. */
  stopped?: () => boolean;
}

/** A line over its limit by more than this factor is refused, not cut: the reply did not mean the field. */
export const SHOT_TEXT_CUT_FACTOR = 2;

/**
 * A shot text field a little over its limit, cut back to the last whole word
 * that fits, with no mark added and no trailing comma, colon or dash. Returns
 * null when the value is not a string, is already within the limit, is more
 * than `SHOT_TEXT_CUT_FACTOR` times the limit, or has no word boundary to cut
 * at; the validator then reads the value as it came, and refuses what it
 * should.
 */
export function cutToFit(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length <= limit || trimmed.length > limit * SHOT_TEXT_CUT_FACTOR) return null;
  // The cut is at a space inside the limit, or at the limit when the next character is one.
  const head = trimmed.slice(0, limit + 1);
  const space = head.search(/\s\S*$/);
  if (space <= 0) return null;
  const cut = head.slice(0, space).replace(/[\s,;:-]+$/, "");
  return cut === "" ? null : cut;
}

/**
 * The reply's entries with each over-long `layout`, `motion` or `emphasis`
 * cut to fit (`cutToFit`), and a note for each cut line, such as
 * `scenes[1].shot.layout 203 to 188 characters`. The entries are copied,
 * never edited in place.
 */
function fitShotText(scenes: unknown[]): { scenes: unknown[]; shortened: string[] } {
  const shortened: string[] = [];
  const fitted = scenes.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) return entry;
    const shot = (entry as { shot?: unknown }).shot;
    if (typeof shot !== "object" || shot === null || Array.isArray(shot)) return entry;
    const next: Record<string, unknown> = { ...(shot as Record<string, unknown>) };
    for (const name of ["layout", "motion", "emphasis"] as const) {
      const cut = cutToFit(next[name], SHOT_TEXT_LIMITS[name]);
      if (cut === null) continue;
      shortened.push(`scenes[${i}].shot.${name} ${(next[name] as string).trim().length} to ${cut.length} characters`);
      next[name] = cut;
    }
    return { ...(entry as object), shot: next };
  });
  return { scenes: fitted, shortened };
}

/**
 * Read a reply's `shots` block against the brief: one valid shot per scene,
 * the brief's names in the brief's order, and the plan's own rules. A text
 * field a little over its limit is cut to fit at a word boundary instead of
 * failing the plan, and named in `shortened`; one over twice its limit is
 * refused like any other fault. Returns the shots, or a sentence naming
 * exactly what was wrong.
 */
export function readShots(text: string, brief: Pick<VideoBrief, "scenes">): { shots: VideoShot[]; shortened: string[] } | { problem: string } {
  const body = fencedBlocks(text, "shots").at(-1);
  if (body === undefined) return { problem: "The reply has no fenced block tagged shots." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return { problem: `The shots block is not JSON: ${(error as Error).message}.` };
  }
  const scenes = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as { scenes?: unknown }).scenes : undefined;
  if (!Array.isArray(scenes)) return { problem: `The shots block must be one object with a "scenes" list.` };
  if (scenes.length !== brief.scenes.length) {
    return { problem: `The shots block has ${scenes.length} entries and the brief has ${brief.scenes.length} scenes; give exactly one per scene.` };
  }
  const { scenes: fitted, shortened } = fitShotText(scenes);
  try {
    const shots = fitted.map((entry: unknown, i) => {
      const name = typeof entry === "object" && entry !== null ? (entry as { name?: unknown }).name : undefined;
      const want = brief.scenes[i]!.name;
      if (name !== want) {
        throw new BriefError(`scenes[${i}].name`, `entry ${i} is named ${JSON.stringify(name ?? null)} where the brief's scene ${i} is "${want}"; keep the brief's names and order`);
      }
      return validateShot((entry as { shot?: unknown }).shot, `scenes[${i}].shot`);
    });
    checkShotPlan(shots.map((shot) => ({ shot })));
    return { shots, shortened };
  } catch (error) {
    if (error instanceof BriefError) return { problem: `${error.field}: ${error.message}` };
    throw error;
  }
}

/** Why a spawn gave no reply worth reading, or null when it did. */
function noReply(run: PlannerOutcome, timeoutMs: number, idleMs: number): string | null {
  if (run.spawnFailed) return `the art director never started: ${run.stderr}`;
  if (run.sealBroken !== null) return `${run.sealBroken.replace(/^the planner/, "the art director")}, so it was stopped before its reply`;
  // Two limits, named apart: the whole call's, and the silence one.
  if (run.stopReason === "turn-timeout") return `the art director took longer than ${seconds(timeoutMs)}`;
  if (run.stopReason === "idle-timeout") return `the art director went quiet for ${seconds(idleMs)}, so it was stopped`;
  if (run.stopReason !== null) return "the art director was stopped before it answered";
  if (run.isError || run.exitCode !== 0) {
    return `the art director's session failed: ${run.result ?? (run.stderr || run.subtype || `exit ${run.exitCode ?? run.signal}`)}`;
  }
  if (run.text === "") return "the art director ended with no reply";
  return null;
}

function seconds(ms: number): string {
  const whole = Math.round(ms / 1000);
  return `${whole} ${whole === 1 ? "second" : "seconds"}`;
}

/** The line that opens each spawn in a plan's `session.ndjson`: what a recovery finds a spawn by. */
export const SHOT_MARKER = "studio-shots";

/**
 * The spend of every spawn in a plan's session log that `recorded` does not
 * already hold, by its start: what a studio that stopped mid-plan never
 * wrote down. Each spawn is priced from its own lines, as an interrupted
 * planner turn is (`costFromLog`), and dated `now`, since it stopped
 * spending no later than the restart that found it.
 */
export async function unrecordedShotSpend(logFile: string, recorded: ReadonlySet<string>, now = new Date().toISOString()): Promise<ShotSpend[]> {
  const body = await readFile(logFile, "utf8").catch(() => "");
  const spawns: { at: string; model: string | null; lines: string[] }[] = [];
  for (const line of body.split("\n")) {
    if (line.trim() === "") continue;
    let marker: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null && (parsed as { type?: unknown }).type === SHOT_MARKER) marker = parsed as Record<string, unknown>;
    } catch {
      // A line cut off by the crash: part of the spawn before it, unpriceable.
    }
    if (marker !== null && typeof marker.at === "string") {
      spawns.push({ at: marker.at, model: typeof marker.model === "string" ? marker.model : null, lines: [] });
    } else {
      spawns.at(-1)?.lines.push(line);
    }
  }
  return spawns
    .filter((spawn) => !recorded.has(spawn.at) && spawn.lines.length > 0)
    .map((spawn) => {
      const reading = costFromLog(spawn.lines.join("\n"), spawn.model);
      return { startedAt: spawn.at, finishedAt: now, costUsd: reading.usd, costSource: reading.source };
    });
}

/**
 * Plan the shots for a brief: one spawn, and one follow-up naming what was
 * wrong when its plan is refused. A second refusal, a timeout, a broken seal
 * or a failed session leaves the brief without shots, and says why. Never
 * throws for any of those: a shot plan that fails must not fail what asked
 * for it.
 */
export async function directShots(input: DirectInput): Promise<DirectorResult> {
  const timeoutMs = input.timeoutMs ?? artDirectorMs();
  const idleMs = input.idleMs ?? PLANNER_IDLE_MS;
  await mkdir(path.join(input.dir, "tmp"), { recursive: true });
  const systemPromptFile = path.join(input.dir, "system.md");
  const settingsFile = path.join(input.dir, "settings.json");
  const logFile = path.join(input.dir, "session.ndjson");
  await writeFile(systemPromptFile, buildArtDirectorSystemPrompt(briefTool(input.brief)), "utf8");
  await writeFile(settingsFile, `${JSON.stringify(plannerSettings(), null, 1)}\n`, "utf8");
  const sessionId = randomUUID();
  const spend: ShotSpend[] = [];
  const result = (status: DirectorResult["status"], shots: VideoShot[] | null, reason: string | null): DirectorResult => {
    const priced = spend.filter((entry) => entry.costUsd !== null);
    const costUsd = priced.length === 0 ? null : Math.round(priced.reduce((sum, entry) => sum + entry.costUsd!, 0) * 1_000_000) / 1_000_000;
    return { status, shots, reason, costUsd, spend, attempts: spend.length };
  };

  let prompt = artDirectorMessage(input.brief);
  let lastProblem: string | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (input.stopped?.() === true) return result("failed", null, "the studio stopped before the art director answered");
    const startedAt = new Date().toISOString();
    const meter = new JobCostMeter(input.model);
    // Written before the spawn, so a restart that finds the log can price it.
    await appendFile(logFile, `${JSON.stringify({ type: SHOT_MARKER, attempt: attempt + 1, at: startedAt, model: input.model })}\n`, "utf8");
    let log: Promise<void> = Promise.resolve();
    const run = startPlanner({
      argv: plannerArgv({ systemPromptFile, settingsFile, sessionId, resume: attempt > 0, model: input.model }),
      prompt,
      cwd: input.dir,
      auth: agentAuth(),
      tmp: path.join(input.dir, "tmp"),
      turnMs: timeoutMs,
      idleMs,
      onLine: (line) => {
        meter.observe(line);
        log = log.then(() => appendFile(logFile, `${line}\n`, "utf8")).catch(() => undefined);
      },
    });
    input.track?.(run);
    let outcome: PlannerOutcome;
    try {
      outcome = await run.done;
    } finally {
      input.track?.(null);
    }
    await log.catch(() => undefined);
    const reading = meter.read();
    const entry: ShotSpend = { startedAt, finishedAt: new Date().toISOString(), costUsd: reading.usd, costSource: reading.source };
    spend.push(entry);
    await input.onSpend?.(entry).catch(() => undefined);

    const failed = noReply(outcome, timeoutMs, idleMs);
    if (failed !== null) return result("failed", null, failed);
    const read = readShots(outcome.text, input.brief);
    if ("shots" in read) {
      // The plan's record has no place for a note, so a cut line is logged.
      if (read.shortened.length > 0) console.warn(`studio: the art director's shot plan was shortened to fit: ${read.shortened.join("; ")}`);
      return result("planned", read.shots, null);
    }
    lastProblem = read.problem;
    prompt = artDirectorFollowUp(read.problem);
  }
  return result("failed", null, `the art director's plan was refused twice: ${lastProblem}`);
}
