// The cap arithmetic and the measuring runner's guards. No runner is started
// and nothing is spent: `start` and `call` are stand-ins.
import { describe, expect, it } from 'vitest';

import { capEnvValue, capLine, capPlan, capRecord, measureHomeSpend, money } from './budget.mjs';
import { parseCap } from './home.mjs';

describe('capEnvValue', () => {
  it('writes a cap the way STUDIO_DAILY_USD reads it', () => {
    expect(capEnvValue(50)).toBe('50');
    expect(capEnvValue(62.33)).toBe('62.33');
    expect(capEnvValue(12.33 + 50)).toBe('62.33');
    expect(capEnvValue(7.5)).toBe('7.5');
    expect(capEnvValue(0.000001)).toBe('0.000001');
    expect(capEnvValue(100)).toBe('100');
    for (const value of [50, 62.33, 7.5, 0.000001, 100, 0.1 + 0.2]) expect(parseCap(capEnvValue(value))).not.toBeNull();
  });
});

describe('capPlan', () => {
  it('is the typed cap on a fresh home', () => {
    expect(capPlan({ cap: 50, homeSpentUsd: 0 })).toEqual({ perCommandUsd: 50, labelSpentUsd: 0, allowanceUsd: 50, homeSpentUsd: 0, runnerCapUsd: 50 });
  });

  it('adds the home spend, so the run has the whole typed cap', () => {
    const plan = capPlan({ cap: 50, homeSpentUsd: 12.33 });
    expect(plan).toMatchObject({ allowanceUsd: 50, runnerCapUsd: 62.33 });
    expect(plan.runnerCapUsd - plan.homeSpentUsd).toBeCloseTo(plan.allowanceUsd);
  });

  it('takes what the label already spent off the allowance', () => {
    expect(capPlan({ cap: 50, homeSpentUsd: 12.33, labelSpentUsd: 20.5 })).toMatchObject({ allowanceUsd: 29.5, runnerCapUsd: 41.83 });
  });

  it('never lets the runner cap fall below what the home spent', () => {
    expect(capPlan({ cap: 5, homeSpentUsd: 3, labelSpentUsd: 9 }).runnerCapUsd).toBe(3);
  });

  it('records the numbers beside the existing run fields', () => {
    expect(capRecord(capPlan({ cap: 5, homeSpentUsd: 1.5, labelSpentUsd: 2 }))).toEqual({ perCommandUsd: 5, labelSpentUsd: 2, homeSpentUsd: 1.5, runnerCapUsd: 4.5 });
  });
});

describe('capLine', () => {
  it('says both numbers in plain words', () => {
    expect(money(12.3)).toBe('$12.30');
    expect(capLine(capPlan({ cap: 50, homeSpentUsd: 12.33 }), 'run', 'base')).toBe('Home has spent $12.33 in the last 24 hours; this run may spend up to $50.00 more (runner cap $62.33).');
  });

  it('says what a resume subtracts', () => {
    expect(capLine(capPlan({ cap: 50, homeSpentUsd: 12.33, labelSpentUsd: 20 }), 'run', 'base')).toBe(
      'Home has spent $12.33 in the last 24 hours; this run may spend up to $30.00 more (its $50.00 cap less the $20.00 that base already spent) (runner cap $42.33).',
    );
  });
});

describe('measureHomeSpend', () => {
  const measure = async (health) => {
    const events = [];
    const deps = {
      envFor: (options) => ({ cap: options.runnerCapUsd }),
      start: async (env) => {
        events.push(['start', env.cap]);
        return { base: 'http://127.0.0.1:1', stop: async () => (events.push(['stop']), { clean: true, survivors: [] }) };
      },
      call: async (base, method, path) => (events.push([method, path]), health),
      log: () => {},
    };
    return { events, result: await measureHomeSpend(deps, { cap: 5 }).then((total) => ({ total }), (error) => ({ error })) };
  };

  it('reads the runner\'s own total and stops the runner before it returns', async () => {
    const { events, result } = await measure({ status: 200, json: { dailyCap: { capUsd: 5, totalUsd: 12.33 } } });
    expect(result).toEqual({ total: 12.33 });
    expect(events).toEqual([['start', 5], ['GET', '/api/health'], ['stop']]);
  });

  it('refuses, with the runner stopped, when the runner gives no figure', async () => {
    for (const health of [{ status: 200, json: { dailyCap: {} } }, { status: 200, json: null }, { status: 200, json: { dailyCap: { totalUsd: -1 } } }]) {
      const { events, result } = await measure(health);
      expect(result.error?.message).toMatch(/did not say what the home has spent.*nothing was posted/);
      expect(events.at(-1)).toEqual(['stop']);
    }
    const { events, result } = await measure({ status: 500, json: null });
    expect(result.error?.message).toMatch(/answered 500/);
    expect(events.at(-1)).toEqual(['stop']);
  });
});
