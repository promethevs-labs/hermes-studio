// The bench's runner: the studio started as a child over a scratch home, and
// the HTTP calls the bench makes to it. The calls go through node:http rather
// than fetch so every header the studio's guard reads is the bench's own
// choice: Host `127.0.0.1:<port>`, no Origin, no Sec-Fetch-*, and a JSON
// content type on every POST (services/studio/src/api.ts, `guard`).
import { spawn } from 'node:child_process';
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

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

/**
 * Stop a runner's whole process group and wait until nothing in it answers.
 * SIGTERM first, which the runner drains on (it stops the running agent and
 * writes its records), then SIGKILL after `graceMs`. The group, not the pid:
 * the runner's agents and renders are its children, and killing the leader
 * alone leaves them running (services/studio/src/proc.ts, `stopChild`).
 * False when the group survived SIGKILL.
 */
export async function stopGroup(pid, { graceMs = 45_000 } = {}) {
  for (const [signal, wait] of [['SIGTERM', graceMs], ['SIGKILL', 5_000]]) {
    if (!groupAlive(pid)) return true;
    signalGroup(pid, signal);
    const until = Date.now() + wait;
    while (groupAlive(pid) && Date.now() < until) await sleep(100);
  }
  return !groupAlive(pid);
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
 * `/api/health` answers 200. Resolves with `{ base, pid, stop }`. `onSpawn`
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
  const stop = () => stopGroup(child.pid);
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
