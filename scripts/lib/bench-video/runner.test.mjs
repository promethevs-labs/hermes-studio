// The bench's stop against real processes: a stand-in runner that starts a
// detached grandchild in a process group of its own, as the studio runner
// starts each agent (`spawnClaude`, `detached: true`). Signalling the
// runner's group alone never reaches that grandchild; `stopTree` has to.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectGroups, processTable, stopTree } from './runner.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The runner stand-in: optionally deaf to SIGTERM, with a grandchild that is too when asked. */
const RUNNER = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const [pidFile, runnerDeaf, childDeaf] = process.argv.slice(2);
if (runnerDeaf === '1') process.on('SIGTERM', () => {});
const child = spawn(process.execPath, ['-e', (childDeaf === '1' ? "process.on('SIGTERM', () => {});" : '') + 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
fs.writeFileSync(pidFile, String(child.pid));
setInterval(() => {}, 1000);
`;

let dir;
const started = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bench-stop-'));
  writeFileSync(join(dir, 'runner.cjs'), RUNNER);
});

afterEach(() => {
  // Whatever a failing test left behind goes, so no stray process outlives the suite.
  for (const pid of started.splice(0)) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        // Gone already.
      }
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

async function startStandIn({ runnerDeaf, childDeaf }) {
  const pidFile = join(dir, 'grandchild.pid');
  const runner = spawn(process.execPath, [join(dir, 'runner.cjs'), pidFile, runnerDeaf ? '1' : '0', childDeaf ? '1' : '0'], { detached: true, stdio: 'ignore' });
  started.push(runner.pid);
  const until = Date.now() + 10_000;
  while (!existsSync(pidFile) || readFileSync(pidFile, 'utf8') === '') {
    if (Date.now() > until) throw new Error('the stand-in runner did not start its grandchild');
    await sleep(25);
  }
  const grandchild = Number(readFileSync(pidFile, 'utf8'));
  started.push(grandchild);
  return { runner: runner.pid, grandchild };
}

const groupOf = (pid) => processTable()?.find((row) => row.pid === pid)?.pgid ?? null;
const running = (pid) => processTable()?.some((row) => row.pid === pid) === true;

describe('stopTree', () => {
  it.each([
    ['a runner that exits at once and leaves its agent running', { runnerDeaf: false, childDeaf: false }],
    ['a runner and an agent that both ignore SIGTERM', { runnerDeaf: true, childDeaf: true }],
  ])('stops %s, and checks the agent is gone', async (_name, behaviour) => {
    const { runner, grandchild } = await startStandIn(behaviour);
    // The grandchild leads a group of its own, as a studio agent does.
    expect(groupOf(grandchild)).toBe(grandchild);
    expect(groupOf(runner)).toBe(runner);

    const stopped = await stopTree(runner, { graceMs: 500, pollMs: 50 });
    expect(stopped).toEqual({ clean: true, survivors: [] });
    expect(running(runner)).toBe(false);
    expect(running(grandchild)).toBe(false);
  }, 30_000);
});

describe('collectGroups', () => {
  it('takes every group under the runner and under a noted group, never the bench own or the system', () => {
    const table = [
      { pid: process.pid, ppid: 1, pgid: 900 },
      { pid: 10, ppid: process.pid, pgid: 10 },
      { pid: 11, ppid: 10, pgid: 11 },
      { pid: 12, ppid: 11, pgid: 11 },
      { pid: 13, ppid: 10, pgid: 900 },
      { pid: 14, ppid: 1, pgid: 11 },
      { pid: 15, ppid: 14, pgid: 15 },
      { pid: 16, ppid: 10, pgid: 1 },
      { pid: 20, ppid: 1, pgid: 20 },
    ];
    expect([...collectGroups(10, new Set(), table)].sort((a, b) => a - b)).toEqual([10, 11]);
    // Once 11 is noted, a process reparented out of it still leads to its children's groups.
    expect([...collectGroups(10, new Set([11]), table)].sort((a, b) => a - b)).toEqual([10, 11, 15]);
  });
});
