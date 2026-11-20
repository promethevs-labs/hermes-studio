// The bench's scratch home: where it may be, how it is built, and the
// environment a runner over it gets. Everything a bench run writes lives
// under one directory the caller names, and the checks here are what keep
// that directory away from the owner's real data and from the checkout.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { buildSeedDatabase, seedEnv } from '../app-harness.mjs';
import { exec } from '../proc.mjs';

/** The file that marks a directory as a bench home; `run` refuses a directory without it. */
export const MARKER = 'bench-home.json';

/** The owner every bench catalog call and runner serves. */
export const BENCH_OWNER = 'local';

/** The runner port a bench uses unless told otherwise. Never the studio's own 7250. */
export const DEFAULT_PORT = 7260;
export const STUDIO_PORT = 7250;

/** Where each piece of a home lives. */
export function homePaths(home) {
  return {
    home,
    db: join(home, 'catalog.db'),
    studio: join(home, 'studio'),
    runs: join(home, 'runs'),
    marker: join(home, MARKER),
  };
}

/**
 * The path with every symlink in its existing part resolved, and the part
 * that does not exist yet appended as written. So `/tmp/x` and `/private/tmp/x`
 * compare equal on macOS, and a link pointing into a real home is seen for
 * what it is even before the directory under it is made.
 */
export function realpathNearest(target) {
  const absolute = resolve(target);
  let existing = absolute;
  const rest = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  let real = existing;
  try {
    real = realpathSync(existing);
  } catch {
    // An unreadable ancestor: compare the path as written.
  }
  return join(real, ...rest);
}

function inside(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Why `dir` cannot be a bench home, or null when it can. `repoRoots` are the
 * checkouts to keep clear of (this one and the main one); `userHome` is the
 * home directory whose `.gnosia` and `.hermes` hold the owner's real catalog
 * and blobs. A directory inside any of those is refused, and so is one that
 * contains any of them, since a home that wraps a checkout or a data root
 * would put the bench's writes beside it.
 */
export function homeRefusal(dir, { repoRoots, userHome }) {
  if (typeof dir !== 'string' || dir.trim() === '') return '--home is required: the directory the scratch catalog and studio state go in';
  const candidates = [resolve(dir), realpathNearest(dir)];
  const guarded = [
    ...repoRoots.map((root) => ({ root, why: 'the repository checkout' })),
    { root: join(userHome, '.gnosia'), why: 'the owner’s real data root (~/.gnosia)' },
    { root: join(userHome, '.hermes'), why: 'the owner’s data root (~/.hermes)' },
  ].flatMap(({ root, why }) => [{ root: resolve(root), why }, { root: realpathNearest(root), why }]);
  for (const candidate of candidates) {
    for (const { root, why } of guarded) {
      if (inside(candidate, root)) return `${dir} is inside ${why} (${root}); put the bench home somewhere else, such as a directory under /tmp`;
      if (inside(root, candidate)) return `${dir} contains ${why} (${root}); put the bench home somewhere else, such as a directory under /tmp`;
    }
  }
  return null;
}

/** The environment every catalog command against a bench home runs with: the seed harness's, pointed at the home. */
export function catalogEnv(callerEnv, { root, home, emptyRoot }) {
  const env = { ...callerEnv, ...seedEnv({ root, db: homePaths(home).db, home, emptyRoot }), GNOSIA_HOME: home };
  // The bench catalog is a primary; the copy flag is for throwaway copies.
  delete env.CATALOG_COPY_OK;
  return env;
}

/** A cap as `STUDIO_DAILY_USD` reads it: digits with an optional fraction, above zero. Null when it is not one. */
export function parseCap(raw) {
  if (typeof raw !== 'string' || !/^\d+(\.\d+)?$/.test(raw.trim())) return null;
  const value = Number.parseFloat(raw.trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The environment the bench's own runner starts with: the caller's, so the
 * tool roots and anything else the caller set pass through, with the home's
 * catalog, blob store, studio state, port, owner and cap laid over it.
 * `AUTH_SECRET` is a fresh value so the runner never asks the web app's
 * environment for one, which would also hand it the web app's catalog file.
 */
export function runnerEnv(callerEnv, { home, port, cap, secret = randomBytes(32).toString('hex') }) {
  const paths = homePaths(home);
  const env = { ...callerEnv };
  delete env.CATALOG_COPY_OK;
  Object.assign(env, {
    CATALOG_DB: paths.db,
    DATABASE_URL: paths.db,
    HERMES_HOME: home,
    GNOSIA_HOME: home,
    STUDIO_HOME: paths.studio,
    STUDIO_PORT: String(port),
    STUDIO_OWNER: BENCH_OWNER,
    STUDIO_DAILY_USD: String(cap),
    AUTH_SECRET: secret,
  });
  return env;
}

/** The marker's contents, or null when `home` is not a bench home. */
export function readMarker(home) {
  try {
    return JSON.parse(readFileSync(homePaths(home).marker, 'utf8'));
  } catch {
    return null;
  }
}

/** Write a JSON file whole or not at all. */
export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, file);
}

/** One `npm run --silent catalog -- ...`, with its output, or a thrown error naming it. */
async function catalog(root, env, args) {
  const ran = await exec('npm', ['run', '--silent', 'catalog', '--', ...args], { env, cwd: root });
  if (ran.status !== 0) throw new Error(`\`catalog ${args.join(' ')}\` failed (${ran.status}): ${(ran.stderr || ran.stdout).trim().slice(-600)}`);
  return ran.stdout;
}

/**
 * Build a bench home: refuse a forbidden place, refuse a home that already
 * holds a catalog unless `reuse`, then migrate, import seed/ and flip it (the
 * e2e harness's build), add the bench topics that are missing, and write the
 * marker. With `reuse` and a catalog present, only the migration and the
 * topics run. `run` is the catalog command runner, for the tests.
 */
export async function setupHome({ home, reuse = false, root, repoRoots, userHome, topics, callerEnv = process.env, log = () => {}, run = catalog, build = buildSeedDatabase }) {
  const refused = homeRefusal(home, { repoRoots, userHome });
  if (refused !== null) throw new Error(refused);
  const paths = homePaths(resolve(home));
  const had = existsSync(paths.db);
  if (had && !reuse) throw new Error(`${paths.db} already exists; pass --reuse to add the bench topics to it, or name a new --home`);
  mkdirSync(paths.studio, { recursive: true });
  mkdirSync(paths.runs, { recursive: true });
  // An empty directory standing in for every video tool's checkout, so the
  // seed import runs none of them (app-harness.mjs says why).
  const emptyRoot = join(paths.home, 'no-tools');
  mkdirSync(emptyRoot, { recursive: true });
  const env = catalogEnv(callerEnv, { root, home: paths.home, emptyRoot });
  if (had) {
    log(`reusing ${paths.db}: migrating`);
    await run(root, env, ['migrate']);
  } else {
    log(`building ${paths.db} from seed/: migrate, import, flip`);
    await build(root, env);
  }
  const listed = JSON.parse(await run(root, env, ['topic', 'ls', '--owner', BENCH_OWNER, '--json']));
  const present = new Set((listed.topics ?? []).map((topic) => topic.slug));
  const added = [];
  for (const topic of topics) {
    if (present.has(topic.slug)) continue;
    await run(root, env, [
      'topic', 'add',
      '--slug', topic.slug,
      '--title', topic.title,
      '--domain', topic.domain,
      ...(topic.summary === undefined ? [] : ['--summary', topic.summary]),
      '--reason', 'video bench topic (bench/video/topics.json)',
      '--owner', BENCH_OWNER,
    ]);
    added.push(topic.slug);
  }
  writeJsonAtomic(paths.marker, { kind: 'hermes-video-bench', createdAt: readMarker(paths.home)?.createdAt ?? new Date().toISOString(), repo: root });
  return { ...paths, reused: had, added };
}
