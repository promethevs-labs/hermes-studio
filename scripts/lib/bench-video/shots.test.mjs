// The shot plan's and the critic's records, on objects: what a route answer
// becomes on a result, and the body a planned brief is posted with.
import { describe, expect, it } from 'vitest';

import { criticFromStandalone, criticFromView, scoresMean } from './critic.mjs';
import { distinctShotTypes, plannedBody, shotsKept, shotsRecord, shotTypes } from './shots.mjs';

const scene = (type) => ({ name: type, beats: [], ...(type === null ? {} : { shot: { type } }) });

describe('shots', () => {
  it('records a plan with its types, and a plan with a hole in it as failed', () => {
    const planned = shotsRecord({ brief: { slug: 'x', scenes: [scene('title'), scene('timeline'), scene('timeline')] }, shotPlan: 'planned', costUsd: 0.31 });
    expect(planned).toMatchObject({ state: 'planned', costUsd: 0.31, reason: null, types: ['title', 'timeline', 'timeline'] });
    expect(distinctShotTypes(planned)).toBe(2);
    expect(shotsKept(planned)).toBe(true);
    const holed = shotsRecord({ brief: { scenes: [scene('title'), scene(null)] }, shotPlan: 'planned', costUsd: 0.2 });
    expect(holed).toMatchObject({ state: 'failed', costUsd: 0.2, brief: null });
    expect(shotsRecord({ brief: {}, shotPlan: 'off', costUsd: 0, reason: 'off here' })).toMatchObject({ state: 'off', reason: 'off here' });
    expect(shotsKept({ state: 'off' })).toBe(false);
    expect(shotsKept({ state: 'failed' })).toBe(true);
    expect(shotTypes({ scenes: [] })).toBeNull();
  });

  it('posts a planned brief under the run\'s own slug, tool, model and key', () => {
    const body = { kind: 'video', title: 'T', slug: 'a-base', scenes: [scene(null)], tool: 'manimkc', idempotencyKey: 'bench-video:base:a:2' };
    const shots = { state: 'planned', brief: { title: 'T', slug: 'a-base', scenes: [scene('title')], tool: 'manimkc', model: 'opus', idempotencyKey: 'bench-video:base:a:1' } };
    expect(plannedBody(body, shots)).toEqual({ kind: 'video', title: 'T', slug: 'a-base', scenes: [scene('title')], tool: 'manimkc', idempotencyKey: 'bench-video:base:a:2' });
    expect(plannedBody(body, { state: 'failed', brief: null })).toBe(body);
    expect(plannedBody(body, null)).toBe(body);
  });
});

describe('critic records', () => {
  const scores = { accuracy: 5, layout: 4, relevance: 4, variety: 3, pacing: 4 };

  it('passes a read of the build in review by its scores, and gives no verdict on an earlier build', () => {
    expect(scoresMean(scores)).toBeCloseTo(4);
    expect(criticFromView({ attempt: 2, current: true, scores, defects: [], notes: [], sentBack: [] })).toMatchObject({ current: true, passed: true, mean: 4 });
    const defect = { scene: 'S', problem: 'p', fix: 'f' };
    // D121: a defect does not fail a video, a score below 3 does.
    expect(criticFromView({ attempt: 2, current: true, scores, defects: [defect] })).toMatchObject({ passed: true, defects: [defect] });
    expect(criticFromView({ attempt: 2, current: true, scores: { ...scores, pacing: 2 }, defects: [] })).toMatchObject({ passed: false });
    expect(criticFromView({ attempt: 1, current: false, unscoredReason: 'timed out', scores, defects: [] })).toMatchObject({ current: false, passed: null, error: 'timed out' });
    expect(criticFromView(null)).toMatchObject({ scores: null, passed: null });
  });

  it('takes a standalone run\'s attempt and sent-back defects from the job view', () => {
    const sent = { scene: 'S', problem: 'p', fix: 'f' };
    const jobView = { attempt: 3, critic: { build: 2, sentBack: [sent] } };
    expect(criticFromStandalone({ scores, defects: [], notes: ['n'], costUsd: 0.1 }, jobView)).toMatchObject({ source: 'standalone', attempt: 2, current: true, passed: true, sentBack: [sent], costUsd: 0.1 });
    expect(criticFromStandalone({ scores: null, defects: [], error: 'no answer', costUsd: 0.05 }, { attempt: 3 })).toMatchObject({ attempt: 3, current: false, passed: null, error: 'no answer' });
  });
});
