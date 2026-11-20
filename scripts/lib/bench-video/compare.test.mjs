// `bench:video compare` on two fixture runs: the exact text, the width, the
// briefs only one run has, and a critic score joining the look table.
import { describe, expect, it } from 'vitest';

import { compareRuns, formatCompare, lookColumns } from './compare.mjs';

const result = (id, metrics, extra = {}) => ({ id, jobId: `j-${id}`, state: 'accepted', gateOk: true, attempts: 1, turns: 30, costUsd: 2.4, wallSeconds: 720, renderSeconds: 90, metrics, error: null, ...extra });

const A = {
  label: 'base',
  tool: 'manimkc',
  model: 'sonnet',
  manualHashes: ['0123456789abcdef'],
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
  results: [
    result('binary-search-halving', { variety: 0.72, helperTop5Share: 0.55, fadeShare: 0.2, uses3d: true }, { turns: 41, costUsd: 2.95, wallSeconds: 840 }),
    result('tcp-three-way-handshake', { variety: 0.66, helperTop5Share: 0.7, fadeShare: 0.3, uses3d: false }, { attempts: 2, turns: 60, costUsd: 3.1, wallSeconds: 1200 }),
    result('memory-hierarchy-layers', { variety: 0.7, helperTop5Share: 0.5, fadeShare: 0.1, uses3d: true }),
  ],
};

const EXPECTED = `Video bench: base against art, 2 briefs in both
  A is base: manimkc, model sonnet, 3 results, manual 0123456789ab
  B is art: manimkc, model sonnet, 3 results, manual fedcba987654

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

  it('adds a column for each critic score a result carries', () => {
    const scored = structuredClone(B);
    scored.results[0].critic = { clarity: 0.8 };
    expect(lookColumns(A, scored).map((column) => column.key)).toEqual(['variety', 'helperTop5Share', 'fadeShare', 'critic.clarity']);
    const comparison = compareRuns(A, scored);
    expect(comparison.rows[0].b['critic.clarity']).toBe(0.8);
    expect(comparison.rows[0].a['critic.clarity']).toBeNull();
    expect(formatCompare(comparison).split('\n')[5]).toContain('clarity');
  });
});
