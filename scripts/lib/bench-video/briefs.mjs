// The video bench's fixed inputs: the stored briefs under bench/video/briefs/
// and the topics they are filed under (docs/STUDIO-BENCH.md). Pure apart from
// the two readers, so the checks can be tested on objects.
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository's bench folder, from this file's place in scripts/lib/bench-video/. */
export const BENCH_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'bench', 'video');

/** The three studio tools a bench run can name (the studio has no blenderkc backend). */
export const BENCH_TOOLS = Object.freeze(['manimkc', 'remotionkc', 'revideokc']);

/** The length band every bench brief keeps to, so runs cost about the same per brief. */
export const BENCH_SECONDS = Object.freeze({ min: 60, max: 75 });

/** The fallback speech rate the studio uses before gnosia-audio answers (narration.ts). */
export const FALLBACK_CHARS_PER_SECOND = 15.2;

/** The finished video over the speech, as `narrationSeconds` takes it (@hermes/schema/shared). */
export const VIDEO_OVER_SPEECH = 1.08;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Words a `show` line must not use: a tool, a library or a visual style. The
 * bench measures what the agent chooses for the picture, so the brief says
 * what happens on screen and never how it is drawn.
 */
export const SHOW_BANNED = Object.freeze([
  'manim',
  'remotion',
  'revideo',
  'motion canvas',
  'blender',
  'tldraw',
  'three.js',
  'threejs',
  'helper',
  'fade',
  'style',
  'tween',
  'easing',
]);

/** Every brief file in `dir`, sorted by id: `{ file, id, needs, brief }`. */
export function loadBriefs(dir = join(BENCH_DIR, 'briefs')) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const file = join(dir, name);
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      return { file, ...parsed };
    })
    .sort((a, b) => String(a.id).localeCompare(String(b.id), 'en'));
}

/** The bench's topics: `[{ slug, title, domain, summary }]`. */
export function loadTopics(file = join(BENCH_DIR, 'topics.json')) {
  return JSON.parse(readFileSync(file, 'utf8')).topics;
}

/** The vocabulary the studio's validator takes, built from the bench topics alone. */
export function vocabularyFrom(topics) {
  return {
    topics: new Map(topics.map((topic) => [topic.slug, { title: topic.title, concepts: [] }])),
    entries: [],
    readAt: new Date(0).toISOString(),
    stale: false,
  };
}

/** Every `say` line of a brief, in play order. */
export function sayLines(brief) {
  return (brief.scenes ?? []).flatMap((scene) => (scene.beats ?? []).map((beat) => beat.say ?? ''));
}

/** Seconds of video a brief's narration predicts at `charsPerSecond`, as the studio computes it. */
export function predictedSeconds(brief, charsPerSecond = FALLBACK_CHARS_PER_SECOND) {
  const characters = sayLines(brief).reduce((sum, line) => sum + line.length, 0);
  return (characters / charsPerSecond) * VIDEO_OVER_SPEECH;
}

/**
 * The bench's own rules over every entry, beside the studio's validator:
 * ids and `needs` unique, the file named for its id, the slug equal to the id,
 * no tool or model in the brief, a target and a prediction in the bench's
 * band, topics from topics.json, and `show` lines free of tool and style
 * words. Returns a list of problems, empty when all is well.
 */
export function benchProblems(entries, topics) {
  const problems = [];
  const known = new Set(topics.map((topic) => topic.slug));
  const ids = new Map();
  const needs = new Map();
  for (const entry of entries) {
    const where = entry.file === undefined ? String(entry.id) : basename(entry.file);
    const id = entry.id;
    if (typeof id !== 'string' || !SLUG.test(id) || id.length > 39) {
      problems.push(`${where}: "id" must be a slug of at most 39 characters`);
      continue;
    }
    if (entry.file !== undefined && basename(entry.file) !== `${id}.json`) problems.push(`${where}: the file must be named ${id}.json`);
    if (ids.has(id)) problems.push(`${where}: the id ${id} is also used by ${ids.get(id)}`);
    ids.set(id, where);
    if (typeof entry.needs !== 'string' || entry.needs.trim() === '') problems.push(`${where}: "needs" must say in one line what the picture mainly needs`);
    else {
      const key = entry.needs.trim().toLowerCase();
      if (needs.has(key)) problems.push(`${where}: its "needs" repeats ${needs.get(key)}`);
      needs.set(key, where);
    }
    const brief = entry.brief;
    if (typeof brief !== 'object' || brief === null) {
      problems.push(`${where}: "brief" must be an object`);
      continue;
    }
    if (brief.slug !== id) problems.push(`${where}: the brief's slug must equal the id`);
    for (const field of ['tool', 'toolReason', 'model', 'idempotencyKey']) {
      if (brief[field] !== undefined) problems.push(`${where}: the brief must not name "${field}"; a run supplies it`);
    }
    if (!known.has(brief.topic)) problems.push(`${where}: topic "${brief.topic}" is not in bench/video/topics.json`);
    if (brief.voice === 'none') problems.push(`${where}: a bench brief is narrated`);
    if (!Number.isInteger(brief.targetSeconds) || brief.targetSeconds < BENCH_SECONDS.min || brief.targetSeconds > BENCH_SECONDS.max) {
      problems.push(`${where}: targetSeconds must be ${BENCH_SECONDS.min} to ${BENCH_SECONDS.max}`);
    }
    const predicted = predictedSeconds(brief);
    if (predicted < BENCH_SECONDS.min || predicted > BENCH_SECONDS.max) {
      problems.push(`${where}: the lines predict ${predicted.toFixed(1)} s, outside ${BENCH_SECONDS.min} to ${BENCH_SECONDS.max} s`);
    }
    for (const [i, scene] of (brief.scenes ?? []).entries()) {
      for (const [j, beat] of (scene.beats ?? []).entries()) {
        const show = String(beat.show ?? '').toLowerCase();
        const word = SHOW_BANNED.find((banned) => new RegExp(`(^|[^a-z])${banned.replaceAll('.', '\\.')}`).test(show));
        if (word !== undefined) problems.push(`${where}: scenes[${i}].beats[${j}].show names "${word}"; say what happens, not how it is drawn`);
      }
    }
  }
  return problems;
}

/**
 * The entries `--only` names, in id order, or all of them. An id that is not
 * a brief is an error rather than an empty run.
 */
export function selectBriefs(entries, only) {
  if (only === undefined || only === null || only.length === 0) return [...entries];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const unknown = only.filter((id) => !byId.has(id));
  if (unknown.length > 0) throw new Error(`no bench brief named ${unknown.join(', ')}; the ids are ${[...byId.keys()].join(', ')}`);
  return entries.filter((entry) => only.includes(entry.id));
}

/** The slug a run posts a brief under: the id and the run's label. */
export function runSlug(id, label) {
  return `${id}-${label}`;
}

/** The body `run` posts for one brief: the stored brief with the run's slug, tool, model and idempotency key. */
export function jobBody(entry, { label, tool, model = null, attempt = 1 }) {
  return {
    kind: 'video',
    ...entry.brief,
    slug: runSlug(entry.id, label),
    tool,
    ...(model === null ? {} : { model }),
    idempotencyKey: `bench-video:${label}:${entry.id}:${attempt}`,
  };
}
