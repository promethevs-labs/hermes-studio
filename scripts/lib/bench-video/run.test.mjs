// `bench:video run`'s loop against a stand-in HTTP server that plays a studio
// runner: the guard's header rules, health with a doctor that answers late,
// enqueue (201, 409, 429), job states, accept and cancel, and the job files a
// real runner leaves under STUDIO_HOME. The child-runner start is injected, so
// no runner, no agent and no model is ever started here, and every file goes
// under the OS temp directory.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readJobFiles, recordFields, sourceMetrics, turnsOf } from './metrics.mjs';
import { planFor, runBench, toolReadiness } from './run.mjs';
import { call, portFree } from './runner.mjs';
import { scoreRun, wantsScore } from './score.mjs';
import { costOf, knownCostOf } from './cost.mjs';

const brief = (id) => ({
  id,
  needs: `needs of ${id}`,
  brief: {
    title: `Title ${id}`,
    topic: 'computer-networks',
    slug: id,
    mode: 'new',
    idea: 'An idea.',
    audience: 'familiar',
    targetSeconds: 60,
    voice: 'af_heart',
    scenes: [
      { name: 'Start', beats: [{ say: 'One.', show: 'A row of boxes.' }] },
      { name: 'Middle', beats: [{ say: 'Two.', show: 'The boxes split.' }] },
      { name: 'End', beats: [{ say: 'Three.', show: 'One box is left.' }] },
    ],
    concepts: [],
  },
});

/** The critic's scores on the five dimensions. */
const SCORES = { accuracy: 4, layout: 3, relevance: 5, variety: 3, pacing: 4 };

const SCENE = `from manimlib import *

class A1_Start(Scene):
    def construct(self):
        self.play(FadeIn(Square()))
        self.play(Write(Text("x")))
`;

/**
 * A stand-in runner. `scripts` maps a brief id to what its job does:
 * `{ enqueue: 201 | 409 | 429 | 503, polls, end: 'awaiting_review' | 'failed', cost, errorKind }`,
 * and to what the two newer routes answer for it:
 * `shots: { status, shotPlan: 'planned' | 'failed' | 'off', cost, reason }` for
 * `POST /api/video/shots` (planned by default), `critic` for the job view's own
 * critic (a `criticView`, or null for none) with `criticCost` for what it spent,
 * and `standalone: { status: 200 | 409 | 429 | 503, scores, defects, cost }` for
 * `POST /api/jobs/{id}/critic`.
 */
function standIn({ studioHome, scripts, capUsd = 5, doctorAfter = 1, toolAvailable = true }) {
  const seen = { posts: [], accepts: [], cancels: [], refusedByGuard: [], health: 0, shots: [], critics: [] };
  const jobs = new Map();
  let next = 1;
  const send = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };
  const writeFiles = (job) => {
    const dir = join(studioHome, 'jobs', job.id);
    mkdirSync(join(dir, 'source'), { recursive: true });
    // A failed job can keep the untouched scene stub, which scans like a picture.
    if (job.script.stub === true) writeFileSync(join(dir, 'source', 'scenes.py'), SCENE);
    const started = '2026-11-20T10:00:00.000Z';
    // The critic's runs and spend sit apart from the job's cost, as the runner keeps them.
    const critic = [
      ...(typeof job.script.criticCost === 'number' ? [{ attempt: 2, standalone: false, startedAt: started, finishedAt: started, costUsd: job.script.criticCost }] : []),
      ...job.standaloneSpend.map((costUsd) => ({ attempt: null, standalone: true, startedAt: started, finishedAt: started, costUsd })),
    ];
    const criticSpend = critic.map(({ startedAt, finishedAt, costUsd }) => ({ startedAt, finishedAt, costUsd }));
    writeFileSync(
      join(dir, 'job.json'),
      JSON.stringify({
        id: job.id,
        state: job.state,
        attempt: 2,
        turns: 31,
        costUsd: job.script.cost ?? 1.25,
        startedAt: started,
        finishedAt: '2026-11-20T10:12:30.000Z',
        gate: { ok: job.state !== 'failed' },
        manualHash: 'abc123def456aaaa',
        ...(critic.length === 0 ? {} : { critic, criticSpend }),
      }),
    );
    writeFileSync(
      join(dir, 'run.json'),
      JSON.stringify({ model: { passed: 'sonnet', resolved: 'claude-sonnet-5' }, manualHash: 'abc123def456aaaa', renderSeconds: 95.5, attempts: [{ n: 1, turns: 20, gate: { ok: false } }, { n: 2, turns: 11, gate: { ok: job.state !== 'failed' } }] }),
    );
  };
  const server = createServer((req, res) => {
    const port = server.address().port;
    // The guard's rules (services/studio/src/api.ts): the bench's client must pass them.
    if (req.headers.host !== `127.0.0.1:${port}` || req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) {
      seen.refusedByGuard.push(req.url);
      return send(res, 403, { error: 'guard' });
    }
    if (req.method === 'POST' && req.headers['content-type'] !== 'application/json') {
      seen.refusedByGuard.push(req.url);
      return send(res, 403, { error: 'content type' });
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length === 0 ? null : JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const parts = req.url.split('/').filter(Boolean);
      if (req.method === 'GET' && req.url === '/api/health') {
        seen.health += 1;
        const done = seen.health > doctorAfter;
        return send(res, 200, {
          claude: true,
          dailyCap: { capUsd, exceeded: false, totalUsd: 0 },
          video: { tools: [{ name: 'manimkc', available: done && toolAvailable, reason: !done ? 'the manimkc doctor has not finished its first check' : toolAvailable ? null : 'this machine cannot make manimkc videos right now: venv: missing' }] },
        });
      }
      if (req.method === 'POST' && req.url === '/api/video/shots') {
        seen.shots.push(body);
        const id = body.brief.slug.replace(/-[a-z0-9]+$/, '');
        const plan = scripts[id]?.shots ?? {};
        if ((plan.status ?? 200) === 429) return send(res, 429, { error: 'the studio has spent $5.10 in the last 24 hours', detail: { reason: 'daily-cap', totalUsd: 5.1, capUsd } });
        if ((plan.status ?? 200) !== 200) return send(res, plan.status, { error: `refused with ${plan.status}`, detail: null });
        const answered = { ...body.brief };
        delete answered.kind;
        const state = plan.shotPlan ?? 'planned';
        const types = ['title', 'array-or-memory', 'recap-map'];
        if (state === 'planned') {
          answered.scenes = answered.scenes.map((scene, i) => ({ ...scene, shot: { type: types[i % types.length], layout: 'centre', motion: 'build', why: 'it fits' } }));
        }
        return send(res, 200, { brief: answered, shotPlan: state, costUsd: plan.cost ?? (state === 'planned' ? 0.3 : 0), ...(plan.reason === undefined ? {} : { reason: plan.reason }) });
      }
      if (req.method === 'POST' && req.url === '/api/jobs') {
        seen.posts.push(body);
        const known = [...jobs.values()].find((job) => job.key === body.idempotencyKey);
        if (known !== undefined) return send(res, 200, { jobId: known.id, state: known.state, created: false });
        const id = body.slug.replace(/-[a-z0-9]+$/, '');
        const script = scripts[id] ?? {};
        const status = script.enqueue ?? 201;
        if (status === 429) return send(res, 429, { error: 'the studio has spent $5.10 in the last 24 hours', detail: { reason: 'daily-cap', totalUsd: 5.1, capUsd } });
        if (status !== 201) return send(res, status, { error: `refused with ${status}`, detail: null });
        const job = { id: `job-${next++}`, key: body.idempotencyKey, state: 'queued', polls: 0, script, critic: script.critic ?? null, standaloneSpend: [] };
        jobs.set(job.id, job);
        return send(res, 201, { jobId: job.id, kind: 'video', state: 'queued', created: true });
      }
      if (parts[0] === 'api' && parts[1] === 'jobs' && parts.length >= 3) {
        const job = jobs.get(decodeURIComponent(parts[2]));
        if (job === undefined) return send(res, 404, { error: 'no such job' });
        if (req.method === 'GET' && parts.length === 3) {
          if (['queued', 'running'].includes(job.state)) {
            job.polls += 1;
            if (job.polls >= (job.script.polls ?? 2)) {
              job.state = job.script.end ?? 'awaiting_review';
              writeFiles(job);
            } else job.state = 'running';
          }
          return send(res, 200, {
            jobId: job.id,
            state: job.state,
            attempt: 2,
            costUsd: ['running', 'cancelled'].includes(job.state) ? 0.4 : (job.script.cost ?? 1.25),
            error: job.state === 'failed' ? 'the gate failed: scene two runs long' : null,
            errorKind: job.state === 'failed' ? (job.script.errorKind ?? 'gate') : null,
            critic: ['awaiting_review', 'accepted'].includes(job.state) ? job.critic : null,
          });
        }
        if (req.method === 'POST' && parts[3] === 'critic') {
          seen.critics.push(job.id);
          const answer = job.script.standalone ?? {};
          const status = answer.status ?? 200;
          if (status === 429) return send(res, 429, { error: 'the studio has spent $5.10 in the last 24 hours', detail: { reason: 'daily-cap' } });
          if (status === 409) return send(res, 409, { error: `job ${job.id} has no contact sheet left to read`, detail: { reason: 'no-sheets' } });
          if (status !== 200) return send(res, status, { error: 'the picture check is off (STUDIO_VIDEO_CRITIC=off), so no critic was run', detail: null });
          const scores = answer.scores ?? SCORES;
          const defects = answer.defects ?? [];
          const costUsd = answer.cost ?? 0.12;
          job.standaloneSpend.push(costUsd);
          writeFiles(job);
          // The standalone run is now the job's latest read of its build in review.
          job.critic = { attempt: 2, attempts: 2, build: 2, current: true, unscoredReason: null, scores, defects, notes: ['a note'], sentBack: job.critic?.sentBack ?? [] };
          return send(res, 200, { jobId: job.id, critic: { standalone: true, attempt: null, model: 'sonnet', costUsd, scores, defects, notes: ['a note'], sheets: [], skipped: [], error: null } });
        }
        if (req.method === 'POST' && parts[3] === 'accept') {
          seen.accepts.push(job.id);
          job.state = 'accepted';
          writeFiles(job);
          writeFileSync(join(studioHome, 'jobs', job.id, 'source', 'scenes.py'), SCENE);
          return send(res, 200, { jobId: job.id, state: 'accepted' });
        }
        if (req.method === 'POST' && parts[3] === 'cancel') {
          seen.cancels.push(job.id);
          job.state = 'cancelled';
          return send(res, 202, { jobId: job.id, state: 'cancelled' });
        }
      }
      return send(res, 404, { error: 'no route' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}

let dir;
let studioHome;
let runFile;
let stand;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bench-run-'));
  studioHome = join(dir, 'studio');
  runFile = join(dir, 'runs', 'base.json');
  mkdirSync(studioHome, { recursive: true });
});

afterEach(async () => {
  // The unwritable-run-file test takes the write bit away; give it back so the directory can go.
  if (existsSync(join(dir, 'runs'))) chmodSync(join(dir, 'runs'), 0o755);
  if (stand !== undefined) await new Promise((resolve) => stand.server.close(resolve));
  stand = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** The deps runBench takes, pointed at the stand-in. `start` is the injected child-runner start. */
function deps(overrides = {}) {
  const lines = [];
  const started = { count: 0, stopped: 0, env: null };
  return {
    lines,
    started,
    deps: {
      envFor: (options) => ({ STUDIO_DAILY_USD: String(options.cap), STUDIO_PORT: String(options.port) }),
      start: async (env) => {
        started.count += 1;
        started.env = env;
        return { base: stand.base, stop: async () => (started.stopped += 1, true) };
      },
      call,
      portFree: async () => true,
      readJob: (jobId) => readJobFiles(studioHome, jobId),
      metrics: (jobId) => sourceMetrics(studioHome, jobId, 'manimkc'),
      log: (line) => lines.push(line),
      sleep: async () => {},
      pollMs: 0,
      healthMs: 0,
      ...overrides,
    },
  };
}

const options = (entries, extra = {}) => ({ home: dir, label: 'base', tool: 'manimkc', model: 'sonnet', cap: 5, port: 7260, entries, runFile, ...extra });

describe('runBench', () => {
  it('posts each brief, follows it, accepts it, records it, and stops cleanly at a 429', async () => {
    stand = await standIn({ studioHome, scripts: { 'a-one': { polls: 3 }, 'b-two': { end: 'failed', cost: 0.75 }, 'c-three': { enqueue: 429 } } });
    const { deps: d, lines, started } = deps();
    const run = await runBench(options(['a-one', 'b-two', 'c-three', 'd-four'].map(brief)), d);

    expect(stand.seen.refusedByGuard).toEqual([]);
    expect(started).toMatchObject({ count: 1, stopped: 1, env: { STUDIO_DAILY_USD: '5', STUDIO_PORT: '7260' } });
    // The doctor answered on the second health call; nothing was posted before it.
    expect(stand.seen.health).toBe(2);
    expect(stand.seen.posts.map((post) => [post.slug, post.tool, post.model, post.idempotencyKey, post.kind])).toEqual([
      ['a-one-base', 'manimkc', 'sonnet', 'bench-video:base:a-one:1', 'video'],
      ['b-two-base', 'manimkc', 'sonnet', 'bench-video:base:b-two:1', 'video'],
      ['c-three-base', 'manimkc', 'sonnet', 'bench-video:base:c-three:1', 'video'],
    ]);
    expect(stand.seen.accepts).toEqual(['job-1']);
    expect(lines.filter((line) => line.startsWith('bench: 4 briefs'))).toEqual(['bench: 4 briefs on manimkc, model sonnet, cap $5.00 for this home\'s rolling day']);

    const written = JSON.parse(readFileSync(runFile, 'utf8'));
    expect(written).toEqual(run);
    expect(written).toMatchObject({ label: 'base', tool: 'manimkc', model: 'sonnet', manualHashes: ['abc123def456aaaa'] });
    expect(written.stopReason).toMatch(/c-three: the runner refused it at the daily cap/);
    expect(typeof written.startedAt).toBe('string');
    expect(typeof written.endedAt).toBe('string');
    const [one, two, three] = written.results;
    expect(written.results.map((result) => result.id)).toEqual(['a-one', 'b-two', 'c-three']);
    expect(one).toMatchObject({
      id: 'a-one',
      jobId: 'job-1',
      state: 'accepted',
      gateOk: true,
      attempts: 2,
      turns: 31,
      costUsd: 1.25,
      wallSeconds: 750,
      renderSeconds: 95.5,
      metrics: { variety: 1, helperTop5Share: null, fadeShare: 0.5, uses3d: false },
      error: null,
    });
    expect(two).toMatchObject({ id: 'b-two', state: 'failed', gateOk: false, costUsd: 0.75, metrics: null, error: 'the gate failed: scene two runs long', errorKind: 'gate' });
    expect(three).toMatchObject({ id: 'c-three', jobId: null, state: 'refused', error: expect.stringMatching(/^429 daily-cap: /) });
  });

  it('stops at a 409 unless --keep-going, and then carries on past it', async () => {
    stand = await standIn({ studioHome, scripts: { 'a-one': { enqueue: 409 } } });
    const stopped = await runBench(options(['a-one', 'b-two'].map(brief)), deps().deps);
    expect(stand.seen.posts.map((post) => post.slug)).toEqual(['a-one-base']);
    expect(stopped.results.map((result) => [result.id, result.state])).toEqual([['a-one', 'refused']]);
    expect(stopped.results[0].error).toBe('409: refused with 409');
    expect(stopped.stopReason).toMatch(/--keep-going/);

    rmSync(runFile);
    const kept = await runBench(options(['a-one', 'b-two'].map(brief), { keepGoing: true }), deps().deps);
    expect(kept.results.map((result) => [result.id, result.state])).toEqual([
      ['a-one', 'refused'],
      ['b-two', 'accepted'],
    ]);
    expect(kept.stopReason).toBeUndefined();
  });

  it('records no look metrics for a job that did not land, even with a scene file kept', async () => {
    stand = await standIn({ studioHome, scripts: { 'a-one': { end: 'failed', stub: true, cost: 0 } } });
    const run = await runBench(options(['a-one'].map(brief)), deps().deps);
    expect(sourceMetrics(studioHome, 'job-1', 'manimkc')).not.toBeNull();
    expect(run.results[0]).toMatchObject({ state: 'failed', metrics: null });
  });

  it('stops on a failure that says the machine is the problem', async () => {
    stand = await standIn({ studioHome, scripts: { 'a-one': { end: 'failed', errorKind: 'agent', cost: 0 } } });
    const run = await runBench(options(['a-one', 'b-two'].map(brief)), deps().deps);
    expect(stand.seen.posts).toHaveLength(1);
    expect(run.stopReason).toMatch(/error kind agent/);
  });

  it('posts nothing when the runner reports another cap, or the tool is not available, or the port is taken', async () => {
    stand = await standIn({ studioHome, scripts: {}, capUsd: 50 });
    await expect(runBench(options([brief('a-one')]), deps().deps)).rejects.toThrow(/daily cap of 50, not the \$5/);
    expect(stand.seen.posts).toEqual([]);
    // Nothing was posted, so no run file stands in the way of the next try.
    expect(existsSync(runFile)).toBe(false);
    await new Promise((resolve) => stand.server.close(resolve));

    stand = await standIn({ studioHome, scripts: {}, toolAvailable: false });
    await expect(runBench(options([brief('a-one')]), deps().deps)).rejects.toThrow(/venv: missing; nothing was posted/);
    expect(stand.seen.posts).toEqual([]);
    expect(existsSync(runFile)).toBe(false);

    const taken = deps({ portFree: async () => false });
    await expect(runBench(options([brief('a-one')]), taken.deps)).rejects.toThrow(/already listens on 127.0.0.1:7260/);
    expect(taken.started.count).toBe(0);
  });

  it('refuses an existing run file without --resume, and a resume skips what is settled', async () => {
    stand = await standIn({ studioHome, scripts: {} });
    await runBench(options(['a-one'].map(brief)), deps().deps);
    await expect(runBench(options(['a-one', 'b-two'].map(brief)), deps().deps)).rejects.toThrow(/--resume/);
    await expect(runBench(options(['a-one'].map(brief), { resume: true, tool: 'revideokc' }), deps().deps)).rejects.toThrow(/same tool and model/);

    const resumed = await runBench(options(['a-one', 'b-two'].map(brief), { resume: true }), deps().deps);
    expect(stand.seen.posts.map((post) => post.slug)).toEqual(['a-one-base', 'b-two-base']);
    expect(resumed.results.map((result) => [result.id, result.state])).toEqual([
      ['a-one', 'accepted'],
      ['b-two', 'accepted'],
    ]);

    const idle = deps();
    await runBench(options(['a-one', 'b-two'].map(brief), { resume: true }), idle.deps);
    expect(idle.started.count).toBe(0);
    expect(idle.lines).toEqual([expect.stringMatching(/^nothing to run/)]);
  });

  it('cancels the running job when stopped, and a resume posts it again as a new attempt with its cost kept', async () => {
    stand = await standIn({ studioHome, scripts: { 'a-one': { polls: 50 } } });
    let polls = 0;
    const stopping = deps({
      call: async (base, method, path, body, opts) => {
        if (method === 'GET' && path.startsWith('/api/jobs/')) polls += 1;
        return call(base, method, path, body, opts);
      },
      stopped: () => polls >= 2,
    });
    const run = await runBench(options(['a-one', 'b-two'].map(brief)), stopping.deps);
    expect(stand.seen.cancels).toEqual(['job-1']);
    expect(run.results).toEqual([expect.objectContaining({ id: 'a-one', state: 'stopped', stopped: true, jobId: 'job-1', costUsd: 0.4 })]);
    expect(stopping.started.stopped).toBe(1);

    stand.seen.posts.length = 0;
    const resumed = await runBench(options(['a-one', 'b-two'].map(brief), { resume: true }), deps().deps);
    expect(stand.seen.posts.map((post) => post.idempotencyKey)).toEqual(['bench-video:base:a-one:2', 'bench-video:base:b-two:1']);
    expect(resumed.results[0]).toMatchObject({ id: 'a-one', jobId: 'job-2', state: 'accepted', tries: 2, earlierCostUsd: 0.4, costUsd: 1.25 });
  });

  it('stops before posting once the recorded costs reach the cap', async () => {
    stand = await standIn({ studioHome, scripts: { 'a-one': { cost: 3 }, 'b-two': { cost: 3 } } });
    const run = await runBench(options(['a-one', 'b-two', 'c-three'].map(brief)), deps().deps);
    expect(stand.seen.posts.map((post) => post.slug)).toEqual(['a-one-base', 'b-two-base']);
    expect(run.stopReason).toMatch(/recorded cost, \$6.00, has reached the \$5.00 cap/);
  });
});

describe('run --shots', () => {
  it('plans each brief with the body it will post, posts the planned brief, and records the plan', async () => {
    stand = await standIn({ studioHome, scripts: {} });
    const run = await runBench(options(['a-one'].map(brief), { shots: true }), deps().deps);
    expect(stand.seen.refusedByGuard).toEqual([]);
    // The plan was asked with the brief exactly as the job was going to be posted.
    expect(stand.seen.shots).toHaveLength(1);
    const asked = stand.seen.shots[0].brief;
    expect(asked).toMatchObject({ kind: 'video', slug: 'a-one-base', tool: 'manimkc', model: 'sonnet', idempotencyKey: 'bench-video:base:a-one:1' });
    expect(asked.scenes.every((scene) => scene.shot === undefined)).toBe(true);
    const [posted] = stand.seen.posts;
    expect(posted).toMatchObject({ kind: 'video', slug: 'a-one-base', tool: 'manimkc', model: 'sonnet', idempotencyKey: 'bench-video:base:a-one:1' });
    expect(posted.scenes.map((scene) => scene.shot.type)).toEqual(['title', 'array-or-memory', 'recap-map']);
    expect(run.shotsAsked).toBe(true);
    expect(run.results[0]).toMatchObject({
      state: 'accepted',
      shots: { state: 'planned', costUsd: 0.3, reason: null, types: ['title', 'array-or-memory', 'recap-map'] },
    });
    expect(run.results[0].shots.brief.scenes[1].shot.type).toBe('array-or-memory');
  });

  it('counts the plan in the cap, and a resume reuses a recorded plan without asking again', async () => {
    // a-one: 4.50 for the job and 0.30 for its plan. b-two's plan brings the
    // run to 5.10, so it stops before b-two's job is posted.
    stand = await standIn({ studioHome, scripts: { 'a-one': { cost: 4.5 }, 'b-two': { cost: 1 } } });
    const first = await runBench(options(['a-one', 'b-two'].map(brief), { shots: true }), deps().deps);
    expect(stand.seen.shots.map((asked) => asked.brief.slug)).toEqual(['a-one-base', 'b-two-base']);
    expect(stand.seen.posts.map((post) => post.slug)).toEqual(['a-one-base']);
    expect(first.stopReason).toMatch(/recorded cost, \$5.10, has reached the \$5.00 cap/);
    expect(first.results[1]).toMatchObject({ id: 'b-two', jobId: null, state: 'not-posted', shots: { state: 'planned', costUsd: 0.3 } });

    await expect(runBench(options(['a-one', 'b-two'].map(brief), { resume: true, cap: 10 }), deps().deps)).rejects.toThrow(/was run with --shots; a resume must ask for shots the same way/);
    // The owner raises the cap; the runner over the home now reports $10.
    await new Promise((resolve) => stand.server.close(resolve));
    stand = await standIn({ studioHome, scripts: { 'b-two': { cost: 1 } }, capUsd: 10 });
    const resumed = await runBench(options(['a-one', 'b-two'].map(brief), { shots: true, resume: true, cap: 10 }), deps().deps);
    expect(stand.seen.shots).toEqual([]);
    const reposted = stand.seen.posts.at(-1);
    expect(reposted.idempotencyKey).toBe('bench-video:base:b-two:2');
    expect(reposted.scenes.map((scene) => scene.shot.type)).toEqual(['title', 'array-or-memory', 'recap-map']);
    expect(resumed.results[1]).toMatchObject({ state: 'accepted', shots: { state: 'planned', costUsd: 0.3 } });
  });

  it('posts no job when stopped during the shot plan, keeps the plan, and a resume posts it without paying again', async () => {
    stand = await standIn({ studioHome, scripts: {} });
    let stop = false;
    const stopping = deps({
      call: async (base, method, path, body, opts) => {
        const answer = await call(base, method, path, body, opts);
        // The signal lands while the art director's call is out.
        if (method === 'POST' && path === '/api/video/shots') stop = true;
        return answer;
      },
      stopped: () => stop,
    });
    const run = await runBench(options(['a-one', 'b-two'].map(brief), { shots: true }), stopping.deps);
    expect(stand.seen.shots).toHaveLength(1);
    expect(stand.seen.posts).toEqual([]);
    expect(run.stopReason).toBe('stopped');
    expect(run.results).toEqual([expect.objectContaining({ id: 'a-one', jobId: null, state: 'not-posted', shots: expect.objectContaining({ state: 'planned', costUsd: 0.3 }) })]);
    expect(JSON.parse(readFileSync(runFile, 'utf8')).results[0].shots.brief.scenes[0].shot.type).toBe('title');
    expect(stopping.started.stopped).toBe(1);

    const resumed = await runBench(options(['a-one'].map(brief), { shots: true, resume: true }), deps().deps);
    expect(stand.seen.shots).toHaveLength(1);
    expect(stand.seen.posts.map((post) => post.scenes.map((scene) => scene.shot.type))).toEqual([['title', 'array-or-memory', 'recap-map']]);
    expect(resumed.results[0]).toMatchObject({ state: 'accepted', shots: { state: 'planned', costUsd: 0.3 } });
  });

  it('posts the brief without shots when the plan failed, and records why', async () => {
    stand = await standIn({ studioHome, scripts: { 'a-one': { shots: { shotPlan: 'failed', cost: 0.1, reason: 'the reply had no shots block' } } } });
    const run = await runBench(options(['a-one'].map(brief), { shots: true }), deps().deps);
    expect(stand.seen.posts[0].scenes.every((scene) => scene.shot === undefined)).toBe(true);
    expect(run.results[0]).toMatchObject({ state: 'accepted', shots: { state: 'failed', costUsd: 0.1, reason: 'the reply had no shots block', types: null, brief: null } });
    expect(run.stopReason).toBeUndefined();
  });

  it('stops before posting when the art director is off, unless --keep-going', async () => {
    const off = { shots: { shotPlan: 'off', cost: 0, reason: 'the art director is off on this studio (STUDIO_ART_DIRECTOR=off)' } };
    stand = await standIn({ studioHome, scripts: { 'a-one': off, 'b-two': off } });
    const stopped = await runBench(options(['a-one', 'b-two'].map(brief), { shots: true }), deps().deps);
    expect(stand.seen.posts).toEqual([]);
    expect(stopped.stopReason).toMatch(/art director is off; pass --keep-going/);
    expect(stopped.results).toEqual([expect.objectContaining({ id: 'a-one', state: 'not-posted', shots: expect.objectContaining({ state: 'off' }) })]);

    rmSync(runFile);
    const kept = await runBench(options(['a-one', 'b-two'].map(brief), { shots: true, keepGoing: true }), deps().deps);
    expect(stand.seen.posts.map((post) => post.slug)).toEqual(['a-one-base', 'b-two-base']);
    expect(kept.results.map((result) => [result.state, result.shots.state])).toEqual([
      ['accepted', 'off'],
      ['accepted', 'off'],
    ]);
  });

  it('stops cleanly at a 429 from the shot plan, with nothing posted', async () => {
    stand = await standIn({ studioHome, scripts: { 'a-one': { shots: { status: 429 } } } });
    const d = deps();
    const run = await runBench(options(['a-one', 'b-two'].map(brief), { shots: true }), d.deps);
    expect(stand.seen.posts).toEqual([]);
    expect(run.stopReason).toMatch(/a-one: the runner refused its shot plan at the daily cap/);
    expect(run.results).toEqual([expect.objectContaining({ id: 'a-one', state: 'refused', shots: expect.objectContaining({ state: 'refused' }) })]);
    expect(d.started.stopped).toBe(1);
  });
});

describe('the critic on a run', () => {
  const view = (extra = {}) => ({ attempt: 2, attempts: 2, build: 2, current: true, unscoredReason: null, scores: SCORES, defects: [], notes: ['tidy'], sentBack: [], ...extra });

  it('reads the job\'s own critic after the accept, counts what it spent, and never calls the standalone route for it', async () => {
    const defect = { scene: 'A2_Split', problem: 'the labels overlap', fix: 'move the right label down' };
    stand = await standIn({ studioHome, scripts: { 'a-one': { critic: view(), criticCost: 0.15 }, 'b-two': { critic: view({ defects: [defect] }) } } });
    const run = await runBench(options(['a-one', 'b-two'].map(brief), { critic: true }), deps().deps);
    expect(stand.seen.critics).toEqual([]);
    expect(run.criticAsked).toBe(true);
    expect(run.results[0]).toMatchObject({
      criticCostUsd: 0.15,
      critic: { source: 'job', attempt: 2, current: true, scores: SCORES, mean: 3.8, defects: [], notes: ['tidy'], sentBack: [], passed: true, error: null },
    });
    expect(run.results[1].critic).toMatchObject({ source: 'job', passed: false, defects: [defect] });
  });

  it('records a job with no critic of its build in review, and calls the standalone route only with --critic', async () => {
    const stale = view({ attempt: 1, current: false, unscoredReason: 'the check timed out' });
    stand = await standIn({ studioHome, scripts: { 'a-one': { critic: null }, 'b-two': { critic: stale } } });
    const plain = await runBench(options(['a-one', 'b-two'].map(brief)), deps().deps);
    expect(stand.seen.critics).toEqual([]);
    expect(plain.results[0].critic).toMatchObject({ source: 'job', current: false, scores: null, passed: null, error: 'no critic scored this job' });
    expect(plain.results[1].critic).toMatchObject({ source: 'job', attempt: 1, current: false, passed: null, error: 'the check timed out' });

    // A fresh label posts the same briefs again as new jobs.
    const asked = await runBench(options(['a-one', 'b-two'].map(brief), { critic: true, label: 'again', runFile: join(dir, 'runs', 'again.json') }), deps().deps);
    expect(stand.seen.critics).toEqual(['job-3', 'job-4']);
    // The standalone check is the bench's measuring: kept apart from the runner's own checks.
    expect(asked.results[0]).toMatchObject({ criticCostUsd: 0, checkCostUsd: 0.12, critic: { source: 'standalone', attempt: 2, current: true, scores: SCORES, passed: true, costUsd: 0.12 } });
    // It counts toward the cap, and not in the cost compare sets side by side.
    expect(costOf(asked.results[0])).toBeCloseTo(1.37);
    expect(knownCostOf(asked.results[0])).toBeCloseTo(1.25);
  });

  it('counts the job just finished, and its own checks, before paying for a standalone check', async () => {
    // A resume with $4 already recorded under a $5 cap: the next job costs
    // $2, so the run is at $6 once it lands and no standalone check is paid for.
    mkdirSync(join(dir, 'runs'), { recursive: true });
    writeFileSync(
      runFile,
      JSON.stringify({
        label: 'base',
        tool: 'manimkc',
        model: 'sonnet',
        capUsd: 5,
        shotsAsked: false,
        criticAsked: true,
        startedAt: '2026-11-19T10:00:00.000Z',
        endedAt: '2026-11-19T11:00:00.000Z',
        manualHashes: [],
        results: [{ id: 'a-old', jobId: 'job-old', state: 'accepted', costUsd: 4, tries: 1 }],
      }),
    );
    stand = await standIn({ studioHome, scripts: { 'b-new': { cost: 2, critic: null } } });
    const d = deps();
    const run = await runBench(options(['b-new'].map(brief), { critic: true, resume: true }), d.deps);
    expect(stand.seen.posts).toHaveLength(1);
    expect(stand.seen.critics).toEqual([]);
    expect(d.lines).toContain("b-new: no standalone critic, the run's recorded cost has reached the cap");
    expect(run.results.find((result) => result.id === 'b-new')).toMatchObject({ state: 'accepted', costUsd: 2, checkCostUsd: null });

    // Its own critic's cost counts too: $2.50 recorded, a $1 job, $1.75 of
    // the runner's checks on it, under a $5 cap.
    await new Promise((resolve) => stand.server.close(resolve));
    rmSync(runFile);
    writeFileSync(runFile, JSON.stringify({ label: 'base', tool: 'manimkc', model: 'sonnet', capUsd: 5, shotsAsked: false, results: [{ id: 'a-old', jobId: 'job-old', state: 'accepted', costUsd: 2.5, tries: 1 }] }));
    const stale = { attempt: 1, attempts: 2, build: 2, current: false, unscoredReason: 'the check timed out', scores: SCORES, defects: [], notes: [], sentBack: [] };
    stand = await standIn({ studioHome, scripts: { 'c-new': { cost: 1, critic: stale, criticCost: 1.75 } } });
    await runBench(options(['c-new'].map(brief), { critic: true, resume: true }), deps().deps);
    expect(stand.seen.critics).toEqual([]);
  });

  it('stops after the video when the runner cannot run the critic, unless --keep-going', async () => {
    stand = await standIn({ studioHome, scripts: { 'a-one': { critic: null, standalone: { status: 503 } }, 'b-two': { critic: null, standalone: { status: 503 } } } });
    const run = await runBench(options(['a-one', 'b-two'].map(brief), { critic: true }), deps().deps);
    expect(stand.seen.posts).toHaveLength(1);
    expect(run.results[0]).toMatchObject({ state: 'accepted', critic: { source: 'standalone', passed: null, error: expect.stringMatching(/^the critic was refused, 503/) } });
    expect(run.stopReason).toMatch(/cannot run the critic.*--keep-going/);
  });
});

describe('scoreRun', () => {
  /** A baseline made before the critic: two accepted videos and a failed one, no critic on any. */
  async function baseline(scripts) {
    stand = await standIn({ studioHome, scripts: { 'a-one': { critic: null, ...scripts['a-one'] }, 'b-two': { critic: null, ...scripts['b-two'] }, 'c-three': { end: 'failed', cost: 0.5 } } });
    await runBench(options(['a-one', 'b-two', 'c-three'].map(brief)), deps().deps);
    const written = JSON.parse(readFileSync(runFile, 'utf8'));
    // As a file from before the critic, with no critic fields at all.
    for (const result of written.results) {
      delete result.critic;
      delete result.criticCostUsd;
    }
    writeFileSync(runFile, JSON.stringify(written));
    stand.seen.critics.length = 0;
  }
  const scoreOptions = (extra = {}) => ({ home: dir, label: 'base', cap: 5, port: 7260, runFile, ...extra });

  it('scores each accepted result once, records a 409 and goes on, and a second score has nothing to do', async () => {
    await baseline({ 'b-two': { standalone: { status: 409 } } });
    const d = deps();
    const run = await scoreRun(scoreOptions(), d.deps);
    expect(stand.seen.refusedByGuard).toEqual([]);
    expect(stand.seen.critics).toEqual(['job-1', 'job-2']);
    expect(d.started).toMatchObject({ count: 1, stopped: 1 });
    const written = JSON.parse(readFileSync(runFile, 'utf8'));
    expect(written).toEqual(run);
    const [one, two, three] = written.results;
    expect(one).toMatchObject({ state: 'accepted', criticCostUsd: 0, checkCostUsd: 0.12, critic: { source: 'standalone', scores: SCORES, mean: 3.8, passed: true } });
    expect(two).toMatchObject({ state: 'accepted', critic: { source: 'standalone', scores: null, passed: null, error: expect.stringMatching(/409 no-sheets/) } });
    expect(three.critic).toBeUndefined();
    expect(written.scoring).toMatchObject({ capUsd: 5, spentUsd: 0.12 });
    expect(written.scoring.stopReason).toBeUndefined();
    expect(wantsScore(one)).toBe(false);
    expect(wantsScore(two)).toBe(false);
    expect(wantsScore(two, true)).toBe(true);

    const idle = deps();
    await scoreRun(scoreOptions(), idle.deps);
    expect(idle.started.count).toBe(0);
    expect(idle.lines).toEqual([expect.stringMatching(/^nothing to score/)]);

    // --again asks once more, for each result a standalone check answered.
    await scoreRun(scoreOptions({ again: true }), deps().deps);
    expect(stand.seen.critics).toEqual(['job-1', 'job-2', 'job-1', 'job-2']);
  });

  it('stops cleanly at a 429 and stops the runner', async () => {
    await baseline({ 'a-one': { standalone: { status: 429 } } });
    const d = deps();
    const run = await scoreRun(scoreOptions(), d.deps);
    expect(stand.seen.critics).toEqual(['job-1']);
    expect(run.scoring.stopReason).toMatch(/a-one: the runner refused the critic at the daily cap/);
    expect(run.results[0].critic).toMatchObject({ source: 'standalone', passed: null, error: expect.stringMatching(/429 daily-cap/) });
    expect(run.results[1].critic).toBeUndefined();
    expect(d.started.stopped).toBe(1);
  });

  it('records a job\'s own critic of the build in review without paying for another', async () => {
    await baseline({ 'a-one': { critic: { attempt: 2, attempts: 2, build: 2, current: true, unscoredReason: null, scores: SCORES, defects: [], notes: [], sentBack: [] } } });
    const run = await scoreRun(scoreOptions({ only: ['a-one'] }), deps().deps);
    expect(stand.seen.critics).toEqual([]);
    expect(run.results[0].critic).toMatchObject({ source: 'job', current: true, passed: true });
    expect(run.results[1].critic).toBeUndefined();
  });

  it('needs no tool doctor, but refuses a runner that reports another cap, and a run file that is not there', async () => {
    await baseline({});
    await new Promise((resolve) => stand.server.close(resolve));
    stand = await standIn({ studioHome, scripts: {}, toolAvailable: false, doctorAfter: 0 });
    // The stand-in forgot the jobs; the GETs answer 404, which is recorded and passed over.
    const run = await scoreRun(scoreOptions(), deps().deps);
    expect(run.scoring.stopReason).toBeUndefined();
    expect(run.results[0].scoreError).toMatch(/answered 404/);

    await new Promise((resolve) => stand.server.close(resolve));
    stand = await standIn({ studioHome, scripts: {}, capUsd: 50 });
    await expect(scoreRun(scoreOptions(), deps().deps)).rejects.toThrow(/daily cap of 50, not the \$5/);
    await expect(scoreRun(scoreOptions({ runFile: join(dir, 'runs', 'none.json') }), deps().deps)).rejects.toThrow(/no run file/);
  });
});

describe('a post whose answer is lost', () => {
  it('is recorded as unanswered, and a resume reposts it under the same key and collects the job the runner already has', async () => {
    stand = await standIn({ studioHome, scripts: {} });
    let lost = false;
    const losing = deps({
      call: async (base, method, path, body, opts) => {
        const answer = await call(base, method, path, body, opts);
        if (method === 'POST' && path === '/api/jobs' && !lost) {
          // The runner took the post; its reply never arrives.
          lost = true;
          throw new Error('socket hang up');
        }
        return answer;
      },
    });
    const first = await runBench(options(['a-one'].map(brief)), losing.deps);
    expect(first.results).toEqual([expect.objectContaining({ id: 'a-one', state: 'unanswered', jobId: null, tries: 1, error: expect.stringMatching(/socket hang up/) })]);
    expect(planFor(first.results[0])).toEqual({ action: 'post', attempt: 1 });

    const resumed = await runBench(options(['a-one'].map(brief), { resume: true }), deps().deps);
    expect(stand.seen.posts.map((post) => post.idempotencyKey)).toEqual(['bench-video:base:a-one:1', 'bench-video:base:a-one:1']);
    expect(resumed.results).toEqual([expect.objectContaining({ id: 'a-one', jobId: 'job-1', state: 'accepted', tries: 1, earlierCostUsd: 0 })]);
    expect(stand.seen.accepts).toEqual(['job-1']);
  });
});

describe('a run file that cannot be written', () => {
  it('still stops the runner, and the write error reaches the caller', async () => {
    stand = await standIn({ studioHome, scripts: { 'a-one': { polls: 3 } } });
    let gets = 0;
    const failing = deps({
      call: async (base, method, path, body, opts) => {
        if (method === 'GET' && path.startsWith('/api/jobs/') && (gets += 1) === 1) chmodSync(join(dir, 'runs'), 0o500);
        return call(base, method, path, body, opts);
      },
    });
    await expect(runBench(options(['a-one'].map(brief)), failing.deps)).rejects.toThrow(/EACCES/);
    expect(failing.started.stopped).toBe(1);
  });
});

describe('turnsOf', () => {
  it('sums a complete attempt history, and falls back to the last attempt otherwise', () => {
    const job = { attempt: 3, turns: 9 };
    expect(turnsOf(job, [{ turns: 20 }, { turns: 14 }, { turns: 9 }])).toBe(43);
    expect(turnsOf(job, [{ turns: 20 }, { turns: null }, { turns: 9 }])).toBe(9);
    expect(turnsOf(job, [{ turns: 14 }, { turns: 9 }])).toBe(9);
    expect(turnsOf(job, [])).toBe(9);
    expect(turnsOf({}, [])).toBeNull();
    expect(recordFields({ job, run: { attempts: [{ turns: 20 }, { turns: 14 }, { turns: 9 }] } }).turns).toBe(43);
  });
});

describe('planFor', () => {
  it('posts a new brief, reuses the key of a post with no answer, skips what is settled and checks the rest', () => {
    expect(planFor(undefined)).toEqual({ action: 'post', attempt: 1 });
    expect(planFor({ state: 'posting', tries: 2 })).toEqual({ action: 'post', attempt: 2 });
    expect(planFor({ state: 'unanswered', tries: 2, jobId: null })).toEqual({ action: 'post', attempt: 2 });
    for (const state of ['accepted', 'failed', 'cancelled']) expect(planFor({ state, tries: 1, jobId: 'j' })).toEqual({ action: 'skip' });
    expect(planFor({ state: 'cancelled', stopped: true, tries: 1, jobId: 'j' })).toEqual({ action: 'check', attempt: 1 });
    expect(planFor({ state: 'awaiting_review', tries: 1, jobId: 'j' })).toEqual({ action: 'check', attempt: 1 });
    expect(planFor({ state: 'refused', tries: 1, jobId: null })).toEqual({ action: 'post', attempt: 2 });
  });
});

describe('toolReadiness', () => {
  it('waits while the doctor has not answered, and says why a tool is off', () => {
    expect(toolReadiness({}, 'manimkc')).toMatchObject({ ready: null });
    expect(toolReadiness({ video: { tools: [{ name: 'manimkc', available: false, reason: 'the manimkc doctor has not finished its first check' }] } }, 'manimkc').ready).toBeNull();
    expect(toolReadiness({ video: { tools: [{ name: 'manimkc', available: false, reason: 'no venv' }] } }, 'manimkc')).toEqual({ ready: false, reason: 'no venv' });
    expect(toolReadiness({ video: { tools: [{ name: 'manimkc', available: true }] } }, 'manimkc')).toEqual({ ready: true, reason: null });
  });
});

describe('portFree', () => {
  it('says a listened port is taken', async () => {
    stand = await standIn({ studioHome, scripts: {} });
    expect(await portFree(stand.server.address().port)).toBe(false);
  });
});
