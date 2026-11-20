// `bench:video compare` on two fixture runs: the exact text, the width, the
// briefs only one run has, and a critic score joining the look table.
import { describe, expect, it } from 'vitest';

import { passesCritic } from '@hermes/schema/shared';

import { compareRuns, formatCompare, lookColumns } from './compare.mjs';

const result = (id, metrics, extra = {}) => ({ id, jobId: `j-${id}`, state: 'accepted', gateOk: true, attempts: 1, turns: 30, costUsd: 2.4, wallSeconds: 720, renderSeconds: 90, metrics, error: null, ...extra });

const A = {
  label: 'base',
  tool: 'manimkc',
  model: 'sonnet',
  manualHashes: ['0123456789abcdef'],
  manualVersions: ['aaaa0000aaaa0000'],
  results: [
    result('binary-search-halving', { variety: 0.61, helperTop5Share: 0.8, fadeShare: 0.45, uses3d: false }),
    result('tcp-three-way-handshake', { variety: 0.5, helperTop5Share: 0.9, fadeShare: 0.6, uses3d: false }, { gateOk: false, attempts: 3, turns: 88, costUsd: 3.6, wallSeconds: 1500 }),
    result('dominant-term', null, { state: 'failed', gateOk: false, costUsd: 1.1 }),
  ],
};

const B = {
  label: 'art',
  tool: 'manimkc',
  model: 'sonnet',
  manualHashes: ['fedcba9876543210'],
  manualVersions: ['bbbb1111bbbb1111', 'cccc2222cccc2222'],
  results: [
    result('binary-search-halving', { variety: 0.72, helperTop5Share: 0.55, fadeShare: 0.2, uses3d: true }, { turns: 41, costUsd: 2.95, wallSeconds: 840 }),
    result('tcp-three-way-handshake', { variety: 0.66, helperTop5Share: 0.7, fadeShare: 0.3, uses3d: false }, { attempts: 2, turns: 60, costUsd: 3.1, wallSeconds: 1200 }),
    result('memory-hierarchy-layers', { variety: 0.7, helperTop5Share: 0.5, fadeShare: 0.1, uses3d: true }),
  ],
};

const EXPECTED = `Video bench: base against art, 2 briefs in both
  A is base: manimkc, model sonnet, 3 results, manual 0123456789ab, 1 manual version
  B is art: manimkc, model sonnet, 3 results, manual fedcba987654, 2 manual versions

Look (means over the briefs measured on both sides; 3D counts videos)
                         variety          top-five share   fade share       3D
brief                       A    B  diff     A    B  diff     A    B  diff   A   B
binary-search-halving    0.61 0.72 +0.11  0.80 0.55 -0.25  0.45 0.20 -0.25  no yes
tcp-three-way-handshake  0.50 0.66 +0.16  0.90 0.70 -0.20  0.60 0.30 -0.30  no  no
mean or total            0.55 0.69 +0.14  0.85 0.63 -0.23  0.53 0.25 -0.28   0   1
pairs in the mean                      2                2                2

Run (totals over the shared briefs on the last line; gate counts passes)
                         gate       attempts  turns         cost USD         wall min
brief                       A    B  A B diff    A   B diff     A    B  diff     A    B diff
binary-search-halving    pass pass  1 1    0   30  41  +11  2.40 2.95 +0.55  12.0 14.0 +2.0
tcp-three-way-handshake  fail pass  3 2   -1   88  60  -28  3.60 3.10 -0.50  25.0 20.0 -5.0
mean or total               1    2  4 3   -1  118 101  -17  6.00 6.05 +0.05  37.0 34.0 -3.0

Only in base, left out: dominant-term
Only in art, left out: memory-hierarchy-layers
`;

describe('compare', () => {
  it('prints the two runs side by side, exactly', () => {
    expect(formatCompare(compareRuns(A, B))).toBe(EXPECTED);
  });

  it('stays under 100 columns, in sentence case, with no em dash', () => {
    const text = formatCompare(compareRuns(A, B));
    for (const line of text.split('\n')) expect(line.length).toBeLessThan(100);
    expect(text).not.toMatch(/\u2014/);
    expect(text).not.toMatch(/\b[A-Z]{4,}\b/);
  });

  it('averages the look and sums the run over shared briefs only, and lists the rest', () => {
    const comparison = compareRuns(A, B);
    expect(comparison.rows.map((row) => row.id)).toEqual(['binary-search-halving', 'tcp-three-way-handshake']);
    expect(comparison.onlyInA).toEqual(['dominant-term']);
    expect(comparison.onlyInB).toEqual(['memory-hierarchy-layers']);
    expect(comparison.totals.a.costUsd).toBeCloseTo(6.0);
    expect(comparison.totals.b.variety).toBeCloseTo(0.69);
    expect(comparison.totals.a.gatePassed).toBe(1);
    expect(comparison.totals.b.uses3d).toBe(1);
    expect(comparison.rows[0].diff.turns).toBe(11);
  });

  it('counts what earlier attempts cost in rows, totals and differences', () => {
    const resumed = structuredClone(B);
    resumed.results[0].earlierCostUsd = 0.5;
    const comparison = compareRuns(A, resumed);
    expect(comparison.rows[0].b.costUsd).toBeCloseTo(3.45);
    expect(comparison.rows[0].diff.costUsd).toBeCloseTo(1.05);
    expect(comparison.totals.b.costUsd).toBeCloseTo(6.55);
    expect(comparison.totals.diff.costUsd).toBeCloseTo(0.55);
    const unpriced = structuredClone(B);
    unpriced.results[0].costUsd = null;
    expect(compareRuns(A, unpriced).rows[0].b.costUsd).toBeNull();
  });

  it('takes each look mean and difference over the briefs measured on both sides only, and says how many', () => {
    const missing = structuredClone(B);
    missing.results[1].metrics.variety = null;
    const comparison = compareRuns(A, missing);
    expect(comparison.totals.pairs.variety).toBe(1);
    expect(comparison.totals.pairs.fadeShare).toBe(2);
    // binary-search-halving alone: 0.61 against 0.72, not 0.555 against 0.72.
    expect(comparison.totals.a.variety).toBeCloseTo(0.61);
    expect(comparison.totals.b.variety).toBeCloseTo(0.72);
    expect(comparison.totals.diff.variety).toBeCloseTo(0.11);
    expect(formatCompare(comparison)).toMatch(/pairs in the mean\s+1\s+2\s+2\n/);
  });

  it('never averages a result that did not land into the look means', () => {
    const failed = structuredClone(B);
    failed.results[1] = { ...failed.results[1], state: 'failed', metrics: { variety: 0.97, helperTop5Share: 1, fadeShare: 0, uses3d: true } };
    const comparison = compareRuns(A, failed);
    expect(comparison.rows[1].b).toMatchObject({ variety: null, helperTop5Share: null, fadeShare: null, uses3d: null });
    expect(comparison.totals.pairs).toEqual({ variety: 1, helperTop5Share: 1, fadeShare: 1 });
    expect(comparison.totals.b.variety).toBeCloseTo(0.72);
    expect(comparison.totals.b.uses3d).toBe(1);
  });

  it('adds nothing, text or data, when neither run has critic scores or shots', () => {
    const comparison = compareRuns(A, B);
    expect(comparison.look).toEqual([
      { key: 'variety', label: 'variety', digits: 2 },
      { key: 'helperTop5Share', label: 'top-five share', digits: 2 },
      { key: 'fadeShare', label: 'fade share', digits: 2 },
    ]);
    expect(comparison.run.map((column) => column.key)).toEqual(['attempts', 'turns', 'costUsd', 'wallMinutes']);
    expect(Object.keys(comparison.rows[0].a)).not.toContain('criticPassed');
    expect(Object.keys(comparison.totals.a)).not.toContain('criticPassed');
  });
});

/** A critic record as the bench writes it (scripts/lib/bench-video/critic.mjs). */
const critic = (scores, defects = 0, extra = {}) => {
  const values = Object.values(scores);
  return {
    source: 'job',
    attempt: 1,
    current: true,
    scores,
    mean: values.reduce((total, value) => total + value, 0) / values.length,
    defects: Array.from({ length: defects }, (_, i) => ({ scene: `S${i}`, problem: 'overlap', fix: 'move it' })),
    notes: [],
    sentBack: [],
    passed: passesCritic(scores),
    error: null,
    ...extra,
  };
};
const shots = (types, costUsd = 0.3) => ({ state: 'planned', costUsd, reason: null, types, brief: { scenes: types.map((type) => ({ shot: { type } })) } });
const dims = (accuracy, layout, relevance, variety, pacing) => ({ accuracy, layout, relevance, variety, pacing });

const SCORED_B = structuredClone(B);
SCORED_B.results[0].critic = critic(dims(4, 4, 5, 3, 4));
SCORED_B.results[0].shots = shots(['title', 'array-or-memory', 'array-or-memory', 'recap-map'], 0.35);
SCORED_B.results[0].criticCostUsd = 0.2;
// A standalone check is measuring, not making: it stays out of the cost compared.
SCORED_B.results[0].checkCostUsd = 0.5;
SCORED_B.results[1].critic = critic(dims(3, 2, 4, 3, 3), 2);
SCORED_B.results[1].shots = shots(['title', 'timeline', 'comparison', 'timeline', 'recap-map'], 0.4);

const ONE_SIDE = `Video bench: base against art, 2 briefs in both
  A is base: manimkc, model sonnet, 3 results, manual 0123456789ab, 1 manual version
  B is art: manimkc, model sonnet, 3 results, manual fedcba987654, 2 manual versions

Look (means over the briefs measured on both sides; 3D counts videos)
                         variety          top-five share   fade share       3D
brief                       A    B  diff     A    B  diff     A    B  diff   A   B
binary-search-halving    0.61 0.72 +0.11  0.80 0.55 -0.25  0.45 0.20 -0.25  no yes
tcp-three-way-handshake  0.50 0.66 +0.16  0.90 0.70 -0.20  0.60 0.30 -0.30  no  no
mean or total            0.55 0.69 +0.14  0.85 0.63 -0.23  0.53 0.25 -0.28   0   1
pairs in the mean                      2                2                2

Run (totals over the shared briefs on the last line; gate counts passes)
                         gate       attempts  turns         cost USD         wall min
brief                       A    B  A B diff    A   B diff     A    B  diff     A    B diff
binary-search-halving    pass pass  1 1    0   30  41  +11  2.40 3.50 +1.10  12.0 14.0 +2.0
tcp-three-way-handshake  fail pass  3 2   -1   88  60  -28  3.60 3.50 -0.10  25.0 20.0 -5.0
mean or total               1    2  4 3   -1  118 101  -17  6.00 7.00 +1.00  37.0 34.0 -3.0

Critic and shots (means over the briefs measured on both sides; pass is the score mark, D121)
                         critic mean  pass    shot types  shots USD
brief                    A    B diff  A    B  A B   diff  A    B diff
binary-search-halving    - 4.00    -  - pass  - 3      -  - 0.35    -
tcp-three-way-handshake  - 3.00    -  - fail  - 4      -  - 0.40    -
mean or total            -    -    -  0    1  - -      -  - 0.75    -
pairs in the mean                  0                   0

Critic scores, 1 to 5 (means over the briefs scored on both sides)
                         accuracy  layout    relevance  variety   pacing
brief                    A B diff  A B diff  A B  diff  A B diff  A B diff
binary-search-halving    - 4    -  - 4    -  - 5     -  - 3    -  - 4    -
tcp-three-way-handshake  - 3    -  - 2    -  - 4     -  - 3    -  - 3    -
mean or total            - -    -  - -    -  - -     -  - -    -  - -    -
pairs in the mean               0         0          0         0         0

Only in base, left out: dominant-term
Only in art, left out: memory-hierarchy-layers
`;

describe('compare with the critic and shot plans', () => {
  it('lists each critic dimension, the mean, the pass and the shot types as columns', () => {
    expect(lookColumns(A, SCORED_B).map((column) => column.key)).toEqual([
      'variety',
      'helperTop5Share',
      'fadeShare',
      'critic.mean',
      'critic.accuracy',
      'critic.layout',
      'critic.relevance',
      'critic.variety',
      'critic.pacing',
      'shotTypes',
    ]);
  });

  it('prints them on one side only, with no pair in any mean, and counts the plan and the checks in the cost', () => {
    const comparison = compareRuns(A, SCORED_B);
    expect(formatCompare(comparison)).toBe(ONE_SIDE);
    expect(comparison.rows[0].b).toMatchObject({ 'critic.mean': 4, 'critic.relevance': 5, shotTypes: 3, shotsUsd: 0.35, criticPassed: true });
    // The job's 2.95, its shot plan's 0.35 and its picture checks' 0.20.
    expect(comparison.rows[0].b.costUsd).toBeCloseTo(3.5);
    expect(comparison.rows[0].a).toMatchObject({ 'critic.mean': null, shotTypes: null, shotsUsd: null, criticPassed: null });
    expect(comparison.totals.pairs['critic.mean']).toBe(0);
    expect(comparison.totals.b).toMatchObject({ criticPassed: 1, criticFailed: 1, shotsUsd: 0.75 });
  });

  it('pairs the means on both sides, and keeps every line under 100 columns with no em dash', () => {
    const scoredA = structuredClone(A);
    scoredA.results[0].critic = critic(dims(3, 3, 4, 2, 3), 1);
    scoredA.results[0].shots = shots(['title', 'array-or-memory', 'recap-map'], 0.25);
    const comparison = compareRuns(scoredA, SCORED_B);
    // Only binary-search-halving is scored on both sides.
    expect(comparison.totals.pairs).toMatchObject({ 'critic.mean': 1, 'critic.accuracy': 1, shotTypes: 1 });
    expect(comparison.totals.a['critic.mean']).toBeCloseTo(3);
    expect(comparison.totals.b['critic.mean']).toBeCloseTo(4);
    expect(comparison.totals.diff['critic.mean']).toBeCloseTo(1);
    expect(comparison.totals.diff['critic.variety']).toBeCloseTo(1);
    expect(comparison.totals.a.shotTypes).toBe(3);
    expect(comparison.totals.diff.shotTypes).toBe(0);
    expect(comparison.totals.a).toMatchObject({ criticPassed: 0, criticFailed: 1, shotsUsd: 0.25 });
    const text = formatCompare(comparison);
    expect(text).toMatch(/binary-search-halving    3\.00 4\.00 \+1\.00  fail pass/);
    expect(text).toMatch(/pairs in the mean\s+1\s+1\n/);
    for (const line of text.split('\n')) expect(line.length).toBeLessThan(100);
    expect(text).not.toContain(String.fromCharCode(0x2014));
    expect(text).not.toMatch(/\b[A-Z]{4,}\b/);
    const json = JSON.parse(JSON.stringify(comparison));
    expect(json.look.find((column) => column.key === 'critic.pacing')).toEqual({ key: 'critic.pacing', label: 'pacing', digits: 1, rowDigits: 0, table: 'scores' });
    expect(json.run.at(-1)).toEqual({ key: 'shotsUsd', label: 'shots USD', digits: 2, table: 'extra' });
  });

  it('judges by the scores it finds, so a run file written under the old no-defect rule is read by D121', () => {
    const old = structuredClone(SCORED_B);
    // Old rule: no defect passed, a defect failed. Now: the scores decide.
    old.results[0].critic = critic(dims(4, 4, 5, 3, 4), 3, { passed: false });
    old.results[1].critic = critic(dims(5, 2, 5, 5, 5), 0, { passed: true });
    const comparison = compareRuns(A, old);
    expect(comparison.rows[0].b.criticPassed).toBe(true);
    expect(comparison.rows[1].b.criticPassed).toBe(false);
    expect(comparison.totals.b).toMatchObject({ criticPassed: 1, criticFailed: 1 });
  });

  it('leaves out a critic of an earlier build, and one on a video that did not land', () => {
    const stale = structuredClone(SCORED_B);
    stale.results[0].critic = critic(dims(5, 5, 5, 5, 5), 0, { current: false, passed: null });
    stale.results[1] = { ...stale.results[1], state: 'failed' };
    const comparison = compareRuns(A, stale);
    expect(comparison.rows[0].b).toMatchObject({ 'critic.mean': null, criticPassed: null });
    expect(comparison.rows[1].b).toMatchObject({ 'critic.mean': null, criticPassed: null, shotTypes: 4 });
  });
});
