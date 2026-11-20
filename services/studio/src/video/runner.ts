import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { JobState } from "@hermes/schema";

import { agentEnv, spawnClaude, type AgentInit, type AgentOutcome, type AgentRun } from "../agent/agent";
import {
  appendAttempt,
  callCounts,
  endAttempt,
  gateSummary,
  keepReview,
  renderSeconds,
  reviseNote,
  runFileFor,
  startAttempt,
  withAttemptCritic,
  withAttemptGate,
  type AttemptStart,
} from "../data/run-record";
import { jobClaim, jobEnqueue, jobFinish, jobShow, sessionEnd, sessionStart, videoCheckout, videoShow, type JobFinishInput } from "../data/catalog";
import { CatalogRows, leaseHolder, type RowsStatus } from "../data/catalog-rows";
import { agentAuth, dailyCapUsd, DAILY_WINDOW_MS, type AgentAuth } from "../config";
import { costFromLog, JobCostMeter, spendWindow, type CostReading, type SpendEntry } from "../cost";
import { jobDir } from "../paths";
import { sweepByMarker } from "../proc";
import { credentialNote, credentialRecord, JobRefused } from "../diagram/runner";
import { resolveSource } from "../diagram/source-note";
import type { RecordStore } from "../data/store";
import { readClaudeDefaults, readPreference, resolveAgentSettings } from "./agent-model";
import { isNarrated, type ValidVideoBrief } from "./brief";
import { briefTool, DEFAULT_VIDEO_TOOL, notInStudio, type VideoToolName } from "./tools";
import { backendFor, type BackendJob, type VideoBackend } from "./backend";
import { appendRead, editsOn, readCalls, readReads, ReadTracker, isToolResult, LineQueue, WrapperOutputTracker } from "./calls";
import {
  BASH_TIMEOUT_MS,
  VIDEO_MAX_ATTEMPTS,
  VIDEO_RUNNER_NAME,
  videoConcurrency,
  videoCriticMode,
  videoCriticModel,
  videoCriticTimeoutMs,
  videoHangMs,
  videoMaxTurns,
  type VideoCriticMode,
} from "./config";
import { safeCopy, safeRead } from "./copy";
import {
  criticSpend,
  keptCriticRuns,
  withCriticSpend,
  criticSummary,
  defectFinding,
  droppedCriticDirs,
  fallbackSheet,
  runCritic,
  skippedRun,
  type CriticCall,
  type CriticRun,
  type CriticSource,
} from "./critic";
import { videoPromptFacing } from "./prompt";
import { deadTools, deadToolsMessage, type DeadTools } from "./dead-tools";
import type { VideoDoctor, VideoDoctorReport } from "./doctor";
import { runVideoGate, type GateTools } from "./gate";
import { manualFile, writeManual } from "./manual";
import { videoCandidateRef, videoTarget, type VideoPaths } from "./paths";
import { writeGuard } from "./bash-guard";
import { releaseJobPorts } from "./ports";
import { deriveSteps } from "./steps";
import type { Toolchain } from "./toolchain";
import type { VideoGateResult, VideoJobRecord } from "./types";

/**
 * The video runner (D43 of docs/STUDIO-VIDEOS.md): a second runner in the
 * studio process, beside the diagram one. Its own queue, concurrency, timer,
 * settings, prompt and gate; the spawner, the login, the cost meter and the
 * daily cap are shared.
 *
 * It is the outer frame (D54): it spawns, streams progress, stops a job only
 * when it has truly hung, gates the finished video, and runs Accept and
 * Discard. Writing code, compiling, voicing and stitching are the agent's to
 * get right inside its own loop, as they are the owner's by hand.
 *
 * Nothing here is about one video tool: the checkout, the profiles, the
 * wrapper, the clips, the manual, the prompts, the gate's source steps, the
 * sheets and the doctor come from the brief's tool's backend (`backend.ts`,
 * D75 of docs/STUDIO-VIDEO-TOOLS.md).
 */

export type VideoStore = RecordStore<VideoJobRecord>;

interface Running {
  record: VideoJobRecord;
  agent: AgentRun | null;
  cancelled: boolean;
  meter: JobCostMeter;
  costWrittenAt: number;
  paths: VideoPaths | null;
  reads: ReadTracker;
  edits: number;
  gateRunning: boolean;
  /** The picture check's mode, read once when the job starts, so its step list keeps one shape. */
  criticMode: VideoCriticMode;
  /** The critic call running now, which a cancel stops. */
  critic: CriticCall | null;
  criticRunning: boolean;
  /** Set once a critic's defects went back to the agent: once per job. */
  criticRetrySpent: boolean;
  /** The passing build kept while the critic's retry runs, which a retry that does not pass falls back to. */
  keptBuild: { attempt: number; dir: string } | null;
  /** How many wrapper calls the narration log has said something about. */
  callsNarrated: number;
  /** The calls log's size when the backend last kept previewed sources, and how many calls it had seen. */
  callsKeptSize: number;
  callsKept: number;
  /** The stream's lines, handled in order; the gate waits for it. */
  lines: LineQueue;
  /** Set once the wrapper's log shows tools that cannot start (V26): the job ends as `toolchain`, with no gate and no retry. */
  deadTools: DeadTools | null;
  /** What the last wrapper call printed, for the job's events when that happens. */
  output: WrapperOutputTracker | null;
  /**
   * Whether this runner may write the catalog row's terminal state: once the
   * catalog handed the job over, or answered nothing (the degraded mode, D16).
   * Never before the claim, and never after a refusal, which means the row is
   * someone else's (Greptile on #201).
   */
  mayFinish: boolean;
  /** The catalog answered the claim and refused it: the row is someone else's, and stays `not-claimed` on the record however the attempt ends. */
  claimRefused: boolean;
}

export interface VideoParent {
  jobId: string;
  agentSessionId: string | null;
  changes: string | null;
  /** True when the parent is in review and the catalog discards it in the child's own transaction. */
  discard: boolean;
}

export interface VideoRunnerDeps {
  /** The default tool's doctor (manimkc's, D72), used for a brief with no `tool` too. */
  doctor: VideoDoctor;
  /** Each other tool's doctor (D75): a job of a tool with none here is refused, never run on another tool's verdict. */
  doctors?: Partial<Record<VideoToolName, VideoDoctor>>;
  /** Every other entry the daily cap counts: diagram jobs and planner turns. */
  otherSpend?: () => readonly SpendEntry[];
  /** The toolchain, discovered per job by its backend. A test passes its own. */
  toolchain?: () => Promise<Toolchain>;
  /** The gate's sandboxed operations, the backend's by default. A test passes recorded answers. */
  gateTools?: (input: BackendJob) => GateTools;
}

/** The owner's home, resolved: the profiles deny reads under it. */
function ownerHome(): string {
  try {
    return realpathSync(process.env.HOME ?? "/");
  } catch {
    return process.env.HOME ?? "/";
  }
}

/**
 * The video agent's argv: the diagram agent's seals, this job's permission
 * file, two `--add-dir`s (three with a source note), and the model and effort
 * resolved for the job. Exported for its test.
 */
export function videoAgentArgv(input: {
  paths: Pick<VideoPaths, "settings" | "lib" | "out">;
  /** The backend's `--add-dir`s; manimkc's, the lib copy and the renders, when left out. */
  addDirs?: readonly string[];
  prompt: string;
  sessionId: string;
  resume: boolean;
  manual: string | null;
  model: string | null;
  effort: string | null;
  source: string | undefined;
}): string[] {
  const { paths } = input;
  const maxTurns = videoMaxTurns();
  return [
    "-p",
    input.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    // The cost meter's output count (`keepsStreamEvent` in ../agent).
    "--include-partial-messages",
    "--settings",
    paths.settings,
    "--setting-sources",
    "",
    "--permission-prompts",
    "none",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    ...(input.addDirs ?? [paths.lib, paths.out]).flatMap((dir) => ["--add-dir", dir]),
    ...(input.source === undefined ? [] : ["--add-dir", path.dirname(input.source)]),
    ...(input.model === null ? [] : ["--model", input.model]),
    ...(input.effort === null ? [] : ["--effort", input.effort]),
    ...(maxTurns === null ? [] : ["--max-turns", String(maxTurns)]),
    ...(input.manual === null ? [] : ["--append-system-prompt-file", input.manual]),
    ...(input.resume ? ["--resume", input.sessionId] : ["--session-id", input.sessionId]),
  ];
}

export class VideoRunner {
  private readonly store: VideoStore;
  private readonly deps: VideoRunnerDeps;
  private readonly running = new Map<string, Running>();
  private readonly settledJobs = new Map<string, Promise<void>>();
  private readonly enqueuing = new Map<string, Promise<{ record: VideoJobRecord; created: boolean; jobsAhead: number }>>();
  /** Jobs whose `catalog job enqueue` has not answered, which `kick` passes over: the diagram runner's `unanswered` says why. */
  private readonly unanswered = new Set<string>();
  private draining = false;
  /** The catalog's job rows against this runner's records, as the diagram runner's `rows`. */
  readonly rows: CatalogRows<VideoJobRecord>;

  constructor(store: VideoStore, deps: VideoRunnerDeps) {
    this.store = store;
    this.deps = deps;
    this.rows = new CatalogRows<VideoJobRecord>({
      kind: "video",
      runnerName: VIDEO_RUNNER_NAME,
      store,
      busy: (id) => this.running.has(id) || this.unanswered.has(id),
      finishInput: (record, state) => this.finishInput(record, state),
    });
  }

  /** Every live video row whose record has finished, moved to the record's state (`CatalogRows`). Called at start after `reconcile`. */
  reconcileCatalog(): Promise<RowsStatus> {
    return this.rows.reconcile();
  }

  /** Resolves once every job running now, and every standalone picture check, has written its verdict. */
  async settledAll(): Promise<void> {
    await Promise.all([...new Set([...this.running.keys(), ...this.standaloneSettled.keys()])].map((id) => this.settled(id)));
  }

  /** Standalone picture checks running now (`criticRun`), which drain stops. */
  private readonly standaloneCritics = new Map<string, { call: CriticCall | null; cancelled: boolean }>();
  private readonly standaloneSettled = new Map<string, Promise<void>>();

  /** After the job's run and any standalone picture check of it have written everything. */
  settled(id: string): Promise<void> {
    return Promise.all([this.settledJobs.get(id), this.standaloneSettled.get(id)]).then(() => undefined);
  }

  get busy(): number {
    return this.running.size;
  }

  private async tools(backend: VideoBackend): Promise<Toolchain> {
    return this.deps.toolchain !== undefined ? this.deps.toolchain() : backend.toolchain();
  }

  /** The doctor that answers for a tool: the default tool's is `deps.doctor`, every other one's its own entry, or none. */
  doctorFor(tool: VideoToolName): VideoDoctor | undefined {
    return this.deps.doctors?.[tool] ?? (tool === DEFAULT_VIDEO_TOOL ? this.deps.doctor : undefined);
  }

  /** The doctor's answer for a tool, or a failing one naming the missing doctor. */
  private async doctorReport(tool: VideoToolName): Promise<VideoDoctorReport> {
    const doctor = this.doctorFor(tool);
    if (doctor !== undefined) return doctor.report();
    return {
      ok: false,
      sandbox: false,
      metal: false,
      kokoro: false,
      voices: [],
      checks: [{ name: "doctor", ok: false, detail: `this runner was started without a ${tool} doctor, so no ${tool} video can be checked or made` }],
      checkedAt: new Date().toISOString(),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Reconcile                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * At start: a job left `running` has no process behind it and becomes
   * `interrupted` (V1), after a sweep for anything still running out of its
   * workspace. A job left `awaiting_review` is asked about: if the runner
   * died between Accept's commit and its own write of `accepted`, the row
   * says so and the record adopts it ("The runner's side, and the retry").
   */
  async reconcile(): Promise<{ interrupted: string[]; adopted: string[] }> {
    const interrupted: string[] = [];
    const adopted: string[] = [];
    for (const record of this.store.list()) {
      if (record.state === "running") {
        await sweepByMarker(`${jobDir(record.id)}/`);
        const cost = await readFile(path.join(jobDir(record.id), "session.ndjson"), "utf8")
          .then((body) => costFromLog(body, record.agentModel?.passed ?? null))
          .catch(() => null);
        await this.store.update(record.id, {
          state: "interrupted",
          finishedAt: new Date().toISOString(),
          errorKind: "interrupted",
          error: "the runner died while this job was running",
          reconciled: true,
          ...(cost?.usd === undefined || cost.usd === null ? {} : { costUsd: cost.usd, costSource: cost.source }),
        });
        interrupted.push(record.id);
        const finished = await jobFinish({
          jobId: record.id,
          state: "interrupted",
          errorKind: "interrupted",
          error: "the runner died while this job was running",
          ...(await this.runFile(record.id)),
        });
        if (!finished.ok) await this.finishMissed(record.id, finished.error);
        if (record.sessionId !== null) await sessionEnd(record.sessionId, "interrupted");
      } else if (record.state === "awaiting_review") {
        const shown = await jobShow(record.id);
        const state = (shown.json as { job?: { state?: unknown } } | null)?.job?.state;
        if (shown.ok && state === "accepted") {
          await this.store.update(record.id, { state: "accepted", reviewedAt: new Date().toISOString(), indexed: true, reconciled: true });
          adopted.push(record.id);
        }
      }
    }
    return { interrupted, adopted };
  }

  /* ------------------------------------------------------------------ */
  /* The cap                                                            */
  /* ------------------------------------------------------------------ */

  spend(now: number = Date.now()): ReturnType<typeof spendWindow> {
    // A critic's cost is its own, never on the job's `cost_usd`, and counts here as its own entry.
    const records = this.store.list();
    return spendWindow([...records, ...criticSpend(records), ...(this.deps.otherSpend?.() ?? [])], DAILY_WINDOW_MS, now);
  }

  /** `STUDIO_DAILY_USD`, counting a video like any job (V14). Unset, the default, refuses nothing. */
  assertUnderCap(now: number = Date.now()): void {
    const cap = dailyCapUsd();
    if (cap === null) return;
    const window = this.spend(now);
    if (window.totalUsd < cap) return;
    throw new JobRefused(
      429,
      `the studio has spent $${window.totalUsd.toFixed(2)} in the last 24 hours, at or over the $${cap.toFixed(2)} ` +
        `STUDIO_DAILY_USD cap. Nothing was queued; the oldest counted job leaves the window at ${window.oldestAgesOutAt ?? "(unknown)"}.`,
      { reason: "daily-cap", totalUsd: window.totalUsd, capUsd: cap },
    );
  }

  /* ------------------------------------------------------------------ */
  /* Enqueue                                                            */
  /* ------------------------------------------------------------------ */

  /** Whether a studio video has this slug, and its revision: Accept's base. Undefined when the catalog cannot say. */
  async startingPoint(slug: string): Promise<{ exists: boolean | undefined; revision: number | null | undefined; tool?: VideoToolName }> {
    const shown = await videoShow(slug);
    const video = (shown.json as { video?: { revision?: unknown; brief?: unknown } | null } | null)?.video;
    if (!shown.ok || video === undefined) return { exists: undefined, revision: undefined };
    if (video === null) return { exists: false, revision: null };
    return { exists: true, revision: typeof video.revision === "number" ? video.revision : undefined, tool: briefTool(video.brief) };
  }

  /**
   * Every refusal made before anything is written: the video doctor (503,
   * V2 and V3), the voice, the lease, the mode against the catalog, and the
   * cap. `replacing` is a parent in review whose lease the child takes in
   * the catalog's one transaction (D52).
   */
  async admit(brief: ValidVideoBrief, replacing: string | null = null): Promise<{ revision: number | null | undefined }> {
    const unavailable = notInStudio(briefTool(brief));
    if (unavailable !== null) throw new JobRefused(409, `${unavailable}, so nothing was queued`, { tool: briefTool(brief) });
    // The brief's tool's own doctor (D75): one tool's verdict says nothing
    // about another's sandbox.
    const report = await this.doctorReport(briefTool(brief));
    if (!report.ok) {
      throw new JobRefused(
        503,
        briefTool(brief) === DEFAULT_VIDEO_TOOL
          ? "this machine cannot run a video job right now, so nothing was queued"
          : `this machine cannot run a ${briefTool(brief)} video job right now, so nothing was queued`,
        { doctor: report.checks.filter((check) => !check.ok), tool: briefTool(brief) },
      );
    }
    if (isNarrated(brief) && !report.voices.includes(brief.voice)) {
      throw new JobRefused(409, `the voice ${brief.voice} is not installed for kokoro, and the narration step never downloads one (V9)`, {
        installed: report.voices,
      });
    }
    const target = videoTarget(brief.slug);
    const holder = this.store.activeOn(target);
    if (holder !== undefined && holder.id !== replacing) {
      throw new JobRefused(409, `${target} is already held by job ${holder.id} (${holder.state}); accept or discard that one first`, {
        holder: holder.id,
        state: holder.state,
      });
    }
    const start = await this.startingPoint(brief.slug);
    if (brief.mode === "new" && start.exists === true) {
      throw new JobRefused(409, `a studio video called ${brief.slug} already exists, and this brief says mode "new": make it a change, or pick another slug`, {
        reason: "slug-taken",
        slug: brief.slug,
      });
    }
    if (brief.mode === "change" && start.exists === false && replacing === null) {
      throw new JobRefused(409, `there is no studio video called ${brief.slug} to change`);
    }
    // A change edits its parent's source, which only the parent's tool reads
    // (D74): the parent in review when there is one, else the stored video.
    if (brief.mode === "change") {
      const inReview = replacing === null ? undefined : this.store.get(replacing);
      const parentTool = inReview !== undefined ? briefTool(inReview.brief) : start.tool;
      if (parentTool !== undefined && parentTool !== briefTool(brief)) {
        throw new JobRefused(409, `${brief.slug} was made with ${parentTool}, and a change keeps its video's tool; this brief says ${briefTool(brief)}`, {
          tool: parentTool,
        });
      }
    }
    this.assertUnderCap();
    return { revision: start.revision };
  }

  async enqueue(
    brief: ValidVideoBrief,
    parent?: VideoParent,
    options: { draftId?: string | null } = {},
  ): Promise<{ record: VideoJobRecord; created: boolean; jobsAhead: number }> {
    const pending = this.enqueuing.get(brief.idempotencyKey);
    if (pending !== undefined) {
      const first = await pending;
      return { record: first.record, created: false, jobsAhead: this.queued().length };
    }
    const attempt = this.enqueueOnce(brief, parent, options);
    this.enqueuing.set(brief.idempotencyKey, attempt);
    try {
      return await attempt;
    } finally {
      this.enqueuing.delete(brief.idempotencyKey);
    }
  }

  private async enqueueOnce(
    brief: ValidVideoBrief,
    parent: VideoParent | undefined,
    options: { draftId?: string | null },
  ): Promise<{ record: VideoJobRecord; created: boolean; jobsAhead: number }> {
    const existing = this.store.byIdempotencyKey(brief.idempotencyKey);
    if (existing !== undefined) return { record: existing, created: false, jobsAhead: this.queued().length };

    const base = await this.admit(brief, parent?.discard === true ? parent.jobId : null);
    const id = randomUUID();
    const target = videoTarget(brief.slug);
    const record: VideoJobRecord = {
      id,
      kind: "video",
      state: "queued",
      phase: null,
      brief,
      targetPath: target,
      topic: brief.topic,
      slug: brief.slug,
      classes: [],
      attempt: 0,
      sessionId: null,
      agentSessionId: parent?.agentSessionId ?? null,
      parentJobId: parent?.jobId ?? null,
      draftId: options.draftId ?? null,
      changes: parent?.changes ?? null,
      idempotencyKey: brief.idempotencyKey,
      ...(base.revision === undefined ? {} : { targetRevisionBefore: base.revision }),
      sourceHashBefore: null,
      requestedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      reviewedAt: null,
      heartbeatAt: null,
      cancelRequestedAt: null,
      exitCode: null,
      turns: null,
      costUsd: null,
      costSource: null,
      steps: [],
      lineChanges: [],
      gate: null,
      errorKind: null,
      error: null,
      written: [],
      indexed: false,
      catalogErrors: [],
      attempts: [],
      review: null,
    };
    // Before `create`, which puts the record in the store before its write does.
    this.unanswered.add(id);
    try {
      await this.recordAndEnqueue(record, brief, parent, options);
      if (parent?.discard === true) {
        const previous = this.store.get(parent.jobId);
        if (previous !== undefined) {
          // `replacedBy` rides on the state change itself, so whoever follows
          // the parent (its draft) reads a replacement, not a verdict. Inside
          // the window, so the child cannot start reading the parent's
          // source and clips while this cleanup is still rewriting them.
          await this.store.update(parent.jobId, { state: "discarded", reviewedAt: new Date().toISOString(), replacedBy: id });
          await this.cleanup(previous, { candidate: true });
        }
      }
    } finally {
      this.unanswered.delete(id);
    }
    void this.kick();
    return { record, created: true, jobsAhead: Math.max(0, this.queued().length - 1) };
  }

  /** Write the record, then ask the catalog for its row: the window `unanswered` covers. */
  private async recordAndEnqueue(
    record: VideoJobRecord,
    brief: ValidVideoBrief,
    parent: VideoParent | undefined,
    options: { draftId?: string | null },
  ): Promise<void> {
    const { id, targetPath: target } = record;
    await mkdir(jobDir(id), { recursive: true });
    await this.store.create(record);
    const briefFile = path.join(jobDir(id), "brief.json");
    await writeFile(
      briefFile,
      `${JSON.stringify(
        {
          id,
          kind: "video",
          topic: brief.topic,
          target,
          candidate: videoCandidateRef(id, brief.slug),
          idempotencyKey: brief.idempotencyKey,
          ...(options.draftId === undefined || options.draftId === null ? {} : { draft: options.draftId }),
          ...(parent === undefined ? {} : { parentJob: parent.jobId }),
          brief,
        },
        null,
        1,
      )}\n`,
      "utf8",
    );
    const enqueue = (): ReturnType<typeof jobEnqueue> => jobEnqueue(briefFile, parent?.discard === true ? { discardParent: parent.jobId } : {});
    let enqueued = await enqueue();
    // A lease held by a job this runner already finished, whose row never
    // heard: moved, then tried once more (the diagram runner says why).
    const holder = enqueued.ok || enqueued.offline ? null : leaseHolder(enqueued.error);
    if (holder !== null && (await this.rows.release(holder))) enqueued = await enqueue();
    if (!enqueued.ok && (!enqueued.offline || parent?.discard === true)) {
      // A refusal is durable: the workspace goes. A discard-and-enqueue with
      // the catalog down is refused as well, since the parent's discard and
      // this job's lease are one transaction or nothing (D52).
      await rm(jobDir(id), { recursive: true, force: true });
      this.store.forget(id);
      if (parent?.discard === true && !enqueued.offline && leftReview(enqueued.error)) {
        // The parent's row lock was taken first by another change of it (a
        // Replace and a Revise pressed together) or by a verdict: a conflict
        // with that press, not a bad request.
        throw new JobRefused(
          409,
          `job ${parent.jobId} left review while this change was being queued: another change or a verdict reached it first, so nothing was queued`,
          { reason: "parent-left-review", parentJob: parent.jobId },
        );
      }
      throw new JobRefused(
        enqueued.offline ? 503 : enqueued.error?.includes("already held") === true ? 409 : 400,
        enqueued.error ?? "the catalog would not take this job",
      );
    }
    if (!enqueued.ok) await this.store.noteCatalogError(id, enqueued.error ?? "");
  }

  private queued(): VideoJobRecord[] {
    return this.store.list({ state: "queued" }).sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  }

  async kick(): Promise<void> {
    if (this.draining) return;
    while (this.running.size < videoConcurrency()) {
      // The oldest queued job whose tool has no job running: never two of one
      // tool at once, so a job of another tool can start past one waiting.
      const busy = new Set([...this.running.values()].map((entry) => briefTool(entry.record.brief)));
      const next = this.queued().find((record) => !this.running.has(record.id) && !this.unanswered.has(record.id) && !busy.has(briefTool(record.brief)));
      if (next === undefined) return;
      const entry: Running = {
        record: next,
        agent: null,
        cancelled: false,
        meter: new JobCostMeter(null),
        costWrittenAt: 0,
        paths: null,
        reads: new ReadTracker(),
        edits: 0,
        gateRunning: false,
        criticMode: videoCriticMode(),
        critic: null,
        criticRunning: false,
        criticRetrySpent: false,
        keptBuild: null,
        callsNarrated: 0,
        callsKeptSize: -1,
        callsKept: 0,
        lines: new LineQueue(),
        deadTools: null,
        output: null,
        mayFinish: false,
        claimRefused: false,
      };
      this.running.set(next.id, entry);
      let settle: () => void = () => undefined;
      this.settledJobs.set(next.id, new Promise<void>((resolve) => (settle = resolve)));
      void this.execute(entry)
        .catch(async (error: unknown) => {
          // A throw during the critic's retry still falls back to the build
          // that passed, through `finish`; only when that throws too does the
          // job fail as an internal error.
          if (entry.keptBuild !== null && !entry.cancelled && entry.mayFinish) {
            const thrown = { errorKind: "internal", error: `the video runner threw: ${(error as Error).message}` };
            const restored = await this.fallBack(entry, thrown).catch(() => false);
            const finished = restored && (await this.finish(entry, "awaiting_review", { outcome: null, cost: entry.meter.read() }).then(() => true, () => false));
            if (finished) return;
          }
          await this.store.update(next.id, {
            state: "failed",
            finishedAt: new Date().toISOString(),
            // A refused claim stays `not-claimed`, so the catalog reconcile leaves the holder's row alone too.
            errorKind: entry.claimRefused ? "not-claimed" : "internal",
            error: `the video runner threw: ${(error as Error).message}`,
          });
          // Before the claim the row is still this runner's queued one: owed to the reconcile, which claims and finishes it.
          if (!entry.mayFinish && !entry.claimRefused) this.rows.owe(`job ${next.id} failed before its claim, so its queued row still holds the lease`);
          if (entry.mayFinish) {
            const finished = await jobFinish({
              jobId: next.id,
              state: "failed",
              errorKind: "internal",
              error: (error as Error).message,
              ...(await this.runFile(next.id)),
            });
            if (!finished.ok) await this.finishMissed(next.id, finished.error);
          }
          const sessionId = this.store.get(next.id)?.sessionId ?? null;
          if (sessionId !== null) await sessionEnd(sessionId, "failed", (error as Error).message).catch(() => undefined);
        })
        .finally(() => {
          this.running.delete(next.id);
          releaseJobPorts(next.id);
          settle();
          void this.kick();
        });
    }
  }

  /* ------------------------------------------------------------------ */
  /* One job                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * The files a job starts from: its parent's saved source, else the
   * catalog's stored source; null for a new video. Which files are source is
   * the backend's to say, and a change keeps its parent's tool (D74).
   */
  private async startFrom(record: VideoJobRecord, backend: VideoBackend): Promise<Map<string, Buffer> | null> {
    const files = new Map<string, Buffer>();
    if (record.parentJobId !== null) {
      const parent = this.store.get(record.parentJobId);
      if (parent !== undefined) {
        const parentPaths = await backend.paths(parent.id, parent.slug);
        // A parent's saved source, or, for an interrupted one, the file it was editing.
        for (const dir of [parentPaths.source, parentPaths.topicDir]) {
          const names = await readdir(dir).catch(() => [] as string[]);
          for (const name of names) {
            if (!backend.sourcePattern.test(name)) continue;
            const body = await safeRead(path.join(dir, name), 4 * 2 ** 20).catch(() => null);
            if (body !== null) files.set(name, body);
          }
          if (files.size > 0) return files;
        }
      }
    }
    if (record.brief.mode !== "change") return null;
    // A change with no parent in this studio: the source the catalog stored.
    const scratch = await mkdtemp(path.join(tmpdir(), "studio-video-source-"));
    try {
      const checkout = await videoCheckout(record.slug, scratch);
      if (!checkout.ok) throw new Error(`the stored source of ${record.slug} could not be checked out: ${checkout.error ?? ""}`);
      for (const name of await readdir(scratch)) {
        if (!backend.sourcePattern.test(name)) continue;
        files.set(name, await readFile(path.join(scratch, name)));
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    if (files.size === 0) throw new Error(`the catalog holds no source for ${record.slug}`);
    return files;
  }

  private async execute(entry: Running): Promise<void> {
    const id = entry.record.id;
    const sessionId = `studio-${id}`;
    const inherited = entry.record.agentSessionId;
    let agentSessionId = inherited ?? randomUUID();
    let resumeFromParent = inherited !== null;

    let record = await this.store.update(id, {
      state: "running",
      phase: "setup",
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      sessionId,
      agentSessionId,
      attempt: 0,
    });
    await this.store.emit(id, { type: "phase", phase: "setup", note: "building the job's checkout", state: "running" });

    const opened = await sessionStart({ id: sessionId, title: record.brief.title, goal: record.brief.idea, agentSessionId });
    if (!opened.ok) await this.store.noteCatalogError(id, opened.error ?? "");
    const claimed = await jobClaim(id, VIDEO_RUNNER_NAME, sessionId);
    // Before any write that could throw, so the crash handler knows whose row it is.
    entry.claimRefused = !claimed.ok && !claimed.offline;
    if (!claimed.ok) {
      await this.store.noteCatalogError(id, claimed.error ?? "");
      if (!claimed.offline) {
        // The row is someone else's: another runner claimed it, or a person
        // cancelled it. The local record and the session are closed, and the
        // row is left alone, as the diagram runner's `abandon` does.
        const error = `${claimed.error ?? "the catalog would not hand this job over"}. Another runner holds this job, or it was cancelled before it was picked up, so no agent was started and nothing was spent.`;
        const updated = await this.store.update(id, { state: "failed", finishedAt: new Date().toISOString(), errorKind: "not-claimed", error });
        await this.store.emit(id, { type: "error", state: "failed", note: videoNote(updated) });
        await sessionEnd(sessionId, "failed", error);
        return;
      }
    }
    entry.mayFinish = true;

    /* The workspace, only on a machine the tool's doctor passes: never unsandboxed (V2, V3). */
    const report = await this.doctorReport(briefTool(record.brief));
    if (!report.ok) {
      throw new Error(`the video doctor fails, so nothing was rendered: ${report.checks.filter((check) => !check.ok).map((check) => check.detail).join("; ")}`);
    }
    // The tool's backend (D75): everything below that is about the tool goes through it.
    const backend = backendFor(briefTool(record.brief));
    const tools = await this.tools(backend);
    const problems = backend.problems(tools);
    if (problems.length > 0) throw new Error(problems.join("; "));
    const paths = await backend.paths(id, record.slug);
    entry.paths = paths;
    entry.output = new WrapperOutputTracker(paths.wrapper);
    const home = ownerHome();
    const brief = record.brief;
    const voice = isNarrated(brief) ? brief.voice : "none";
    const job: BackendJob = { tools, paths, home, voice };
    await backend.prepare(job);
    const startFiles = await this.startFrom(record, backend);
    const scaffolded = await backend.scaffold(job, brief, startFiles);
    // A resume continues work that may already be finished, so its source is
    // not required to change; a revise or a change is.
    const isResume = record.parentJobId !== null && record.changes === null && this.store.get(record.parentJobId)?.state === "interrupted";
    const sourceHashBefore = startFiles === null || isResume ? null : await backend.sourceHash(paths);
    record = await this.store.update(id, { classes: scaffolded.classes, sourceHashBefore });
    await this.store.emit(id, { type: "step", state: "running", note: `the topic is ready: ${scaffolded.classes.join(", ")}` });

    const listing = await backend.wrapper(job, { scenes: scaffolded.classes, narrated: isNarrated(brief) });
    const guard = await writeGuard(tools.node, paths);

    /* The clips it can have for free (D47). */
    let seededNote: string | undefined;
    if (isNarrated(brief)) {
      const says = brief.scenes.flatMap((scene) => scene.beats.map((beat) => beat.say));
      const seeded = await backend.seed(job, says, record.parentJobId === null ? null : { jobId: record.parentJobId, slug: record.slug });
      record = await this.store.update(id, { seeded: { wanted: seeded.wanted, seeded: seeded.seeded } });
      seededNote = `${seeded.seeded} of ${seeded.wanted} of the brief's lines are already voiced in this job's cache.`;
      await this.store.emit(id, { type: "step", state: "running", note: `narration: ${seeded.seeded} of ${seeded.wanted} lines already voiced` });
    }

    /* The source note, as material. */
    // Only a note the catalog answered for: a slug it does not know leaves
    // the agent working from the brief alone.
    const resolvedNote = brief.source === undefined ? null : await resolveSource(id, brief.source).catch(() => null);
    const sourceNote = resolvedNote === null || resolvedNote.concept === null ? undefined : path.resolve(resolvedNote.path);

    /* The manual and the settings. */
    let manualHash = this.inheritedManual(record, inherited !== null);
    // A manual taken from the parent keeps the parent's version, and none when the parent has none.
    let manualVersion: string | null = manualHash === null ? null : (this.store.get(record.parentJobId ?? "")?.manualVersion ?? null);
    if (manualHash === null || (await manualFile(manualHash)) === null) {
      const manualListing = listing ?? "(the listing could not be read; run the api command)";
      const written = await writeManual(backend.manual(paths.wrapper, manualListing, paths));
      manualHash = written.hash;
      manualVersion = backend.manualVersion(manualListing, paths);
    }
    await writeFile(
      paths.settings,
      `${JSON.stringify(backend.settings(job, { jobId: id, guard, ...(sourceNote === undefined ? {} : { source: sourceNote }) }), null, 1)}\n`,
      "utf8",
    );

    /* Model and effort (D53): resolved now, or the parent's when continuing its session. */
    const parent = record.parentJobId === null ? undefined : this.store.get(record.parentJobId);
    let agentModel = parent?.agentModel ?? null;
    let agentEffort = parent?.agentEffort ?? null;
    if (inherited === null || agentModel === null || agentEffort === null) {
      const resolved = await resolveAgentSettings(await readPreference("studioVideoAgent"), await readClaudeDefaults());
      /* A brief that names a model (a conversation's pick, D90) beats the panel. */
      const briefModel = record.brief.model ?? null;
      agentModel = briefModel === null ? resolved.model : { requested: briefModel, passed: briefModel, source: "brief" };
      agentEffort = resolved.effort;
    }
    const auth = agentAuth();
    record = await this.store.update(id, { agentAuth: auth, manualHash, manualVersion, agentModel, agentEffort });
    // No flag passed runs the CLI's own default under the seal, measured as
    // claude-opus-5 (D53); priced so until the stream names its model.
    entry.meter = new JobCostMeter(agentModel.passed ?? "claude-opus-5");
    await this.refreshSteps(entry, { setupDone: true });

    let gate: VideoGateResult | null = null;
    let findings: string[] = [];
    let outcome: AgentOutcome | null = null;
    let refused: AgentOutcome | null = null;
    let startedSession = false;

    for (let attempt = 1; attempt <= VIDEO_MAX_ATTEMPTS; attempt += 1) {
      if (entry.cancelled) break;
      record = await this.store.update(id, { attempt, phase: "scene-code", heartbeatAt: new Date().toISOString() });
      await this.store.emit(id, {
        type: "phase",
        phase: "scene-code",
        note: attempt === 1 ? "the agent is writing the scenes" : `attempt ${attempt}: fixing what the check found`,
        state: "running",
      });
      const resuming = resumeFromParent || startedSession;
      const prompt = backend.prompt(
        findings.length > 0
          ? { kind: "retry", findings, paths }
          : resumeFromParent
            ? record.changes !== null
              ? { kind: "revise", changes: record.changes, paths }
              : { kind: "resume", paths }
            : {
                kind: "first",
                brief,
                paths,
                classes: scaffolded.classes,
                ...(sourceNote === undefined ? {} : { source: sourceNote }),
                ...(seededNote === undefined ? {} : { seededNote }),
                change: startFiles !== null,
              },
      );
      startedSession = true;
      const sceneBefore = await backend.sourceHash(paths);
      let initNoted: Promise<void> = Promise.resolve();
      const begun = startAttempt(attempt, entry.meter.read().usd);
      const agent = this.spawn({
        id,
        paths,
        addDirs: backend.addDirs(paths),
        prompt,
        sessionId: agentSessionId,
        resume: resuming,
        auth,
        manual: (await manualFile(manualHash!)) ?? null,
        model: agentModel.passed,
        effort: agentEffort.passed,
        source: sourceNote,
        onLine: (line) => entry.lines.push(() => this.onAgentLine(entry, line)),
        onInit: (init) => {
          initNoted = (async () => {
            await this.store.update(id, {
              resolvedModel: init.model,
              apiKeySource: init.apiKeySource,
              ...((init.version ?? null) === null ? {} : { harnessVersion: init.version }),
            });
            await this.store.appendRaw(id, credentialRecord(auth, init.apiKeySource));
            await this.store.emit(id, { type: "step", state: "running", note: credentialNote(auth, init.apiKeySource) });
            await this.store.emit(id, { type: "step", state: "running", note: `the agent runs ${init.model ?? "a model it did not name"}` });
          })().catch(() => undefined);
        },
      });
      entry.agent = agent;
      outcome = await agent.done;
      entry.agent = null;
      // Every line's work, the last sheet Read's line in reads.ndjson
      // included, before anything below reads what those lines wrote.
      await entry.lines.settled();
      await initNoted;
      // Every attempt the agent ran is in the history, however it ended:
      // before the cancel and every other exit below.
      await this.recordAttempt(id, begun, outcome, entry.meter.read().usd);
      await this.refreshSteps(entry);
      if (entry.cancelled || outcome.stopReason === "cancelled") break;
      // Before every other reading of the outcome: a session this runner
      // stopped has no result and a signal for an exit, which the checks
      // below would take for a lost parent session or a refused request.
      entry.deadTools ??= deadTools(await readCalls(paths.calls));
      if (entry.deadTools !== null) {
        await this.stopForDeadTools(entry, entry.deadTools, outcome);
        return;
      }

      if (outcome.spawnFailed) {
        await this.finish(entry, "failed", { errorKind: "spawn", error: `the agent never started: ${outcome.stderr}`, outcome, cost: entry.meter.read() });
        return;
      }
      if (resumeFromParent && outcome.turns === null && outcome.exitCode !== 0) {
        // The parent's session is gone (V13): a fresh one, from the source
        // already copied in, with the whole brief.
        agentSessionId = randomUUID();
        resumeFromParent = false;
        startedSession = false;
        const written = await writeManual(backend.manual(paths.wrapper, listing ?? "", paths));
        manualHash = written.hash;
        manualVersion = backend.manualVersion(listing ?? "", paths);
        record = await this.store.update(id, { agentSessionId, manualHash, manualVersion });
        await this.store.emit(id, {
          type: "phase",
          note: "the earlier session could not be resumed, so the agent starts a fresh one from the source, without the earlier conversation",
          state: "running",
        });
        findings = [];
        continue;
      }
      if (outcome.isError && outcome.stopReason === null && (outcome.turns ?? 0) <= 1 && (await backend.sourceHash(paths)) === sceneBefore) {
        // The first request itself failed: a refused credential, a model this
        // account cannot use. A retry sends the same request again.
        refused = outcome;
        break;
      }
      if (outcome.stopReason === "idle-timeout") {
        await this.finish(entry, "failed", {
          errorKind: "timeout",
          error: `the agent said nothing and ran no command for ${Math.round(videoHangMs() / 60_000)} minutes, so the job was stopped as hung`,
          outcome,
          cost: entry.meter.read(),
        });
        return;
      }

      /* The gate. */
      entry.gateRunning = true;
      await this.store.update(id, { phase: "check" });
      await this.refreshSteps(entry);
      gate = await runVideoGate({
        brief,
        paths,
        classes: scaffolded.classes,
        startedAtMs: this.freshnessFrom(record),
        sourceHashBefore,
        calls: await readCalls(paths.calls),
        reads: await readReads(paths.reads),
        tools: this.deps.gateTools !== undefined ? this.deps.gateTools(job) : backend.gateTools(job),
        backend,
        onStep: (step) => void this.store.emit(id, { type: "step", state: "running", note: `check: ${step.name}: ${step.ok ? "passed" : "failed"}, ${step.detail}` }),
      });
      entry.gateRunning = false;
      record = await this.store.update(id, {
        gate,
        lineChanges: gate.script?.changes ?? record.lineChanges,
        attempts: withAttemptGate(this.store.get(id)?.attempts, attempt, gateSummary(gate)),
      });
      await this.refreshSteps(entry);
      findings = gate.findings;
      if (!gate.ok) continue;
      // A later attempt that passes replaces the build kept for a fallback.
      if (entry.keptBuild !== null) await this.dropKeptBuild(entry);
      // The picture check, after the gate passed (D116): its defects go back
      // to the agent as the next attempt's findings at most once per job, and
      // only with two attempts left after this one, so a gate failure the
      // retry causes can still be fixed.
      const sendBack = await this.pictureCheck(entry, {
        attempt,
        backend,
        paths,
        classes: scaffolded.classes,
        auth,
        mayRetry: !entry.criticRetrySpent && VIDEO_MAX_ATTEMPTS - attempt >= 2,
      });
      if (sendBack.length === 0 || entry.cancelled) break;
      findings = sendBack;
    }

    if (entry.cancelled) {
      await sweepByMarker(`${paths.job}/`);
      await this.finish(entry, "cancelled", { errorKind: "cancelled", error: "stopped on request", outcome, cost: entry.meter.read() });
      return;
    }
    if (refused !== null) {
      await this.finish(entry, "failed", {
        errorKind: "agent",
        error: refused.result ?? `the agent's session ended in an error before it did anything (${refused.subtype ?? "no result"})`,
        outcome: refused,
        cost: entry.meter.read(),
      });
      return;
    }
    if (gate !== null && gate.ok) {
      await this.finish(entry, "awaiting_review", { outcome, cost: entry.meter.read() });
      return;
    }
    await this.finish(entry, "failed", {
      errorKind: "gate",
      error: gate === null ? `the agent produced nothing the gate could look at (${outcome?.subtype ?? "no result"})` : gate.findings.join(" "),
      outcome,
      cost: entry.meter.read(),
    });
  }

  /**
   * The end of a job whose tools cannot start (V26, `dead-tools.ts`): failed
   * as `toolchain`, with no gate (there is nothing it could judge) and no
   * retry (the next attempt would meet the same tools), its cost what the
   * meter read, and the tool's doctor told so health shows it.
   */
  private async stopForDeadTools(entry: Running, verdict: DeadTools, outcome: AgentOutcome): Promise<void> {
    const id = entry.record.id;
    if (entry.paths !== null) await sweepByMarker(`${entry.paths.job}/`);
    const output = entry.output?.last ?? null;
    await this.store.update(id, { deadTools: { ...verdict, output } });
    if (output !== null) await this.store.emit(id, { type: "step", state: "running", note: `the last wrapper call printed:\n${output}` });
    const error = deadToolsMessage(verdict);
    await this.finish(entry, "failed", { errorKind: "toolchain", error, outcome, cost: entry.meter.read() });
    this.doctorFor(briefTool(entry.record.brief))?.noteToolchainStop({ jobId: id, at: new Date().toISOString(), detail: error });
  }

  /** A resume's source is its parent's work, so its age is measured from the parent's start. */
  private freshnessFrom(record: VideoJobRecord): number {
    const own = Date.parse(record.startedAt ?? record.requestedAt);
    if (record.parentJobId === null || record.changes !== null) return own;
    const parent = this.store.get(record.parentJobId);
    const start = parent === undefined ? NaN : Date.parse(parent.startedAt ?? parent.requestedAt);
    return Number.isFinite(start) ? Math.min(own, start) : own;
  }

  private inheritedManual(record: VideoJobRecord, continuesParent: boolean): string | null {
    if (!continuesParent || record.parentJobId === null) return null;
    return this.store.get(record.parentJobId)?.manualHash ?? null;
  }

  /**
   * One attempt of the agent: the diagram agent's seals, this job's
   * permission file, the topic folder as its working directory and two
   * `--add-dir`s, and the model and effort resolved for the job.
   */
  private spawn(input: {
    id: string;
    paths: VideoPaths;
    addDirs: readonly string[];
    prompt: string;
    sessionId: string;
    resume: boolean;
    auth: AgentAuth;
    manual: string | null;
    model: string | null;
    effort: string | null;
    source: string | undefined;
    onLine: (line: string) => void;
    onInit: (init: AgentInit) => void;
  }): AgentRun {
    const { paths } = input;
    const argv = videoAgentArgv(input);
    const env = agentEnv(process.env, input.auth, paths.tmp);
    // An uncached preview of a whole video took up to 131 seconds (measured),
    // past the Bash tool's two-minute default; the tool's own ceiling instead.
    env.BASH_DEFAULT_TIMEOUT_MS = String(BASH_TIMEOUT_MS);
    env.BASH_MAX_TIMEOUT_MS = String(BASH_TIMEOUT_MS);
    const hangMs = videoHangMs();
    return spawnClaude(argv, {
      cwd: paths.topicDir,
      env,
      watch: {
        onLine: input.onLine,
        onInit: input.onInit,
        attemptMs: null,
        idleMs: hangMs,
        // Only the agent's own doing counts: a wrapper call that ended inside
        // the hang window. Files under render/ do not, because a scene
        // writes them, and a scene touching a file forever kept a hung
        // session alive forever (the review of #201).
        stillWorking: () => stillWorking(paths, hangMs),
      },
    });
  }

  private async onAgentLine(entry: Running, line: string): Promise<void> {
    const id = entry.record.id;
    entry.meter.observe(line);
    await this.store.appendRaw(id, line);
    const paths = entry.paths;
    if (paths !== null) {
      const backend = backendFor(briefTool(entry.record.brief));
      for (const file of entry.reads.observe(line)) {
        if (!backend.isSheet(paths, file)) continue;
        await appendRead(paths.reads, { path: file, at: new Date().toISOString() });
        await this.store.emit(id, { type: "step", state: "running", note: `read the sheet ${path.basename(file, ".sheet.png")}` });
      }
      if (editsOn(line).includes(paths.sceneFile)) entry.edits += 1;
      entry.output?.observe(line);
      if (isToolResult(line) || editsOn(line).length > 0) await this.refreshSteps(entry);
      // A wrapper call has just ended: if the log now shows tools that cannot
      // start (V26), stop the session now rather than let it retry them.
      if (isToolResult(line) && entry.deadTools === null && !entry.cancelled) {
        const verdict = deadTools(await readCalls(paths.calls));
        if (verdict !== null) {
          entry.deadTools = verdict;
          await this.store.emit(id, { type: "phase", note: "stopping: the video tools die as they start on this machine, which no change to the scenes can fix", state: "running" });
          await entry.agent?.stop("dead-tools");
        }
      }
      // A wrapper call has just ended: let the backend keep the source its
      // look rendered from, which the gate's step 10 compares scene by scene.
      // Only when the log has grown, so a result that ran no wrapper call
      // costs one stat, and only the calls it has not shown the backend yet.
      if (isToolResult(line) && backend.keepPreviewed !== undefined) {
        const size = (await lstat(paths.calls).catch(() => null))?.size ?? 0;
        if (size !== entry.callsKeptSize) {
          entry.callsKeptSize = size;
          const calls = await readCalls(paths.calls);
          const fresh = calls.slice(entry.callsKept);
          entry.callsKept = calls.length;
          await backend.keepPreviewed(paths, fresh).catch(() => undefined);
        }
      }
    }
    const now = Date.now();
    if (now - entry.costWrittenAt >= 2_000) {
      const cost = entry.meter.read();
      if (cost.usd !== null) {
        entry.costWrittenAt = now;
        await this.store.update(id, { costUsd: cost.usd, costSource: cost.source, heartbeatAt: new Date().toISOString() });
      }
    }
  }

  /** The job view's steps, from the wrapper's log, the stream and the gate. */
  private async refreshSteps(entry: Running, extra: { setupDone?: boolean } = {}): Promise<void> {
    const paths = entry.paths;
    const record = this.store.get(entry.record.id);
    if (paths === null || record === undefined) return;
    const backend = backendFor(briefTool(record.brief));
    const calls = await readCalls(paths.calls);
    const steps = deriveSteps({
      narrated: isNarrated(record.brief),
      seeded: record.seeded ?? null,
      setupDone: extra.setupDone ?? record.classes.length > 0,
      edits: entry.edits,
      calls,
      reads: await readReads(paths.reads),
      sheets: Object.fromEntries(record.classes.map((scene) => [scene, backend.sheet(paths, scene)])),
      gate: record.gate,
      gateRunning: entry.gateRunning,
      ready: record.state === "awaiting_review",
      agentRunning: entry.agent !== null,
      critic:
        entry.criticMode === "off"
          ? null
          : {
              running: entry.criticRunning,
              runs: (record.critic ?? []).filter((run) => !run.standalone).length,
              note: entry.criticRunning ? "reading the contact sheets" : criticStepNote(record.critic?.at(-1)),
            },
    });
    const running = steps.find((step) => step.state === "running");
    await this.store.update(record.id, { steps, ...(running === undefined ? {} : { phase: running.name }) });
    // One line in the narration log per wrapper call, once (D24).
    for (const call of calls.slice(entry.callsNarrated)) {
      await this.store.emit(record.id, { type: "step", state: "running", note: narrateCall(call) });
    }
    entry.callsNarrated = Math.max(entry.callsNarrated, calls.length);
  }

  private async finish(
    entry: Running,
    state: "awaiting_review" | "failed" | "cancelled",
    patch: { errorKind?: string; error?: string; outcome: AgentOutcome | null; cost: CostReading },
  ): Promise<void> {
    const id = entry.record.id;
    // The critic's retry did not pass: the job goes to review with the build
    // that did, never to failed (D116). A cancel is the person's, and never does.
    if (state === "failed" && entry.keptBuild !== null && !entry.cancelled && (await this.fallBack(entry, patch))) {
      state = "awaiting_review";
      patch = { outcome: patch.outcome, cost: patch.cost };
    }
    const record = await this.store.update(id, {
      state,
      phase: state === "awaiting_review" ? "ready" : (this.store.get(id)?.phase ?? null),
      finishedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      exitCode: patch.outcome?.exitCode ?? null,
      turns: patch.outcome?.turns ?? null,
      costUsd: patch.cost.usd,
      costSource: patch.cost.source,
      errorKind: patch.errorKind ?? null,
      error: patch.error ?? null,
    });
    await this.refreshSteps(entry);
    // The source is kept at every verdict: it is what a revise or a change starts from.
    if (entry.paths !== null) await keepSource(record, backendFor(briefTool(record.brief)), entry.paths);
    await this.store.emit(id, {
      type: state === "awaiting_review" ? "done" : "error",
      state,
      note: videoNote(this.store.get(id) ?? record),
    });
    const finished = await jobFinish(await this.finishInput(record, state));
    if (!finished.ok) await this.finishMissed(id, finished.error);
    if (record.sessionId !== null) {
      await sessionEnd(record.sessionId, state === "awaiting_review" ? "closed" : state === "cancelled" ? "cancelled" : "failed", record.error ?? undefined);
    }
  }

  /**
   * The `job finish` for a record, in `state`: what `finish` sends, and what
   * the catalog reconcile sends for a record whose finish never landed.
   * Writes `gate.json`, which the catalog reads the gate from.
   */
  private async finishInput(record: VideoJobRecord, state: JobState): Promise<JobFinishInput> {
    const id = record.id;
    const gateFile = path.join(jobDir(id), "gate.json");
    if (record.gate !== null) await writeFile(gateFile, `${JSON.stringify(record.gate, null, 1)}\n`, "utf8");
    return {
      jobId: id,
      state,
      ...(record.phase === null ? {} : { phase: record.phase }),
      candidatePath: videoCandidateRef(id, record.slug),
      ...(record.gate === null ? {} : { gateFile }),
      exitCode: record.exitCode,
      turns: record.turns,
      costUsd: record.costUsd,
      ...(record.costSource === null ? {} : { costSource: record.costSource }),
      ...(record.errorKind === null ? {} : { errorKind: record.errorKind }),
      ...(record.error === null ? {} : { error: record.error }),
      ...(await this.runFile(id)),
    };
  }

  /** A `job finish` that did not land: noted on the record and owed to the catalog reconcile (the diagram runner's `finishMissed`). */
  private async finishMissed(id: string, error: string | null): Promise<void> {
    await this.store.noteCatalogError(id, error ?? "");
    this.rows.owe(`job finish for ${id} did not land: ${error ?? "the catalog refused"}`);
  }

  /** One attempt into the record's history, as it ended: its gate is filled in once the gate has judged it. */
  private async recordAttempt(id: string, begun: AttemptStart, outcome: AgentOutcome | null, usdAfter: number | null): Promise<void> {
    const attempt = endAttempt(begun, outcome, usdAfter);
    await this.store.update(id, { attempts: appendAttempt(this.store.get(id)?.attempts, attempt) });
  }

  /**
   * The `--run-file` for this job's `job finish`, from its record and its
   * wrapper's log (`calls.ndjson` in the job directory for every backend,
   * `videoPaths`): the calls by verb and the seconds spent rendering.
   */
  private async runFile(id: string): Promise<{ runFile?: string }> {
    const calls = await readCalls(path.join(jobDir(id), "calls.ndjson"));
    return runFileFor(this.store, id, { calls: callCounts(calls), renderSeconds: renderSeconds(calls) });
  }

  /* ------------------------------------------------------------------ */
  /* Cancel, revise, resume                                             */
  /* ------------------------------------------------------------------ */

  async cancel(id: string): Promise<VideoJobRecord> {
    const record = this.store.get(id);
    if (record === undefined) throw new JobRefused(404, `no job ${id}`);
    // As in the diagram runner: its row may not exist yet.
    if (this.unanswered.has(id)) throw new JobRefused(409, `job ${id} is still being queued, so it cannot be cancelled yet: try again in a moment`);
    if (record.state === "queued") {
      const updated = await this.store.update(id, {
        state: "cancelled",
        cancelRequestedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        errorKind: "cancelled",
        error: "cancelled before it started",
      });
      const finished = await jobFinish({
        jobId: id,
        state: "cancelled",
        errorKind: "cancelled",
        error: "cancelled before it started",
        ...(await this.runFile(id)),
      });
      if (!finished.ok) await this.finishMissed(id, finished.error);
      return updated;
    }
    if (record.state !== "running") throw new JobRefused(409, `job ${id} is ${record.state}, so there is nothing to cancel`);
    const updated = await this.store.update(id, { cancelRequestedAt: new Date().toISOString() });
    await this.store.emit(id, { type: "phase", note: "stopping: the agent and every render it started are being stopped", state: "running" });
    const entry = this.running.get(id);
    if (entry !== undefined) {
      entry.cancelled = true;
      await entry.agent?.stop("cancelled");
      await entry.critic?.stop("cancelled");
    }
    return updated;
  }

  /**
   * A picture-only change (D52): a new job continuing the parent's session
   * with the change as text, starting from the parent's source. From review,
   * the parent is discarded in the child's own catalog transaction; from a
   * terminal state, it simply is the parent.
   */
  async revise(record: VideoJobRecord, changes: string, draftId: string | null = null): Promise<VideoJobRecord> {
    const fromReview = record.state === "awaiting_review";
    if (!fromReview && !["accepted", "failed", "cancelled", "discarded", "interrupted"].includes(record.state)) {
      throw new JobRefused(409, `job ${record.id} is ${record.state}; a change is asked of a video in review or finished`);
    }
    const exists = (await this.startingPoint(record.slug)).exists;
    const { record: next } = await this.enqueue(
      {
        ...record.brief,
        mode: exists === true ? "change" : record.brief.mode,
        idempotencyKey: `${record.idempotencyKey}:revise:${Date.now()}`,
      },
      { jobId: record.id, agentSessionId: record.agentSessionId, changes, discard: fromReview },
      { draftId },
    );
    // A video in review sent back for changes: the parent's review says what
    // the person wanted different. After the child is queued, and never in
    // its way: a review that does not land is a catalog error on the parent.
    if (fromReview) await keepReview(this.store, record.id, "revise", { tags: [], note: reviseNote(changes) });
    return next;
  }

  /** Continue a job the runner died under, from what it had saved. */
  async resume(record: VideoJobRecord, draftId: string | null = null): Promise<VideoJobRecord> {
    if (record.state !== "interrupted") {
      throw new JobRefused(409, `job ${record.id} is ${record.state}, and resume is for a job the runner died under`);
    }
    const exists = (await this.startingPoint(record.slug)).exists;
    const { record: next } = await this.enqueue(
      {
        ...record.brief,
        mode: exists === true ? "change" : record.brief.mode,
        idempotencyKey: `${record.idempotencyKey}:resume:${record.finishedAt ?? record.id}`,
      },
      { jobId: record.id, agentSessionId: record.agentSessionId, changes: null, discard: false },
      { draftId },
    );
    return next;
  }

  /**
   * After a verdict (D52): keep the source, the sheets, the records and the
   * clips of the lines the final source voices, and delete the rest of
   * `render/`. On a discard, `candidate/` goes too.
   */
  async cleanup(record: VideoJobRecord, options: { candidate: boolean }): Promise<void> {
    const backend = backendFor(briefTool(record.brief));
    const paths = await backend.paths(record.id, record.slug);
    await keepSource(record, backend, paths);
    const sheets = path.join(paths.job, "sheets");
    await mkdir(sheets, { recursive: true });
    // After a fallback the render's sheets are the failed retry's: the
    // critic's own copies of the restored attempt are kept instead.
    const fallenBack = (record.fallback ?? null) !== null;
    for (const sheet of backend.sheets(paths, record.classes)) {
      const from = fallenBack ? fallbackSheet(record, sheet.id) : sheet.file;
      if (from !== undefined) await safeCopy(from, path.join(sheets, sheet.kept)).catch(() => undefined);
    }
    if (isNarrated(record.brief) && (await lstat(paths.renderProfile).catch(() => null)) !== null) {
      const tools = await this.tools(backend).catch(() => null);
      if (tools !== null) await backend.keepClips({ tools, paths, home: ownerHome(), voice: record.brief.voice });
    }
    await rm(paths.render, { recursive: true, force: true });
    if (options.candidate) await rm(paths.candidate, { recursive: true, force: true });
  }

  async drain(): Promise<void> {
    this.draining = true;
    for (const entry of this.running.values()) {
      entry.cancelled = true;
      await entry.agent?.stop("cancelled");
      await entry.critic?.stop("cancelled");
    }
    for (const standalone of this.standaloneCritics.values()) {
      standalone.cancelled = true;
      await standalone.call?.stop("cancelled");
    }
  }

  /* ------------------------------------------------------------------ */
  /* The picture check                                                  */
  /* ------------------------------------------------------------------ */

  /** Why the cap stops a critic call now, or null when it does not. */
  private criticCapReason(): string | null {
    const cap = dailyCapUsd();
    if (cap === null) return null;
    const window = this.spend();
    if (window.totalUsd < cap) return null;
    return `the studio has spent $${window.totalUsd.toFixed(2)} in the last 24 hours, at or over the $${cap.toFixed(2)} STUDIO_DAILY_USD cap, so no critic was run`;
  }

  /**
   * One run onto the job's record: the whole text in `critic`, the last
   * `CRITIC_RUNS_KEPT` kept, and, for an attempt's run that spawned, its
   * summary on that attempt for the run record (null when it gave no scores).
   */
  private async keepCriticRun(id: string, run: CriticRun): Promise<VideoJobRecord> {
    const current = this.store.get(id);
    const runs = keptCriticRuns(current?.critic ?? [], run);
    const spend = withCriticSpend(current ?? {}, run, DAILY_WINDOW_MS);
    const attempts = run.attempt !== null && run.calls > 0 ? withAttemptCritic(current?.attempts, run.attempt, criticSummary(run)) : current?.attempts;
    const updated = await this.store.update(id, { critic: runs, criticSpend: spend, ...(attempts === undefined ? {} : { attempts }) });
    // The copies of the standalone runs the trim dropped go too, after the
    // record no longer names them; every attempt's files and the spend list stay.
    for (const dir of droppedCriticDirs(id, [...(current?.critic ?? []), run], runs)) await rm(dir, { recursive: true, force: true });
    return updated;
  }

  /** The sheets a critic reads for a job: each from where it is now, the kept copy first. */
  private async criticSources(record: VideoJobRecord, backend: VideoBackend, paths: VideoPaths, keptFirst: boolean): Promise<CriticSource[]> {
    const sources: CriticSource[] = [];
    for (const sheet of backend.sheets(paths, record.classes)) {
      const kept = path.join(paths.job, "sheets", sheet.kept);
      // After a fallback the render's sheets are the failed retry's: the
      // critic's own copy of the restored attempt's is the build in review.
      const restored = fallbackSheet(record, sheet.id);
      const candidates = [...(restored === undefined ? [] : [restored]), ...(keptFirst ? [kept, sheet.file] : [sheet.file])];
      for (const from of candidates) {
        // Only whether something is there: the copy is what checks what it is.
        if ((await lstat(from).catch(() => null)) === null) continue;
        sources.push({ id: sheet.id, title: sheet.title, scenes: sheet.scenes, from });
        break;
      }
    }
    return sources;
  }

  /**
   * The picture check of one attempt whose build passed the gate (D116):
   * scores on the attempt, the whole text on the record, and, when this job
   * may still send one back, the defects as the next attempt's findings.
   * Empty when nothing goes back. A critic that cannot run, or gives no
   * usable answer, changes nothing about the job.
   */
  private async pictureCheck(
    entry: Running,
    input: { attempt: number; backend: VideoBackend; paths: VideoPaths; classes: string[]; auth: AgentAuth; mayRetry: boolean },
  ): Promise<string[]> {
    if (entry.criticMode === "off" || entry.cancelled) return [];
    const id = entry.record.id;
    const record = this.store.get(id) ?? entry.record;
    const capped = this.criticCapReason();
    if (capped !== null) {
      await this.keepCriticRun(id, skippedRun(input.attempt, capped));
      await this.store.emit(id, { type: "step", state: "running", note: `picture check: skipped, ${capped}` });
      await this.refreshSteps(entry);
      return [];
    }
    entry.criticRunning = true;
    await this.store.update(id, { phase: "critic", heartbeatAt: new Date().toISOString() });
    await this.refreshSteps(entry);
    await this.store.emit(id, { type: "phase", phase: "critic", note: "picture check: a critic is reading the contact sheets", state: "running" });
    let run: CriticRun;
    try {
      run = await runCritic({
        jobId: id,
        label: `attempt-${input.attempt}`,
        attempt: input.attempt,
        sources: await this.criticSources(record, input.backend, input.paths, false),
        brief: videoPromptFacing(record.brief, input.classes),
        scenes: input.classes.map((scene, at) => ({ class: scene, name: record.brief.scenes[at]?.name ?? scene })),
        auth: input.auth,
        model: videoCriticModel(),
        timeoutMs: videoCriticTimeoutMs(),
        onCall: (call) => {
          entry.critic = call;
          // A cancel that landed between two calls stops the next as it starts.
          if (call !== null && entry.cancelled) void call.stop("cancelled");
        },
        cancelled: () => entry.cancelled,
      });
    } catch (error) {
      // Our own filesystem failing under the copy: still not the job's failure.
      run = skippedRun(input.attempt, `the picture check could not be set up: ${(error as Error).message}`);
    } finally {
      entry.critic = null;
      entry.criticRunning = false;
    }
    // Only `retry` sends anything back, and it keys on defects the critic can
    // point to. The pass mark (`passesCritic`, D121) reads scores and has no
    // part in this: a video can pass with defects and fail with none.
    let sendBack = entry.criticMode === "retry" && input.mayRetry && !entry.cancelled && run.scores !== null && run.defects.length > 0;
    // Nothing goes back unless this passing build is kept first: a retry
    // that does not pass falls back to it, so the scores never block (D116).
    if (sendBack) sendBack = await this.keepPassedBuild(entry, input.attempt, input.paths);
    run.sentBack = sendBack;
    await this.keepCriticRun(id, run);
    await this.refreshSteps(entry);
    await this.store.emit(id, { type: "step", state: "running", note: `picture check: ${criticStepNote(run) ?? "done"}` });
    if (!sendBack) return [];
    entry.criticRetrySpent = true;
    return run.defects.map(defectFinding);
  }

  /**
   * Keep this attempt's passing build before its defects go back: the gate's
   * copies (`candidate/`, the video, sidecars, poster, `copies.json` and
   * `source/`) renamed whole to `candidate.passed/` inside the job, which the
   * next gate's step 5 would otherwise delete, and the gate result and line
   * changes on the record. False, and nothing is sent back, when it cannot.
   */
  private async keepPassedBuild(entry: Running, attempt: number, paths: VideoPaths): Promise<boolean> {
    const id = entry.record.id;
    const dir = path.join(paths.job, "candidate.passed");
    const record = this.store.get(id);
    if (record === undefined || record.gate === null || !record.gate.ok) return false;
    try {
      await rm(dir, { recursive: true, force: true });
      await rename(paths.candidate, dir);
    } catch (error) {
      await this.store.emit(id, { type: "step", state: "running", note: `picture check: the passing build could not be kept (${(error as Error).message}), so nothing was sent back` });
      return false;
    }
    entry.keptBuild = { attempt, dir };
    await this.store.update(id, { passedBuild: { attempt, gate: record.gate, lineChanges: record.lineChanges, at: new Date().toISOString() } });
    return true;
  }

  /** A later attempt passed the gate: the kept build is not needed. */
  private async dropKeptBuild(entry: Running): Promise<void> {
    const kept = entry.keptBuild;
    entry.keptBuild = null;
    if (kept !== null) await rm(kept.dir, { recursive: true, force: true });
    await this.store.update(entry.record.id, { passedBuild: null });
  }

  /**
   * The critic's retry ended without passing the gate: the kept build goes
   * back as `candidate/`, the record's gate and line changes become that
   * attempt's (with a warning saying what happened), and the retry's own
   * error is kept under `fallback`. False when the build cannot be restored,
   * and the job then fails as it would have.
   */
  private async fallBack(entry: Running, patch: { errorKind?: string; error?: string }): Promise<boolean> {
    const kept = entry.keptBuild;
    const paths = entry.paths;
    const id = entry.record.id;
    const passed = this.store.get(id)?.passedBuild ?? null;
    if (kept === null || paths === null || passed === null) return false;
    try {
      await rm(paths.candidate, { recursive: true, force: true });
      await rename(kept.dir, paths.candidate);
    } catch (error) {
      await this.store.emit(id, { type: "step", state: "running", note: `the earlier build could not be restored (${(error as Error).message})` });
      return false;
    }
    entry.keptBuild = null;
    await this.store.update(id, {
      gate: { ...passed.gate, warnings: [...passed.gate.warnings, FALLBACK_WARNING] },
      lineChanges: passed.lineChanges,
      passedBuild: null,
      fallback: { attempt: kept.attempt, retryErrorKind: patch.errorKind ?? null, retryError: patch.error ?? null, at: new Date().toISOString() },
    });
    await this.store.emit(id, {
      type: "step",
      state: "running",
      note: `the retry after the picture check did not pass (${patch.error ?? patch.errorKind ?? "no reason recorded"}), so attempt ${kept.attempt}'s build goes to review`,
    });
    return true;
  }

  /** Whether a standalone critic is running on this job now. */
  criticRunning(id: string): boolean {
    return this.standaloneCritics.has(id);
  }

  /**
   * `POST /api/jobs/{id}/critic`: a picture check of a job already made,
   * from its kept sheets (`jobs/<id>/sheets/`, written at its verdict) or,
   * in review, from its render's, copied first either way. It retries
   * nothing; the run lands on the job record as a standalone one. Refused
   * with 503 when the critic is off, 409 for a job in any other state, one
   * with no sheet or one already being checked, and 429 under the cap.
   */
  async criticRun(id: string): Promise<CriticRun> {
    if (videoCriticMode() === "off") throw new JobRefused(503, "the picture check is off (STUDIO_VIDEO_CRITIC=off), so no critic was run");
    const record = this.store.get(id);
    if (record === undefined) throw new JobRefused(404, `no job ${id}`);
    if (!["awaiting_review", "accepted", "discarded"].includes(record.state)) {
      throw new JobRefused(409, `job ${id} is ${record.state}; a picture check is run on a video in review, accepted or discarded`);
    }
    if (this.draining) throw new JobRefused(503, "the runner is shutting down, so no critic was run");
    if (this.standaloneCritics.has(id)) throw new JobRefused(409, `a picture check of job ${id} is already running`);
    // Reserved before the first await, so a second press refuses here rather
    // than starting a second paid call; released on every way out below.
    const holder: { call: CriticCall | null; cancelled: boolean } = { call: null, cancelled: false };
    this.standaloneCritics.set(id, holder);
    const release = (): void => {
      if (this.standaloneCritics.get(id) === holder) this.standaloneCritics.delete(id);
    };
    let sources: CriticSource[];
    try {
      const backend = backendFor(briefTool(record.brief));
      const paths = await backend.paths(record.id, record.slug);
      sources = await this.criticSources(record, backend, paths, true);
      if (sources.length === 0) throw new JobRefused(409, `job ${id} has no contact sheet left to read`, { reason: "no-sheets" });
      const capped = this.criticCapReason();
      if (capped !== null) throw new JobRefused(429, capped, { reason: "daily-cap" });
    } catch (error) {
      release();
      throw error;
    }
    const label = `standalone-${(record.critic ?? []).filter((run) => run.standalone).length + 1}-${Date.now()}`;
    const done = (async () => {
      let run: CriticRun;
      try {
        if (holder.cancelled) throw new Error("the runner is shutting down");
        run = await runCritic({
          jobId: id,
          label,
          attempt: null,
          sources,
          brief: videoPromptFacing(record.brief, record.classes),
          scenes: record.classes.map((scene, at) => ({ class: scene, name: record.brief.scenes[at]?.name ?? scene })),
          auth: agentAuth(),
          model: videoCriticModel(),
          timeoutMs: videoCriticTimeoutMs(),
          onCall: (call) => {
            holder.call = call;
            if (call !== null && holder.cancelled) void call.stop("cancelled");
          },
          cancelled: () => holder.cancelled,
        });
      } catch (error) {
        run = skippedRun(null, `the picture check could not be set up: ${(error as Error).message}`);
      }
      await this.keepCriticRun(id, run);
      return run;
    })();
    const settled = done.then(
      () => undefined,
      () => undefined,
    );
    this.standaloneSettled.set(id, settled);
    try {
      return await done;
    } finally {
      release();
      if (this.standaloneSettled.get(id) === settled) this.standaloneSettled.delete(id);
    }
  }
}

/** The warning a fallback adds to the restored gate result, which the card and the job view show. */
export const FALLBACK_WARNING = "The retry after the picture check did not pass, so this is the earlier build; its open defects are listed under Picture check";

/** What the job view's picture check step says about a run. */
function criticStepNote(run: CriticRun | undefined): string | null {
  if (run === undefined) return null;
  if (run.scores === null) return `no scores: ${run.error ?? "the critic gave none"}`;
  const found = [`${run.defects.length} defect${run.defects.length === 1 ? "" : "s"}`, `${run.notes.length} note${run.notes.length === 1 ? "" : "s"}`].join(", ");
  return `${found}${run.sentBack ? ", sent back to the agent" : ""}`;
}

/**
 * The source kept in `source/` at a verdict: the render checkout's, or, after
 * a fallback, the restored build's own copy in `candidate/source/` (all but
 * the gate's `brief.json`), so a revise starts from the video in review.
 */
async function keepSource(record: Pick<VideoJobRecord, "fallback">, backend: VideoBackend, paths: VideoPaths): Promise<void> {
  if ((record.fallback ?? null) === null) return saveSource(backend, paths);
  const names = await readdir(paths.candidateSource).catch(() => null);
  if (names === null) return saveSource(backend, paths);
  await rm(paths.source, { recursive: true, force: true });
  await mkdir(paths.source, { recursive: true });
  for (const name of names) {
    if (name === "brief.json") continue;
    await safeCopy(path.join(paths.candidateSource, name), path.join(paths.source, name)).catch(() => undefined);
  }
}

/** The final source into `source/`, the gate's careful way: the files the job's backend names. */
async function saveSource(backend: VideoBackend, paths: VideoPaths): Promise<void> {
  const files = await backend.sourceFiles(paths).catch(() => [] as string[]);
  await rm(paths.source, { recursive: true, force: true });
  await mkdir(paths.source, { recursive: true });
  for (const file of files) await safeCopy(file, path.join(paths.source, path.basename(file))).catch(() => undefined);
}

/**
 * Whether the agent did something inside the hang window that the stream
 * does not show: a wrapper call that ended within it. `calls.ndjson` sits in
 * the job directory, which no profile can write, so only the wrapper, and so
 * only the agent's Bash tool, adds a line to it.
 */
export function agentActive(calls: readonly { endedAt?: string }[], now: number, hangMs: number): boolean {
  return calls.some((call) => {
    const ended = Date.parse(call.endedAt ?? "");
    return Number.isFinite(ended) && ended > now - hangMs;
  });
}

/**
 * How long a started wrapper call counts as working: the Bash tool's own
 * ceiling on one call, and a minute for the wrapper to notice. A marker older
 * than that belongs to a call the tool already ended (a killed wrapper cannot
 * remove its own), so it counts for nothing.
 */
export const IN_FLIGHT_MAX_MS = BASH_TIMEOUT_MS + 60_000;

/**
 * The start times of the wrapper calls that have started and not ended.
 *
 * The wrapper writes a marker whole and renames it into place, but a marker
 * that is there and does not parse still counts, dated by its own
 * modification time: stopping a healthy render over a read that raced a
 * write is the worse mistake, and the expiry still ends it (Greptile on
 * #201). Only an old malformed marker is ignored, by that same expiry.
 */
export async function inFlight(directory: string): Promise<number[]> {
  const names = await readdir(directory).catch(() => [] as string[]);
  const starts: number[] = [];
  for (const name of names) {
    if (!/^[0-9]+\.json$/.test(name)) continue;
    const file = path.join(directory, name);
    const facts = await lstat(file).catch(() => null);
    if (facts === null || !facts.isFile()) continue;
    const body = await readFile(file, "utf8").catch(() => "");
    let started = Number.NaN;
    try {
      started = Date.parse((JSON.parse(body) as { startedAt?: string }).startedAt ?? "");
    } catch {
      /* unreadable: dated by the file below */
    }
    starts.push(Number.isFinite(started) ? started : facts.mtimeMs);
  }
  return starts;
}

/**
 * The hang timer's question for one job, asked when the stream has been
 * silent for `hangMs`: a wrapper call ended inside the window, or one is still
 * running (a render, which the stream shows nothing of until it ends). The
 * second holds whatever `STUDIO_VIDEO_HANG_MS` is set to, bounded by the Bash
 * tool's ceiling rather than by the window (Greptile on #201).
 */
export async function stillWorking(paths: Pick<VideoPaths, "calls" | "inflight">, hangMs: number, now: number = Date.now()): Promise<boolean> {
  if (agentActive(await readCalls(paths.calls), now, hangMs)) return true;
  return (await inFlight(paths.inflight)).some((started) => started > now - IN_FLIGHT_MAX_MS);
}

/** One wrapper call, as the narration log says it (D24). */
export function narrateCall(call: { verb: string; scenes?: string[]; exitCode: number | null; startedAt: string; endedAt: string; rendered?: string[] }): string {
  const seconds = Math.max(0, Math.round((Date.parse(call.endedAt) - Date.parse(call.startedAt)) / 1000));
  const ok = call.exitCode === 0;
  switch (call.verb) {
    case "preview":
      return ok
        ? `rendered ${call.rendered?.length ?? 0} scene${call.rendered?.length === 1 ? "" : "s"} at 480p in ${seconds} s`
        : `a preview failed after ${seconds} s; the agent has the error`;
    case "still":
      return ok ? `rendered the stills at half size in ${seconds} s` : `a still render failed after ${seconds} s; the agent has the error`;
    case "build":
      return ok ? `built the video at 1080p in ${seconds} s` : `a build failed after ${seconds} s; the agent has the error`;
    case "narrate":
      return ok ? `voiced the lines in ${seconds} s` : `the narration step failed after ${seconds} s`;
    case "lint":
      return ok ? "the scene file lints clean" : "lint found errors";
    case "api":
      return "read the helper listing";
    default:
      return "a command was refused";
  }
}

/**
 * Whether the catalog refused a `--discard-parent` enqueue because the parent
 * was no longer in review when its row lock was taken (`discardForChange` in
 * `services/catalog/src/commands/job.ts`).
 */
function leftReview(error: string | null | undefined): boolean {
  return error !== null && error !== undefined && (/, not awaiting_review, so there is nothing to discard/.test(error) || /moved while it was being discarded/.test(error));
}

/** The plain-English line every response carries about a video job. */
export function videoNote(record: VideoJobRecord): string {
  switch (record.state) {
    case "queued":
      return "queued: the video runner has not picked it up yet";
    case "running":
      return record.cancelRequestedAt !== null ? "stopping: the agent and its renders are being stopped" : `${record.phase ?? "working"}, attempt ${record.attempt}`;
    case "awaiting_review": {
      const seconds = record.gate?.durationSeconds;
      return `the video is built and checked in the job's workspace, and nothing has landed.${seconds === null || seconds === undefined ? "" : ` ${Math.round(seconds)} seconds.`}`;
    }
    case "accepted":
      return `accepted: ${record.written.join(", ") || "the video"} landed in the database`;
    case "discarded":
      return "discarded: the renders are deleted, the source is kept, and nothing landed";
    case "failed":
      return `failed: ${record.error ?? "no reason recorded"}`;
    case "cancelled":
      return `cancelled: ${record.error ?? "stopped on request"}`;
    case "interrupted":
      return "interrupted: the runner died while this was running, and no gate ran";
    default:
      return record.state;
  }
}

/** The sha256 of a string, for tests and callers that hash a source they hold. */
export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
