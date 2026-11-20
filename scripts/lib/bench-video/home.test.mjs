// Where a bench home may be, what setup refuses, and the environment a bench
// runner gets. Everything is made under the OS temp directory; the catalog
// commands setup would run are injected, so no database is built here.
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { homeRefusal, parseCap, readMarker, runnerEnv, setupHome } from './home.mjs';

let dir;
let userHome;
let repo;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bench-home-test-'));
  userHome = join(dir, 'user');
  repo = join(dir, 'checkout');
  mkdirSync(join(userHome, '.gnosia'), { recursive: true });
  mkdirSync(join(userHome, '.hermes'), { recursive: true });
  mkdirSync(repo, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const where = () => ({ repoRoots: [repo], userHome });

describe('homeRefusal', () => {
  it('refuses a home inside the checkout, ~/.gnosia or ~/.hermes, or one that contains them', () => {
    expect(homeRefusal(join(repo, 'bench'), where())).toMatch(/inside the repository checkout/);
    expect(homeRefusal(repo, where())).toMatch(/inside the repository checkout/);
    expect(homeRefusal(join(userHome, '.gnosia', 'bench'), where())).toMatch(/real data root \(~\/\.gnosia\)/);
    expect(homeRefusal(join(userHome, '.hermes', 'x', 'y'), where())).toMatch(/data root \(~\/\.hermes\)/);
    expect(homeRefusal(userHome, where())).toMatch(/contains the owner/);
    expect(homeRefusal(dir, where())).toMatch(/contains the repository checkout/);
    expect(homeRefusal('', where())).toMatch(/--home is required/);
  });

  it('sees through a symlink that points into a data root', () => {
    const link = join(dir, 'innocent');
    symlinkSync(join(userHome, '.gnosia'), link);
    expect(homeRefusal(join(link, 'bench'), where())).toMatch(/~\/\.gnosia/);
  });

  it('accepts a directory elsewhere, made or not', () => {
    expect(homeRefusal(join(dir, 'elsewhere', 'bench'), where())).toBeNull();
  });
});

describe('setupHome', () => {
  const topics = [
    { slug: 'computer-networks', title: 'Computer networks', domain: 'networking', summary: 'How machines talk.' },
    { slug: 'computer-systems', title: 'Computer systems', domain: 'computer-architecture' },
  ];

  /** The catalog commands, recorded; `topic ls` answers with one bench topic already present. */
  function fakeCatalog() {
    const calls = [];
    return {
      calls,
      run: async (_root, env, args) => {
        calls.push({ args, env });
        return args[0] === 'topic' && args[1] === 'ls' ? JSON.stringify({ topics: [{ slug: 'computer-networks' }] }) : '';
      },
      build: async (_root, env) => {
        calls.push({ args: ['build'], env });
        writeFileSync(env.CATALOG_DB, '');
      },
    };
  }

  it('refuses a forbidden place before writing anything', async () => {
    const fake = fakeCatalog();
    await expect(setupHome({ home: join(userHome, '.gnosia', 'bench'), root: repo, ...where(), topics, ...fake })).rejects.toThrow(/~\/\.gnosia/);
    expect(fake.calls).toEqual([]);
    expect(existsSync(join(userHome, '.gnosia', 'bench'))).toBe(false);
  });

  it('builds a home, adds the missing topics, and writes the marker', async () => {
    const fake = fakeCatalog();
    const home = join(dir, 'bench');
    const made = await setupHome({ home, root: repo, ...where(), topics, callerEnv: { CATALOG_COPY_OK: '1', HERMES_HOME: join(userHome, '.gnosia') }, ...fake });
    expect(made.added).toEqual(['computer-systems']);
    expect(fake.calls.map((call) => call.args.slice(0, 2))).toEqual([['build'], ['topic', 'ls'], ['topic', 'add']]);
    const add = fake.calls[2].args;
    expect(add).toEqual(['topic', 'add', '--slug', 'computer-systems', '--title', 'Computer systems', '--domain', 'computer-architecture', '--reason', 'video bench topic (bench/video/topics.json)', '--owner', 'local']);
    // Every catalog command runs against the home, never the caller's data root, and as a primary.
    for (const { env } of fake.calls) {
      expect(env.CATALOG_DB).toBe(join(home, 'catalog.db'));
      expect(env.HERMES_HOME).toBe(home);
      expect(env.GNOSIA_HOME).toBe(home);
      expect(env.CATALOG_COPY_OK).toBeUndefined();
      expect(env.MANIMKC_ROOT).toBe(join(home, 'no-tools'));
    }
    expect(readMarker(home)).toMatchObject({ kind: 'hermes-video-bench' });
    expect(existsSync(join(home, 'studio'))).toBe(true);
  });

  it('refuses a home that already holds a catalog, unless --reuse, which only migrates', async () => {
    const home = join(dir, 'bench');
    mkdirSync(home);
    writeFileSync(join(home, 'catalog.db'), '');
    const fake = fakeCatalog();
    await expect(setupHome({ home, root: repo, ...where(), topics, ...fake })).rejects.toThrow(/already exists; pass --reuse/);
    expect(fake.calls).toEqual([]);
    const reused = await setupHome({ home, reuse: true, root: repo, ...where(), topics, ...fake });
    expect(reused.reused).toBe(true);
    expect(fake.calls.map((call) => call.args[0])).toEqual(['migrate', 'topic', 'topic']);
  });
});

describe('runnerEnv and parseCap', () => {
  it('lays the home, port, owner and cap over the caller environment, keeping the tool roots', () => {
    const env = runnerEnv(
      { MANIMKC_ROOT: '/main/tools/manimkc', REVIDEOKC_ROOT: '/main/tools/revideokc', CATALOG_COPY_OK: '1', HERMES_HOME: '/Users/x/.gnosia', CATALOG_DB: '/Users/x/.gnosia/catalog.db' },
      { home: '/tmp/bench', port: 7261, cap: '12.5', secret: 's'.repeat(64) },
    );
    expect(env).toMatchObject({
      MANIMKC_ROOT: '/main/tools/manimkc',
      REVIDEOKC_ROOT: '/main/tools/revideokc',
      CATALOG_DB: '/tmp/bench/catalog.db',
      DATABASE_URL: '/tmp/bench/catalog.db',
      HERMES_HOME: '/tmp/bench',
      GNOSIA_HOME: '/tmp/bench',
      STUDIO_HOME: '/tmp/bench/studio',
      STUDIO_PORT: '7261',
      STUDIO_OWNER: 'local',
      STUDIO_DAILY_USD: '12.5',
      AUTH_SECRET: 's'.repeat(64),
    });
    expect(env.CATALOG_COPY_OK).toBeUndefined();
    expect(runnerEnv({}, { home: '/tmp/bench', port: 7260, cap: '1' }).AUTH_SECRET).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads a cap the way STUDIO_DAILY_USD does, and nothing else', () => {
    expect(parseCap('10')).toBe(10);
    expect(parseCap('7.50')).toBe(7.5);
    for (const bad of ['0', '0.0', '-1', '1e3', '0.2oops', '', ' ', '$5']) expect(parseCap(bad)).toBeNull();
    expect(parseCap(undefined)).toBeNull();
  });
});
