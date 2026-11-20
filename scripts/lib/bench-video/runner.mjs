// The bench's runner: the studio started as a child over a scratch home, and
// the HTTP calls the bench makes to it. The calls go through node:http rather
// than fetch so every header the studio's guard reads is the bench's own
// choice: Host `127.0.0.1:<port>`, no Origin, no Sec-Fetch-*, and a JSON
// content type on every POST (services/studio/src/api.ts, `guard`).
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One request to a runner at `base` (`http://127.0.0.1:<port>`), answered as
 * `{ status, json, text }`. A connection failure rejects. `timeoutMs` bounds
 * the whole exchange; an accept that lands a video can take minutes.
 */
export function call(base, method, path, body = undefined, { timeoutMs = 60_000 } = {}) {
  const url = new URL(path, base);
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          host: `${url.hostname}:${url.port}`,
          accept: 'application/json',
          ...(payload === null ? {} : { 'content-type': 'application/json', 'content-length': payload.length }),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text === '' ? null : JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, json, text });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`${method} ${path} took longer than ${Math.round(timeoutMs / 1000)} s`)));
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** Whether nothing listens on 127.0.0.1:`port`, so a runner the bench starts there is the one it talks to. */
export function portFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/** Every live process as `{ pid, ppid, pgid }`, zombies left out; null when `ps` cannot be run. */
export function processTable() {
  let text;
  try {
    text = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
  const rows = [];
  for (const line of text.split('\n')) {
    const [pid, ppid, pgid, stat = ''] = line.trim().split(/\s+/);
    if (pid === undefined || pid === '' || stat.startsWith('Z')) continue;
    rows.push({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid) });
  }
  return rows;
}

/**
 * Add to `groups` the process group of every process under `rootPid`, and of
 * everything under a member of a group already in it. The runner's agents
 * and renders each lead a group of their own (`spawnClaude` in
 * services/studio/src/agent/agent.ts and `run` in services/studio/src/proc.ts
 * spawn detached), so signalling the runner's group never reaches them. A
 * detached child keeps the runner as its parent until the runner dies, so the
 * walk has to happen while the runner is alive; and it is repeated while the
 * runner drains, so an agent started in the meantime is caught too. The
 * bench's own group and the system's are never added.
 */
export function collectGroups(rootPid, groups, table = processTable()) {
  if (table === null) {
    groups.add(rootPid);
    return groups;
  }
  const own = table.find((row) => row.pid === process.pid)?.pgid ?? null;
  const children = new Map();
  for (const row of table) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }
  const seeds = [rootPid, ...table.filter((row) => groups.has(row.pgid)).map((row) => row.pid)];
  const seen = new Set();
  const stack = [...seeds];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of children.get(pid) ?? []) stack.push(child);
  }
  groups.add(rootPid);
  for (const row of table) {
    if (seen.has(row.pid) && row.pgid > 1 && row.pgid !== own) groups.add(row.pgid);
  }
  return groups;
}

/** Whether anything alive is in group `pgid`: from `ps` when it runs, else `kill(-pgid, 0)`. */
function groupAlive(pgid, table = processTable()) {
  if (table !== null) return table.some((row) => row.pgid === pgid);
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
  } catch {
    // Already gone.
  }
}

/**
 * Stop a runner and everything it started, and say whether anything is left.
 *
 * 1. Walk the process table from the runner's pid and note the group of every
 *    process under it: the runner's own, and each agent's and render's.
 * 2. SIGTERM the runner's group, which the runner drains on (it stops its
 *    agents and writes its records), and wait up to `graceMs`, walking the
 *    table again on every poll so a group started meanwhile is noted.
 * 3. Then, whatever the runner did, SIGTERM every noted group still alive,
 *    SIGKILL after five seconds what is left, and poll each group, not only
 *    the runner's: the runner's exit is not proof its agents stopped.
 *
 * Resolves `{ clean, survivors }`: the noted groups still alive at the end.
 */
export async function stopTree(pid, { graceMs = 45_000, pollMs = 250 } = {}) {
  const groups = collectGroups(pid, new Set());
  const alive = () => {
    const table = processTable();
    return [...groups].filter((pgid) => groupAlive(pgid, table));
  };
  signalGroup(pid, 'SIGTERM');
  const drained = Date.now() + graceMs;
  while (Date.now() < drained) {
    const table = processTable();
    if (groupAlive(pid, table)) collectGroups(pid, groups, table);
    else break;
    await sleep(pollMs);
  }
  for (const [signal, wait] of [['SIGTERM', 5_000], ['SIGKILL', 5_000]]) {
    const left = alive();
    if (left.length === 0) return { clean: true, survivors: [] };
    for (const pgid of left) signalGroup(pgid, signal);
    const until = Date.now() + wait;
    while (alive().length > 0 && Date.now() < until) await sleep(pollMs);
  }
  const survivors = alive();
  return { clean: survivors.length === 0, survivors };
}

function tail(file, lines = 25) {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

/**
 * Start the studio runner from `root` as a child in its own process group,
 * with `env` (runnerEnv) and its output in `logFile`, and resolve once
 * `/api/health` answers 200. Resolves with `{ base, pid, stop }`, where `stop`
 * is `stopTree` on the runner. `onSpawn`
 * gets the pid the moment it exists, so a signal during the start can stop it.
 */
export async function startRunner({ root, env, port, logFile, onSpawn = () => {}, startMs = 180_000 }) {
  const log = openSync(logFile, 'a');
  const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'services', 'studio', 'src', 'index.ts')], {
    cwd: root,
    env,
    detached: true,
    stdio: ['ignore', log, log],
  });
  closeSync(log);
  onSpawn(child.pid);
  let exited = null;
  child.once('exit', (code, signal) => {
    exited = { code, signal };
  });
  const base = `http://127.0.0.1:${port}`;
  const stop = (options) => stopTree(child.pid, options);
  const until = Date.now() + startMs;
  for (;;) {
    if (exited !== null) throw new Error(`the runner exited (${exited.code ?? exited.signal}) before answering. Its log:\n${tail(logFile)}`);
    const answer = await call(base, 'GET', '/api/health', undefined, { timeoutMs: 30_000 }).catch(() => null);
    if (answer !== null && answer.status === 200) return { base, pid: child.pid, stop };
    if (Date.now() > until) {
      await stop();
      throw new Error(`the runner did not answer /api/health within ${Math.round(startMs / 1000)} s. Its log:\n${tail(logFile)}`);
    }
    await sleep(1_000);
  }
}
