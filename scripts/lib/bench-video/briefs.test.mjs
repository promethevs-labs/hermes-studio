// The twelve stored briefs: each one passes the studio's own validator with
// the bench's vocabulary for every tool a run can name, sits in the bench's
// 60 to 75 second band, and covers a picture need no other brief covers.
import { describe, expect, it, vi } from 'vitest';

// `services/studio/src/config.ts` reads the CLI's path once, at import. Nothing
// here spawns anything, but the brief validator reaches that module.
vi.hoisted(() => {
  process.env.STUDIO_CLAUDE_BIN = '/nonexistent/claude-for-the-bench-tests';
});

const { validateVideoBrief } = await import('../../../services/studio/src/video/brief.ts');
const { BENCH_SECONDS, BENCH_TOOLS, benchProblems, jobBody, loadBriefs, loadTopics, predictedSeconds, selectBriefs, vocabularyFrom } = await import('./briefs.mjs');
const { validateBench } = await import('./validate.mjs');

const entries = loadBriefs();
const topics = loadTopics();
const binary = entries.find((entry) => entry.id === 'binary-search-halving');

describe('the bench briefs', () => {
  it('are twelve, with unique ids and unique needs', () => {
    expect(entries).toHaveLength(12);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(12);
    expect(new Set(entries.map((entry) => entry.needs.trim().toLowerCase())).size).toBe(12);
  });

  it.each(entries.map((entry) => [entry.id, entry]))('%s passes the studio validator with every tool and stays in the band', (_id, entry) => {
    const vocabulary = vocabularyFrom(topics);
    for (const tool of BENCH_TOOLS) {
      const valid = validateVideoBrief(jobBody(entry, { label: 'aaaaaaaaaaaaaaaaaaaa', tool }), vocabulary);
      expect(valid.tool).toBe(tool);
      expect(valid.voice).toBe('af_heart');
      expect(valid.audience).toBe('familiar');
      expect(valid.concepts).toEqual([]);
    }
    expect(entry.brief.targetSeconds).toBeGreaterThanOrEqual(BENCH_SECONDS.min);
    expect(entry.brief.targetSeconds).toBeLessThanOrEqual(BENCH_SECONDS.max);
    const predicted = predictedSeconds(entry.brief);
    expect(predicted).toBeGreaterThanOrEqual(BENCH_SECONDS.min);
    expect(predicted).toBeLessThanOrEqual(BENCH_SECONDS.max);
    expect(entry.brief.slug).toBe(entry.id);
    expect(entry.brief.tool).toBeUndefined();
  });

  it('pass every bench rule', () => {
    expect(validateBench(entries, topics)).toEqual([]);
  });

  it('use only the topics in topics.json, and each topic is used', () => {
    const used = new Set(entries.map((entry) => entry.brief.topic));
    expect([...used].sort()).toEqual(topics.map((topic) => topic.slug).sort());
  });
});

describe('benchProblems', () => {
  const base = binary;
  const variant = (change) => {
    const copy = structuredClone(base);
    change(copy);
    return copy;
  };

  it('names a show line that says how to draw it', () => {
    const drawn = variant((copy) => {
      copy.brief.scenes[0].beats[0].show = 'The boxes fade in one by one, drawn with manim.';
    });
    expect(benchProblems([drawn], topics)).toEqual([expect.stringMatching(/show names "manim"/)]);
    // "between" is not "tween".
    const between = variant((copy) => {
      copy.brief.scenes[0].beats[0].show = 'An arrow appears between the two boxes.';
    });
    expect(benchProblems([between], topics)).toEqual([]);
  });

  it('names a repeated id or need, a slug that is not the id, a tool, a silent voice and a length outside the band', () => {
    const twin = variant((copy) => {
      copy.file = undefined;
    });
    const bad = variant((copy) => {
      copy.file = undefined;
      copy.id = 'another-id';
      copy.brief.tool = 'manimkc';
      copy.brief.voice = 'none';
      copy.brief.targetSeconds = 90;
      copy.brief.scenes = copy.brief.scenes.slice(0, 1);
    });
    const problems = benchProblems([{ ...base, file: undefined }, twin, bad], topics);
    expect(problems).toEqual([
      expect.stringMatching(/the id binary-search-halving is also used/),
      expect.stringMatching(/its "needs" repeats/),
      expect.stringMatching(/its "needs" repeats/),
      expect.stringMatching(/slug must equal the id/),
      expect.stringMatching(/must not name "tool"/),
      expect.stringMatching(/a bench brief is narrated/),
      expect.stringMatching(/targetSeconds must be 60 to 75/),
      expect.stringMatching(/the lines predict .* outside 60 to 75 s/),
    ]);
  });
});

describe('selectBriefs and jobBody', () => {
  it('keeps id order, and refuses an id that is not a brief', () => {
    expect(selectBriefs(entries, ['tcp-versus-udp', 'bfs-frontier']).map((entry) => entry.id)).toEqual(['bfs-frontier', 'tcp-versus-udp']);
    expect(selectBriefs(entries, undefined)).toHaveLength(12);
    expect(() => selectBriefs(entries, ['no-such-brief'])).toThrow(/no bench brief named no-such-brief/);
  });

  it('posts the stored brief under the run slug, with the tool, the model and a key per attempt', () => {
    const body = jobBody(binary, { label: 'art', tool: 'revideokc', model: 'opus', attempt: 2 });
    expect(body).toMatchObject({ kind: 'video', slug: 'binary-search-halving-art', tool: 'revideokc', model: 'opus', idempotencyKey: 'bench-video:art:binary-search-halving:2', mode: 'new' });
    expect(body.scenes).toEqual(binary.brief.scenes);
    expect('model' in jobBody(binary, { label: 'art', tool: 'manimkc' })).toBe(false);
  });
});
