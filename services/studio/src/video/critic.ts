import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { appendFile, mkdir, open, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { CRITIC_DIMENSIONS, CRITIC_SCORE_RANGE, type CriticDimension, type JobRunCritic } from "@hermes/schema/shared";

import { agentEnv } from "../agent/agent";
import { CLAUDE_BIN, KILL_GRACE_MS, type AgentAuth } from "../config";
import { JobCostMeter, type CostSource, type SpendEntry } from "../cost";
import { claudeTempRules, rule, siblingJobRules, studioHomeRules } from "../diagram/settings";
import { jobDir } from "../paths";
import { signalGroup } from "../proc";
import { CopyRefused, safeCopy } from "./copy";
import {
  CRITIC_MAX_DEFECTS,
  CRITIC_MAX_NOTES,
  CRITIC_MAX_TEXT,
  criticFollowUp,
  criticSystemPrompt,
  criticUserMessage,
} from "./critic-prompt";
import type { VideoJobRecord } from "./types";

/**
 * The picture check (D116 of docs/STUDIO-LOOK.md; "The critic" in
 * docs/STUDIO-VIDEOS.md): after a build passes the gate, one `claude -p`
 * reads the contact sheets against a rubric of five scores and names the
 * defects it can point to in a scene.
 *
 * Everything here is about one call and its answer: copying the sheets out
 * of `render/` before anything reads them, the seal, the spawn, and the
 * strict check of the reply. When it runs, what a defect does to the job
 * and what it costs against the cap are the runner's (`runner.ts`).
 *
 * **It never fails a job.** Every way a call can go wrong (no sheets, a
 * refused request, a timeout, a seal that did not hold, two unusable
 * replies, a cancel) ends in a `CriticRun` with no scores and an `error`
 * saying why, and the runner carries on as if no critic existed.
 */

/** A sheet larger than this is skipped, not read. A 16 by 9 grid at 1080p is a few megabytes. */
export const CRITIC_MAX_SHEET_BYTES = 20 * 2 ** 20;
/** At most this many sheets in one call: manimkc's one per scene, for a long video, and no more. */
export const CRITIC_MAX_SHEETS = 16;
/** The CLI's own turn cap: a Read per sheet, the reply, and room for a retried Read. */
export const CRITIC_MAX_TURNS = CRITIC_MAX_SHEETS * 2 + 4;
/** How many critic runs a job record keeps: the standalone route can add one per press. */
export const CRITIC_RUNS_KEPT = 20;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** No MCP server at all, as the planner is given (`EMPTY_MCP_CONFIG` in drafts/planner.ts). */
const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';

/** Every built-in but Read that touches the filesystem or the network, denied as a belt over `--tools Read`. */
export const CRITIC_DENY_TOOLS = ["Bash", "Edit", "Write", "NotebookEdit", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "Agent"] as const;

export interface CriticDefect {
  /** The scene's class, whichever of its class or name the critic wrote. */
  scene: string;
  problem: string;
  fix: string;
}

/** A sheet the critic was given: a copy under the run's own directory. */
export interface CriticSheet {
  id: string;
  title: string | null;
  /** The scenes it shows, in play order; empty for the whole built video. */
  scenes: string[];
  /** The copy, absolute. */
  file: string;
}

/**
 * One picture check, as the job record keeps it in `job.json`. Its
 * `startedAt`, `finishedAt` and `costUsd` make it a `SpendEntry`, which is
 * how its cost counts against `STUDIO_DAILY_USD` without being added to the
 * job's own `cost_usd`.
 */
export interface CriticRun {
  /** The attempt it judged; null for a run from the standalone route. */
  attempt: number | null;
  standalone: boolean;
  startedAt: string;
  finishedAt: string | null;
  /** The model the session named, else the one passed. */
  model: string | null;
  costUsd: number | null;
  costSource: CostSource | null;
  /** Null when the critic gave no usable answer. */
  scores: Record<CriticDimension, number> | null;
  defects: CriticDefect[];
  notes: string[];
  sheets: CriticSheet[];
  /** Sheets that were not given to it, and why. */
  skipped: { id: string; reason: string }[];
  /** Why there are no scores, when there are none. */
  error: string | null;
  /** True when its defects went back to the agent as the next attempt's findings. */
  sentBack: boolean;
  /** How many times `claude` was spawned: 0 when there was nothing to read or the cap stopped it, 2 after a follow-up. */
  calls: number;
}

/** A run that never spawned: nothing to read, the cap, or the mode. */
export function skippedRun(attempt: number | null, reason: string, extra: Partial<CriticRun> = {}): CriticRun {
  const now = new Date().toISOString();
  return {
    attempt,
    standalone: attempt === null,
    startedAt: now,
    finishedAt: now,
    model: null,
    costUsd: null,
    costSource: null,
    scores: null,
    defects: [],
    notes: [],
    sheets: [],
    skipped: [],
    error: reason,
    sentBack: false,
    calls: 0,
    ...extra,
  };
}

/** The attempt's summary for the run record, `JobRunCritic`, from a run that spawned. Null when it gave no scores. */
export function criticSummary(run: CriticRun): JobRunCritic | null {
  if (run.scores === null) return null;
  return { model: run.model, costUsd: run.costUsd, scores: { ...run.scores }, defects: run.defects.length, notes: run.notes.length };
}

/** Every critic run's spend across the records, for the rolling day the cap counts. */
export function criticSpend(records: readonly Pick<VideoJobRecord, "critic">[]): SpendEntry[] {
  return records.flatMap((record) =>
    (record.critic ?? []).map((run) => ({ startedAt: run.startedAt, finishedAt: run.finishedAt, costUsd: run.costUsd })),
  );
}

/** One line of a retry's findings, per defect sent back. */
export function defectFinding(defect: CriticDefect): string {
  return `Scene ${defect.scene}: ${defect.problem} Fix: ${defect.fix}`;
}

/* -------------------------------------------------------------------------- */
/* The sheets                                                                 */
/* -------------------------------------------------------------------------- */

/** A sheet to copy: where it is now (under `render/`, or the job's kept `sheets/`), and what it shows. */
export interface CriticSource {
  id: string;
  title: string | null;
  scenes: readonly string[];
  from: string;
}

/**
 * Copy each sheet into `into`, the gate's way (`safeCopy`: a regular file
 * with one link, no symbolic link followed, at most `CRITIC_MAX_SHEET_BYTES`),
 * then check the copy starts as a PNG does. Only copies are ever named to the
 * critic: a file under `render/` was written by agent code and can change
 * between a check and a read. A sheet that fails is skipped and named.
 */
export async function copyCriticSheets(
  sources: readonly CriticSource[],
  into: string,
): Promise<{ sheets: CriticSheet[]; skipped: { id: string; reason: string }[] }> {
  await mkdir(into, { recursive: true });
  const sheets: CriticSheet[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const [index, source] of sources.entries()) {
    if (sheets.length >= CRITIC_MAX_SHEETS) {
      skipped.push({ id: source.id, reason: `over the ${CRITIC_MAX_SHEETS} sheets one critic call reads` });
      continue;
    }
    const to = path.join(into, `${String(index + 1).padStart(2, "0")}-${source.id.replace(/[^A-Za-z0-9_-]/g, "_")}.png`);
    try {
      await safeCopy(source.from, to, CRITIC_MAX_SHEET_BYTES);
    } catch (error) {
      await rm(to, { force: true });
      skipped.push({ id: source.id, reason: error instanceof CopyRefused ? error.message : `could not be copied: ${(error as Error).message}` });
      continue;
    }
    if (!(await isPng(to))) {
      await rm(to, { force: true });
      skipped.push({ id: source.id, reason: `${path.basename(source.from)} is not a PNG` });
      continue;
    }
    sheets.push({ id: source.id, title: source.title, scenes: [...source.scenes], file: to });
  }
  return { sheets, skipped };
}

async function isPng(file: string): Promise<boolean> {
  const handle = await open(file, "r");
  try {
    const head = Buffer.alloc(PNG_MAGIC.length);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return bytesRead === PNG_MAGIC.length && head.equals(PNG_MAGIC);
  } finally {
    await handle.close();
  }
}

/* -------------------------------------------------------------------------- */
/* The seal                                                                   */
/* -------------------------------------------------------------------------- */

/** A path and its resolved spelling, when they differ: the CLI matches either. */
function spellings(target: string): string[] {
  try {
    return [...new Set([target, realpathSync(target)])];
  } catch {
    return [target];
  }
}

/** Where one critic run keeps its files, all inside the job's own `critic/<label>/`. */
export interface CriticPaths {
  dir: string;
  /** The copies, and the session's working directory: nothing else is in it. */
  sheets: string;
  settings: string;
  system: string;
  log: string;
  tmp: string;
}

export function criticPaths(jobId: string, label: string): CriticPaths {
  const dir = path.join(jobDir(jobId), "critic", label);
  return {
    dir,
    sheets: path.join(dir, "sheets"),
    settings: path.join(dir, "settings.json"),
    system: path.join(dir, "system.md"),
    log: path.join(dir, "session.ndjson"),
    tmp: path.join(dir, "tmp"),
  };
}

export interface CriticSettings {
  permissions: { defaultMode: "default"; blockReadsOutsideWorkingDirectories: true; allow: string[]; deny: string[] };
}

/**
 * The critic's permission file: Read on exactly the copied sheets, by
 * absolute path (both spellings), and nothing else allowed. Reads outside the
 * working directory, which holds only those copies, are blocked; the rest of
 * the job, the studio home, every other job, the owner's secrets and the
 * CLI's temp root are denied by name as well, and every other tool is denied
 * as a belt over `--tools Read`.
 */
export function criticSettings(jobId: string, paths: CriticPaths, sheets: readonly CriticSheet[]): CriticSettings {
  const home = process.env.HOME ?? "";
  const job = jobDir(jobId);
  const allow = [...new Set(sheets.flatMap((sheet) => spellings(sheet.file)).map((file) => rule("Read", file)))];
  const deny = [
    ...CRITIC_DENY_TOOLS,
    ...[".claude", ".ssh", ".aws", ".gnupg"].map((dir) => rule("Read", path.join(home, dir), "/**")),
    rule("Read", path.join(home, ".claude.json")),
    rule("Read", path.join(home, ".netrc")),
    // This run's own files beside the copies, and the job's records and renders.
    ...[paths.settings, paths.system, paths.log, path.join(job, "job.json"), path.join(job, "session.ndjson"), path.join(job, "settings.json")].map((file) =>
      rule("Read", file),
    ),
    ...["render", "candidate", "source", "sheets", "clips", "bin", "tmp"].map((dir) => rule("Read", path.join(job, dir), "/**")),
    rule("Read", paths.tmp, "/**"),
    ...studioHomeRules(),
    ...siblingJobRules(jobId),
    ...claudeTempRules(),
  ];
  return {
    permissions: { defaultMode: "default", blockReadsOutsideWorkingDirectories: true, allow, deny: [...new Set(deny)] },
  };
}

/**
 * The critic's argv. The planner's seals (`plannerArgv` in
 * drafts/planner.ts), with Read as its one tool:
 *
 * - `--tools Read`: the one built-in; the init event must list nothing else.
 * - `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`: no MCP server,
 *   the account's connectors included (D34).
 * - `--safe-mode`, `--disable-slash-commands`: no CLAUDE.md, memory,
 *   plugins, hooks or skills.
 * - `--setting-sources ""` and `--settings <file>`: no other settings file
 *   contributes a rule; this one allows Read on the copies alone.
 * - `--permission-prompts none`: anything else is refused, not asked.
 * - `--system-prompt-file`: the rubric replaces the CLI's own prompt.
 * - `--max-turns`, the stream flags the cost meter needs, and `--model`.
 *
 * The brief goes on stdin, never into argv, as the planner's message does.
 */
export function criticArgv(input: { paths: CriticPaths; model: string; sessionId: string; resume: boolean }): string[] {
  return [
    "-p",
    "--system-prompt-file",
    input.paths.system,
    "--tools",
    "Read",
    "--strict-mcp-config",
    "--mcp-config",
    EMPTY_MCP_CONFIG,
    "--safe-mode",
    "--disable-slash-commands",
    "--setting-sources",
    "",
    "--settings",
    input.paths.settings,
    "--permission-prompts",
    "none",
    "--max-turns",
    String(CRITIC_MAX_TURNS),
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    input.model,
    ...(input.resume ? ["--resume", input.sessionId] : ["--session-id", input.sessionId]),
  ];
}

/* -------------------------------------------------------------------------- */
/* One call                                                                   */
/* -------------------------------------------------------------------------- */

export type CriticStop = "timeout" | "cancelled" | "sealed" | null;

export interface CriticCallOutcome {
  exitCode: number | null;
  /** The result text, else the assistant's. */
  text: string;
  isError: boolean;
  init: { tools: string[]; mcpServers: unknown[]; model: string | null } | null;
  stopReason: CriticStop;
  /** Set when the init event listed a tool other than Read, or any MCP server. */
  sealBroken: string | null;
  spawnFailed: boolean;
  stderr: string;
}

/** One critic process: spawned into its own group, timed, stoppable, its seal checked on its init event. */
export class CriticCall {
  private readonly child: ChildProcess;
  private stopReason: CriticStop = null;
  private readonly timers: NodeJS.Timeout[] = [];
  readonly done: Promise<CriticCallOutcome>;

  constructor(child: ChildProcess, timeoutMs: number, onLine: (line: string) => void) {
    this.child = child;
    this.done = this.watch(timeoutMs, onLine);
  }

  private watch(timeoutMs: number, onLine: (line: string) => void): Promise<CriticCallOutcome> {
    return new Promise((resolve) => {
      let buffer = "";
      let result: string | null = null;
      let assistant = "";
      let isError = false;
      let init: CriticCallOutcome["init"] = null;
      let sealBroken: string | null = null;
      let stderr = "";
      this.timers.push(setTimeout(() => void this.stop("timeout"), timeoutMs));

      const handle = (line: string): void => {
        onLine(line);
        let event: Record<string, unknown> | null = null;
        try {
          const parsed: unknown = JSON.parse(line);
          event = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
        } catch {
          return;
        }
        if (event === null) return;
        if (event.type === "system" && event.subtype === "init") {
          init = {
            tools: Array.isArray(event.tools) ? event.tools.map(String) : [],
            mcpServers: Array.isArray(event.mcp_servers) ? event.mcp_servers : [],
            model: typeof event.model === "string" ? event.model : null,
          };
          const extra = init.tools.filter((tool) => tool !== "Read");
          if (extra.length > 0 || init.mcpServers.length > 0) {
            sealBroken =
              `the critic started with ${extra.length} tool(s) besides Read and ${init.mcpServers.length} MCP server(s) ` +
              `(${[...extra, ...init.mcpServers.map((server) => JSON.stringify(server))].slice(0, 6).join(", ")}), where it must have Read alone`;
            void this.stop("sealed");
          }
          return;
        }
        if (event.type === "assistant") {
          const message = event.message as { content?: unknown } | undefined;
          const content = Array.isArray(message?.content) ? message.content : [];
          const text = content
            .filter((block): block is { type: string; text: string } => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
            .map((block) => block.text)
            .join("");
          if (text !== "") assistant = assistant === "" ? text : `${assistant}\n\n${text}`;
          return;
        }
        if (event.type === "result") {
          result = typeof event.result === "string" ? event.result : null;
          isError = event.is_error === true;
        }
      };

      this.child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) if (line.trim() !== "") handle(line);
      });
      this.child.stderr?.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-4_000);
      });
      this.child.on("close", (code) => {
        if (buffer.trim() !== "") handle(buffer);
        this.clear();
        resolve({
          exitCode: code,
          text: (result !== null && result.trim() !== "" ? result : assistant).trim(),
          isError,
          init,
          stopReason: this.stopReason,
          sealBroken,
          spawnFailed: false,
          stderr: stderr.trim(),
        });
      });
      this.child.on("error", (error) => {
        this.clear();
        resolve({
          exitCode: null,
          text: "",
          isError: true,
          init: null,
          stopReason: this.stopReason,
          sealBroken: null,
          spawnFailed: true,
          stderr: `could not start ${CLAUDE_BIN}: ${error.message}`,
        });
      });
    });
  }

  private clear(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.length = 0;
  }

  /** SIGTERM to the group, then SIGKILL after the grace window. */
  async stop(reason: Exclude<CriticStop, null>): Promise<void> {
    if (this.stopReason !== null) return;
    this.stopReason = reason;
    const pid = this.child.pid;
    if (pid === undefined) return;
    signalGroup(pid, "SIGTERM");
    const kill = setTimeout(() => signalGroup(pid, "SIGKILL"), KILL_GRACE_MS);
    kill.unref();
    this.timers.push(kill);
  }
}

function startCall(input: { argv: string[]; prompt: string; paths: CriticPaths; auth: AgentAuth; timeoutMs: number; onLine: (line: string) => void }): CriticCall {
  const child = spawn(CLAUDE_BIN, input.argv, {
    cwd: input.paths.sheets,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    // The machine's login, as every video job's agent (`agentEnv`), with the
    // CLI's temp root inside this run's directory.
    env: agentEnv(process.env, input.auth, input.paths.tmp),
  });
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(input.prompt, "utf8");
  return new CriticCall(child, input.timeoutMs, input.onLine);
}

/* -------------------------------------------------------------------------- */
/* The reply                                                                  */
/* -------------------------------------------------------------------------- */

export interface CriticVerdict {
  scores: Record<CriticDimension, number>;
  defects: CriticDefect[];
  notes: string[];
}

/** The brief's scenes the critic may name: each class, and the name it was written from. */
export interface CriticScene {
  class: string;
  name: string;
}

// Control characters, a newline among them: every text is one line.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function lineProblem(value: unknown, field: string): string | null {
  if (typeof value !== "string") return `${field} is a string`;
  if (value.trim() === "") return `${field} is empty`;
  if (CONTROL.test(value)) return `${field} holds a line break or a control character; each text is one line`;
  if (value.length > CRITIC_MAX_TEXT) return `${field} is ${value.length} characters, over ${CRITIC_MAX_TEXT}`;
  return null;
}

function strayKeys(value: Record<string, unknown>, known: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !known.includes(key));
}

/**
 * The critic's reply, checked strictly: the last fenced block tagged
 * `critic`, holding JSON with exactly `scores`, `defects` and `notes`; a
 * whole score from 1 to 5 on each dimension; at most six defects and six
 * notes; each text one line of at most 300 characters; and every defect's
 * scene one of the brief's, by class or name, kept as the class.
 */
export function readCriticReply(text: string, scenes: readonly CriticScene[]): { ok: true; value: CriticVerdict } | { ok: false; problems: string[] } {
  const blocks = [...text.matchAll(/```critic[ \t]*\r?\n([\s\S]*?)```/g)];
  const body = blocks.at(-1)?.[1];
  if (body === undefined) return { ok: false, problems: ["there is no fenced block tagged critic"] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return { ok: false, problems: [`the critic block is not JSON: ${(error as Error).message}`] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, problems: ["the critic block is a JSON object"] };
  const reply = parsed as Record<string, unknown>;
  const problems: string[] = [];
  const stray = strayKeys(reply, ["scores", "defects", "notes"]);
  if (stray.length > 0) problems.push(`the reply has unknown fields: ${stray.join(", ")}`);

  const scores = {} as Record<CriticDimension, number>;
  const rawScores = reply.scores;
  if (typeof rawScores !== "object" || rawScores === null || Array.isArray(rawScores)) {
    problems.push(`scores is an object with a score for each of ${CRITIC_DIMENSIONS.join(", ")}`);
  } else {
    const given = rawScores as Record<string, unknown>;
    const strayScores = strayKeys(given, CRITIC_DIMENSIONS);
    if (strayScores.length > 0) problems.push(`scores has unknown fields: ${strayScores.join(", ")}`);
    for (const dimension of CRITIC_DIMENSIONS) {
      const score = given[dimension];
      if (!Number.isInteger(score) || (score as number) < CRITIC_SCORE_RANGE.min || (score as number) > CRITIC_SCORE_RANGE.max) {
        problems.push(`scores.${dimension} is a whole number from ${CRITIC_SCORE_RANGE.min} to ${CRITIC_SCORE_RANGE.max}`);
      } else {
        scores[dimension] = score as number;
      }
    }
  }

  const byName = new Map<string, string>();
  for (const scene of scenes) {
    byName.set(scene.class, scene.class);
    byName.set(scene.name, scene.class);
  }
  const defects: CriticDefect[] = [];
  if (!Array.isArray(reply.defects)) problems.push("defects is a list");
  else if (reply.defects.length > CRITIC_MAX_DEFECTS) problems.push(`defects has ${reply.defects.length} entries, over ${CRITIC_MAX_DEFECTS}`);
  else {
    reply.defects.forEach((entry: unknown, at) => {
      const field = `defects[${at}]`;
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return void problems.push(`${field} is an object with scene, problem and fix`);
      const defect = entry as Record<string, unknown>;
      const strayDefect = strayKeys(defect, ["scene", "problem", "fix"]);
      if (strayDefect.length > 0) problems.push(`${field} has unknown fields: ${strayDefect.join(", ")}`);
      const scene = typeof defect.scene === "string" ? byName.get(defect.scene) : undefined;
      if (scene === undefined) problems.push(`${field}.scene is one of the brief's scenes: ${scenes.map((entry) => entry.class).join(", ")}`);
      const problem = lineProblem(defect.problem, `${field}.problem`);
      const fix = lineProblem(defect.fix, `${field}.fix`);
      for (const found of [problem, fix]) if (found !== null) problems.push(found);
      if (scene !== undefined && problem === null && fix === null) defects.push({ scene, problem: (defect.problem as string).trim(), fix: (defect.fix as string).trim() });
    });
  }

  const notes: string[] = [];
  if (!Array.isArray(reply.notes)) problems.push("notes is a list");
  else if (reply.notes.length > CRITIC_MAX_NOTES) problems.push(`notes has ${reply.notes.length} entries, over ${CRITIC_MAX_NOTES}`);
  else {
    reply.notes.forEach((note: unknown, at) => {
      const found = lineProblem(note, `notes[${at}]`);
      if (found !== null) problems.push(found);
      else notes.push((note as string).trim());
    });
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, value: { scores, defects, notes } };
}

/* -------------------------------------------------------------------------- */
/* A run                                                                      */
/* -------------------------------------------------------------------------- */

export interface CriticInput {
  jobId: string;
  /** The run's directory name under `critic/`: `attempt-2`, `standalone-1`. */
  label: string;
  attempt: number | null;
  sources: readonly CriticSource[];
  /** The brief as the agent read it (`videoPromptFacing`). */
  brief: Record<string, unknown>;
  scenes: readonly CriticScene[];
  auth: AgentAuth;
  model: string;
  timeoutMs: number;
  /** Told of each call as it starts, so a cancel can stop it. */
  onCall?: (call: CriticCall | null) => void;
  /** Asked before the follow-up: a cancelled job spawns nothing more. */
  cancelled?: () => boolean;
}

/** Why a call gave nothing usable, or null when its reply is worth reading. */
function callFailure(outcome: CriticCallOutcome, timeoutMs: number): string | null {
  if (outcome.spawnFailed) return `the critic never started: ${outcome.stderr}`;
  if (outcome.stopReason === "sealed") return outcome.sealBroken ?? "the critic's seal did not hold";
  if (outcome.stopReason === "cancelled") return "stopped: the job was cancelled while the critic was reading";
  if (outcome.stopReason === "timeout") return `the critic did not answer within ${Math.round(timeoutMs / 1000)} s`;
  if (outcome.isError || outcome.exitCode !== 0) {
    return `the critic's request failed: ${outcome.text !== "" ? outcome.text.slice(0, 300) : outcome.stderr.slice(0, 300) || `exit ${outcome.exitCode ?? "unknown"}`}`;
  }
  return null;
}

/**
 * One picture check: copy the sheets, seal and spawn one call, read its
 * reply, and give an unusable one a single follow-up in the same session.
 * Never throws for anything the critic or its sheets did; the run's `error`
 * says what happened.
 */
export async function runCritic(input: CriticInput): Promise<CriticRun> {
  const startedAt = new Date().toISOString();
  const paths = criticPaths(input.jobId, input.label);
  await rm(paths.dir, { recursive: true, force: true });
  await mkdir(paths.tmp, { recursive: true });
  const { sheets, skipped } = await copyCriticSheets(input.sources, paths.sheets);
  if (sheets.length === 0) {
    return skippedRun(input.attempt, skipped.length === 0 ? "the job has no contact sheet to read" : "no contact sheet could be read safely", {
      startedAt,
      skipped,
    });
  }
  await writeFile(paths.system, `${criticSystemPrompt()}\n`, "utf8");
  await writeFile(paths.settings, `${JSON.stringify(criticSettings(input.jobId, paths, sheets), null, 1)}\n`, "utf8");

  const meter = new JobCostMeter(input.model);
  let resolvedModel: string | null = null;
  const sessionId = randomUUID();
  const run = async (prompt: string, resume: boolean): Promise<CriticCallOutcome> => {
    const call = startCall({
      argv: criticArgv({ paths, model: input.model, sessionId, resume }),
      prompt,
      paths,
      auth: input.auth,
      timeoutMs: input.timeoutMs,
      onLine: (line) => {
        meter.observe(line);
        void appendFile(paths.log, `${line}\n`, "utf8").catch(() => undefined);
      },
    });
    input.onCall?.(call);
    try {
      const outcome = await call.done;
      resolvedModel ??= outcome.init?.model ?? null;
      return outcome;
    } finally {
      input.onCall?.(null);
    }
  };

  const finish = (patch: Partial<CriticRun>, calls: number): CriticRun => {
    const cost = meter.read();
    return {
      attempt: input.attempt,
      standalone: input.attempt === null,
      startedAt,
      finishedAt: new Date().toISOString(),
      model: resolvedModel ?? input.model,
      costUsd: cost.usd,
      costSource: cost.source,
      scores: null,
      defects: [],
      notes: [],
      sheets,
      skipped,
      error: null,
      sentBack: false,
      calls,
      ...patch,
    };
  };

  const message = criticUserMessage({ brief: input.brief, sheets });
  const first = await run(message, false);
  const failed = callFailure(first, input.timeoutMs);
  if (failed !== null) return finish({ error: failed }, 1);
  const read = readCriticReply(first.text, input.scenes);
  if (read.ok) return finish(read.value, 1);
  if (input.cancelled?.() === true) return finish({ error: "stopped: the job was cancelled before the critic's reply could be asked again" }, 1);

  const second = await run(criticFollowUp(read.problems), true);
  const failedAgain = callFailure(second, input.timeoutMs);
  if (failedAgain !== null) return finish({ error: failedAgain }, 2);
  const reread = readCriticReply(second.text, input.scenes);
  if (reread.ok) return finish(reread.value, 2);
  return finish({ error: `the critic's reply could not be used, twice: ${reread.problems.slice(0, 4).join("; ")}` }, 2);
}

/* -------------------------------------------------------------------------- */
/* The view                                                                   */
/* -------------------------------------------------------------------------- */

export interface CriticView {
  /** The attempt the shown scores judged. */
  attempt: number;
  /** How many attempts the job ran. */
  attempts: number;
  scores: Record<CriticDimension, number>;
  defects: CriticDefect[];
  notes: string[];
  /** Defects of an earlier attempt that went back to the agent. */
  sentBack: CriticDefect[];
}

/**
 * What `GET /api/jobs/{id}` says about the critic: the latest run with
 * scores (a standalone run judges the job's last attempt), and the defects
 * an earlier attempt sent back. Null when no critic has scored this job.
 */
export function criticView(record: Pick<VideoJobRecord, "critic" | "attempt">): CriticView | null {
  const runs = record.critic ?? [];
  let latestAt = -1;
  runs.forEach((run, at) => {
    if (run.scores !== null) latestAt = at;
  });
  const latest = runs[latestAt];
  if (latest === undefined || latest.scores === null) return null;
  const attempt = latest.attempt ?? record.attempt;
  const sentBack = runs
    .slice(0, latestAt)
    .filter((run) => run.sentBack && run.attempt !== null && run.attempt < attempt)
    .flatMap((run) => run.defects.map((defect) => ({ ...defect })));
  return {
    attempt,
    attempts: Math.max(record.attempt, attempt),
    scores: { ...latest.scores },
    defects: latest.defects.map((defect) => ({ ...defect })),
    notes: [...latest.notes],
    sentBack,
  };
}

/** One run as the standalone route answers it: what it read and what it found. */
export function criticRunView(run: CriticRun): Record<string, unknown> {
  return {
    standalone: run.standalone,
    attempt: run.attempt,
    model: run.model,
    costUsd: run.costUsd,
    scores: run.scores,
    defects: run.defects,
    notes: run.notes,
    sheets: run.sheets.map((sheet) => ({ id: sheet.id, scenes: sheet.scenes })),
    skipped: run.skipped,
    error: run.error,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}
