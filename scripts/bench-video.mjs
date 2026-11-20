// npm run bench:video -- <verb>
//
// The fixed video benchmark (docs/STUDIO-BENCH.md): twelve stored briefs,
// run one at a time through a studio runner this script starts over a
// scratch home, and a comparison of two runs. Run through the npm script,
// which starts node with tsx so the studio's TypeScript validator and the
// catalog's scanner are imported as they are.
//
//   validate                       every brief against the bench rules and the studio's validator
//   setup --home DIR [--reuse]     build a scratch home: catalog, seed, bench topics, studio state
//   run --home DIR --label NAME --tool TOOL --cap USD [--model ID] [--only a,b] [--port N] [--keep-going] [--resume] [--shots] [--critic]
//                                  post each brief, follow it, accept it into the scratch catalog;
//                                  --shots plans each brief's shots first, --critic checks a video
//                                  whose job has no critic of its build in review
//   score --home DIR --label NAME --cap USD [--port N] [--only a,b] [--again]
//                                  the critic's scores for a run that already exists
//   compare --home DIR A B [--json]
//                                  two runs side by side
//   dry-run --tool TOOL [--only a,b] [--label NAME] [--shots] [--critic] [--json]
//                                  what run would post; no network, nothing started
//
// A run and a score spend money: they start paid agent sessions. --cap has no default.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { isAgentModel } from '@hermes/schema/shared';

import { BENCH_TOOLS, FALLBACK_CHARS_PER_SECOND, jobBody, loadBriefs, loadTopics, predictedSeconds, runSlug, selectBriefs } from './lib/bench-video/briefs.mjs';
import { compareRuns, formatCompare } from './lib/bench-video/compare.mjs';
import { DEFAULT_PORT, homePaths, homeRefusal, parseCap, readMarker, runnerEnv, setupHome, STUDIO_PORT } from './lib/bench-video/home.mjs';
import { readJobFiles, sourceMetrics } from './lib/bench-video/metrics.mjs';
import { readRun, runBench } from './lib/bench-video/run.mjs';
import { call, portFree, startRunner, stopTree } from './lib/bench-video/runner.mjs';
import { scoreRun } from './lib/bench-video/score.mjs';
import { validateBench } from './lib/bench-video/validate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A run label: lower-case words joined by single hyphens, 1 to 20 characters, so `<id>-<label>` is a slug. */
const LABEL = /^(?=.{1,20}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

class Usage extends Error {}

function fail(message, code = 1) {
  process.stderr.write(`bench:video: ${message}\n`);
  process.exit(code);
}

/** This checkout and, from a linked worktree, the main checkout: both are off limits for a home. */
function repoRoots() {
  const roots = [ROOT];
  try {
    const common = execFileSync('git', ['-C', ROOT, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
    roots.push(dirname(common));
  } catch {
    // Not a git checkout: this directory alone.
  }
  return [...new Set(roots)];
}

function only(value) {
  return value === undefined ? undefined : value.split(',').map((id) => id.trim()).filter((id) => id !== '');
}

function tool(value) {
  if (!BENCH_TOOLS.includes(value)) throw new Usage(`--tool must be one of ${BENCH_TOOLS.join(', ')}`);
  return value;
}

function label(value, flag = '--label') {
  if (typeof value !== 'string' || !LABEL.test(value)) throw new Usage(`${flag} must be lower-case letters and digits joined by single hyphens, 1 to 20 characters`);
  return value;
}

function benchHome(value) {
  if (typeof value !== 'string' || value === '') throw new Usage('--home is required');
  const home = resolve(value);
  const refused = homeRefusal(home, { repoRoots: repoRoots(), userHome: homedir() });
  if (refused !== null) throw new Usage(refused);
  return home;
}

function verbValidate() {
  const entries = loadBriefs();
  const problems = validateBench(entries, loadTopics());
  for (const entry of entries) {
    process.stdout.write(`${entry.id.padEnd(26)} ${String(entry.brief?.targetSeconds).padStart(3)} s target, ${predictedSeconds(entry.brief).toFixed(1)} s predicted\n`);
  }
  if (problems.length > 0) {
    process.stderr.write(`${problems.length} problem${problems.length === 1 ? '' : 's'}:\n${problems.map((problem) => `  ${problem}`).join('\n')}\n`);
    return 1;
  }
  process.stdout.write(`${entries.length} briefs pass the bench rules and the studio's validator with ${BENCH_TOOLS.join(', ')}\n`);
  return 0;
}

async function verbSetup(args) {
  const { values } = parseArgs({ args, options: { home: { type: 'string' }, reuse: { type: 'boolean' } }, strict: true });
  const home = benchHome(values.home);
  const made = await setupHome({
    home,
    reuse: values.reuse === true,
    root: ROOT,
    repoRoots: repoRoots(),
    userHome: homedir(),
    topics: loadTopics(),
    log: (line) => process.stdout.write(`${line}\n`),
  });
  process.stdout.write(
    `bench home ready at ${made.home}\n` +
      `  catalog  ${made.db}\n` +
      `  studio   ${made.studio}\n` +
      `  topics   ${made.added.length === 0 ? 'all present' : `added ${made.added.join(', ')}`}\n`,
  );
  return 0;
}

function verbDryRun(args) {
  const { values } = parseArgs({
    args,
    options: { tool: { type: 'string' }, only: { type: 'string' }, label: { type: 'string' }, json: { type: 'boolean' }, shots: { type: 'boolean' }, critic: { type: 'boolean' } },
    strict: true,
  });
  const chosen = tool(values.tool);
  const name = label(values.label ?? 'dry');
  const entries = selectBriefs(loadBriefs(), only(values.only));
  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(entries.map((entry) => jobBody(entry, { label: name, tool: chosen })), null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`dry run: ${entries.length} brief${entries.length === 1 ? '' : 's'} on ${chosen}, label ${name}; nothing is posted or started\n`);
  for (const entry of entries) {
    process.stdout.write(`  ${entry.id.padEnd(24)} slug ${runSlug(entry.id, name).padEnd(34)} ${String(entry.brief.targetSeconds).padStart(3)} s target, ${predictedSeconds(entry.brief).toFixed(1)} s predicted\n`);
  }
  process.stdout.write(`predicted at ${FALLBACK_CHARS_PER_SECOND} characters a second, the studio's fallback; the runner uses gnosia-audio's rate\n`);
  process.stdout.write(
    values.shots === true
      ? 'shots: asked for; each brief goes to POST /api/video/shots first, and the planned brief is posted (paid, once per brief)\n'
      : 'shots: not asked for; each brief is posted as stored, with no shot plan (--shots asks for one)\n',
  );
  process.stdout.write(
    values.critic === true
      ? "critic: each landed video's own critic is read from its job, and a job with none of its build in review gets a standalone check (paid)\n"
      : "critic: each landed video's own critic is read from its job; no standalone check is asked for (--critic asks for one)\n",
  );
  return 0;
}

/**
 * The signal handling `run` and `score` share: the first SIGINT, SIGTERM or
 * SIGHUP asks the loop to stop (it cancels the running job and stops the
 * runner); a second asks the runner to cancel the job while it still
 * answers, then stops it and every process group it started.
 */
function signals(port) {
  const state = { interrupted: false, runnerPid: null, currentJob: null, cancels: true };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      if (state.interrupted) {
        if (state.runnerPid === null) process.exit(130);
        const base = `http://127.0.0.1:${port}`;
        const cancel = state.currentJob === null || !state.cancels ? Promise.resolve() : call(base, 'POST', `/api/jobs/${encodeURIComponent(state.currentJob)}/cancel`, {}, { timeoutMs: 2_000 }).catch(() => null);
        void cancel
          .then(() => stopTree(state.runnerPid, { graceMs: 2_000 }))
          .then((stopped) => {
            process.stderr.write(
              stopped.clean
                ? 'bench:video: the runner and every process group it started are stopped\n'
                : `bench:video: process groups ${stopped.survivors.join(', ')} survived SIGKILL; check them with ps -g and stop them by hand\n`,
            );
          })
          .finally(() => process.exit(130));
        return;
      }
      state.interrupted = true;
      process.stderr.write(`\nbench:video: ${signal}; ${state.cancels ? 'cancelling the running job and ' : ''}stopping the runner (again to force)\n`);
    });
  }
  return state;
}

/** `--cap` and `--port` as `run` and `score` take them, checked. */
function capAndPort(values) {
  if (values.cap === undefined) throw new Usage('--cap is required: the most this home may spend in a rolling day, in US dollars, such as --cap 10');
  const cap = parseCap(values.cap);
  if (cap === null) throw new Usage(`--cap must be a number of dollars above zero, written as digits (10 or 7.50), not "${values.cap}"`);
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Usage('--port must be a whole number from 1024 to 65535');
  if (port === STUDIO_PORT) throw new Usage(`--port ${STUDIO_PORT} is the studio's own port; the bench runs its own runner on another (default ${DEFAULT_PORT})`);
  return { cap, port };
}

async function verbScore(args) {
  const { values } = parseArgs({
    args,
    options: { home: { type: 'string' }, label: { type: 'string' }, cap: { type: 'string' }, port: { type: 'string' }, only: { type: 'string' }, again: { type: 'boolean' } },
    strict: true,
  });
  const home = benchHome(values.home);
  const name = label(values.label);
  const { cap, port } = capAndPort(values);
  if (readMarker(home) === null) throw new Usage(`${home} is not a bench home (no ${homePaths(home).marker}); run setup first`);
  const paths = homePaths(home);
  const runFile = join(paths.runs, `${name}.json`);
  if (!existsSync(runFile)) throw new Usage(`no run ${name} in this home (${runFile}); score reads a run that already exists`);

  // A standalone check cannot be cancelled through a job route, so a signal stops the runner.
  const state = signals(port);
  state.cancels = false;
  const run = await scoreRun(
    { home, label: name, cap, port, only: only(values.only), again: values.again === true, runFile },
    {
      envFor: (options) => runnerEnv(process.env, { home: options.home, port: options.port, cap: values.cap.trim() }),
      start: (env) => startRunner({ root: ROOT, env, port, logFile: join(paths.runs, `${name}.score.runner.log`), onSpawn: (pid) => (state.runnerPid = pid) }),
      call,
      portFree,
      readJob: (jobId) => readJobFiles(paths.studio, jobId),
      log: (line) => process.stdout.write(`${line}\n`),
      stopped: () => state.interrupted,
      onJob: (jobId) => (state.currentJob = jobId),
    },
  );
  const scored = run.results.filter((result) => result.state === 'accepted' && result.critic !== null && result.critic !== undefined).length;
  const accepted = run.results.filter((result) => result.state === 'accepted').length;
  process.stdout.write(`wrote ${runFile}: ${scored} of ${accepted} accepted video${accepted === 1 ? '' : 's'} have a critic recorded${run.scoring?.stopReason === undefined ? '' : `; stopped: ${run.scoring.stopReason}`}\n`);
  return state.interrupted ? 130 : run.scoring?.stopReason === undefined ? 0 : 1;
}

async function verbRun(args) {
  const { values } = parseArgs({
    args,
    options: {
      home: { type: 'string' },
      label: { type: 'string' },
      tool: { type: 'string' },
      model: { type: 'string' },
      only: { type: 'string' },
      cap: { type: 'string' },
      port: { type: 'string' },
      'keep-going': { type: 'boolean' },
      resume: { type: 'boolean' },
      shots: { type: 'boolean' },
      critic: { type: 'boolean' },
    },
    strict: true,
  });
  const home = benchHome(values.home);
  const name = label(values.label);
  const chosen = tool(values.tool);
  const { cap, port } = capAndPort(values);
  const model = values.model ?? null;
  if (model !== null && !isAgentModel(model)) throw new Usage(`--model "${model}" is not a model name the claude CLI takes`);
  if (readMarker(home) === null) throw new Usage(`${home} is not a bench home (no ${homePaths(home).marker}); run setup first`);

  const entries = selectBriefs(loadBriefs(), only(values.only));
  const paths = homePaths(home);
  const runFile = join(paths.runs, `${name}.json`);
  if (existsSync(runFile) && values.resume !== true) throw new Usage(`${runFile} already exists; pass --resume to carry on with it, or pick another --label`);

  // manimkc scenes star-import its library; the scanner needs its names to
  // count their helpers, read from the checkout the runner uses.
  let libraryNames;
  if (chosen === 'manimkc') {
    const { manimkcLibraryNames } = await import('../services/catalog/src/index/ingredients-scan.ts');
    libraryNames = (await manimkcLibraryNames(process.env.MANIMKC_ROOT?.trim() || join(ROOT, 'tools', 'manimkc'))) ?? undefined;
  }

  const state = signals(port);
  const run = await runBench(
    {
      home,
      label: name,
      tool: chosen,
      model,
      cap,
      port,
      keepGoing: values['keep-going'] === true,
      resume: values.resume === true,
      shots: values.shots === true,
      critic: values.critic === true,
      entries,
      runFile,
    },
    {
      envFor: (options) => runnerEnv(process.env, { home: options.home, port: options.port, cap: values.cap.trim() }),
      start: (env) => startRunner({ root: ROOT, env, port, logFile: join(paths.runs, `${name}.runner.log`), onSpawn: (pid) => (state.runnerPid = pid) }),
      call,
      portFree,
      readJob: (jobId) => readJobFiles(paths.studio, jobId),
      metrics: (jobId) => sourceMetrics(paths.studio, jobId, chosen, libraryNames),
      log: (line) => process.stdout.write(`${line}\n`),
      stopped: () => state.interrupted,
      onJob: (jobId) => (state.currentJob = jobId),
    },
  );
  const settled = run.results.filter((result) => ['accepted', 'failed', 'cancelled'].includes(result.state)).length;
  process.stdout.write(`wrote ${runFile}: ${settled} of ${run.results.length} recorded brief${run.results.length === 1 ? '' : 's'} settled${run.stopReason === undefined ? '' : `; stopped: ${run.stopReason}`}\n`);
  return state.interrupted ? 130 : run.stopReason === undefined ? 0 : 1;
}

function verbCompare(args) {
  const { values, positionals } = parseArgs({ args, options: { home: { type: 'string' }, json: { type: 'boolean' } }, allowPositionals: true, strict: true });
  const home = benchHome(values.home);
  if (positionals.length !== 2) throw new Usage('compare takes two run labels: compare --home DIR <labelA> <labelB>');
  const [a, b] = positionals.map((value) => label(value, 'a run label'));
  const runs = [a, b].map((name) => {
    const file = join(homePaths(home).runs, `${name}.json`);
    const read = readRun(file);
    if (read === null) throw new Usage(`no run ${name} in this home (${file})`);
    return read;
  });
  const comparison = compareRuns(runs[0], runs[1]);
  process.stdout.write(values.json === true ? `${JSON.stringify(comparison, null, 2)}\n` : formatCompare(comparison));
  return 0;
}

const USAGE = `usage: npm run bench:video -- <verb>

  validate
  setup --home DIR [--reuse]
  run --home DIR --label NAME --tool ${BENCH_TOOLS.join('|')} --cap USD [--model ID] [--only id,id] [--port N]
      [--keep-going] [--resume] [--shots] [--critic]
  score --home DIR --label NAME --cap USD [--port N] [--only id,id] [--again]
  compare --home DIR <labelA> <labelB> [--json]
  dry-run --tool ${BENCH_TOOLS.join('|')} [--only id,id] [--label NAME] [--shots] [--critic] [--json]

docs/STUDIO-BENCH.md has the rest. A run and a score start paid agent sessions.`;

async function main(argv) {
  const [verb, ...rest] = argv;
  try {
    switch (verb) {
      case 'validate':
        return verbValidate();
      case 'setup':
        return await verbSetup(rest);
      case 'run':
        return await verbRun(rest);
      case 'score':
        return await verbScore(rest);
      case 'compare':
        return verbCompare(rest);
      case 'dry-run':
        return verbDryRun(rest);
      case undefined:
      case 'help':
      case '--help':
        process.stdout.write(`${USAGE}\n`);
        return verb === undefined ? 2 : 0;
      default:
        throw new Usage(`no verb "${verb}"`);
    }
  } catch (error) {
    if (error instanceof Usage || error?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || error?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' || error?.code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL') {
      process.stderr.write(`bench:video: ${error.message}\n\n${USAGE}\n`);
      return 2;
    }
    fail(error?.message ?? String(error));
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
