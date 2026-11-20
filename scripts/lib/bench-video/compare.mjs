// `bench:video compare`: two run files side by side, per brief and in total.
// Pure: it takes the two parsed runs and returns a comparison, which the CLI
// prints as text (under 100 columns) or as JSON.
import { CRITIC_DIMENSIONS, passesCritic } from '@hermes/schema/shared';

import { knownCostOf } from './cost.mjs';
import { distinctShotTypes } from './shots.mjs';

/** A result's look metrics, only when its video landed; any other result has none to compare. */
const lookOf = (r) => (r.state === 'accepted' ? r.metrics : null);

/**
 * A result's critic, only when its video landed and the critic read the
 * build in review: an earlier build's scores do not describe the video.
 */
const criticOf = (r) => {
  const critic = r.state === 'accepted' ? r.critic : null;
  if (critic === null || typeof critic !== 'object' || critic.current === false) return null;
  return critic.scores !== null && typeof critic.scores === 'object' ? critic : null;
};

const scoreOf = (r, name) => {
  const value = criticOf(r)?.scores?.[name];
  return typeof value === 'number' ? value : null;
};

const criticMeanOf = (r) => {
  const critic = criticOf(r);
  if (critic === null) return null;
  if (typeof critic.mean === 'number') return critic.mean;
  const values = Object.values(critic.scores).filter((value) => typeof value === 'number');
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length;
};

/**
 * Each column is `{ key, label, get, digits, rowDigits?, table }`: `digits`
 * for the mean or total, `rowDigits` for one brief's figure when it differs,
 * and `table` the printed table it sits in.
 */
const BASE_LOOK = [
  { key: 'variety', label: 'variety', get: (r) => lookOf(r)?.variety ?? null, digits: 2, table: 'look' },
  { key: 'helperTop5Share', label: 'top-five share', get: (r) => lookOf(r)?.helperTop5Share ?? null, digits: 2, table: 'look' },
  { key: 'fadeShare', label: 'fade share', get: (r) => lookOf(r)?.fadeShare ?? null, digits: 2, table: 'look' },
];

/** Whether any result of these runs carries critic scores, or a shot plan. */
function present(runs) {
  const results = runs.flatMap((run) => run?.results ?? []);
  const names = new Set();
  for (const result of results) {
    const scores = result?.critic?.scores;
    if (scores === null || typeof scores !== 'object') continue;
    for (const [name, value] of Object.entries(scores)) if (typeof value === 'number') names.add(name);
  }
  const order = (name) => {
    const at = CRITIC_DIMENSIONS.indexOf(name);
    return at === -1 ? CRITIC_DIMENSIONS.length : at;
  };
  return {
    critic: [...names].sort((x, y) => order(x) - order(y) || x.localeCompare(y, 'en')),
    shots: results.some((result) => result?.shots !== null && typeof result?.shots === 'object'),
  };
}

/**
 * The look columns for these runs, each a mean over the briefs measured on
 * both sides: the scanner's three numbers; then, once any result carries
 * critic scores (`critic: { scores: { accuracy: 4, ... } }`), the critic's
 * mean and one column per dimension; then, once any result carries a shot
 * plan, the distinct shot types per video.
 */
export function lookColumns(...runs) {
  const has = present(runs);
  const critic =
    has.critic.length === 0
      ? []
      : [
          { key: 'critic.mean', label: 'critic mean', get: criticMeanOf, digits: 2, table: 'extra' },
          ...has.critic.map((name) => ({ key: `critic.${name}`, label: name, get: (r) => scoreOf(r, name), digits: 1, rowDigits: 0, table: 'scores' })),
        ];
  const shots = has.shots ? [{ key: 'shotTypes', label: 'shot types', get: (r) => distinctShotTypes(r.shots), digits: 1, rowDigits: 0, table: 'extra' }] : [];
  return [...BASE_LOOK, ...critic, ...shots];
}

/** The run numbers, per result: summed in the totals, where the look numbers are averaged. */
const RUN_COLUMNS = [
  { key: 'attempts', label: 'attempts', get: (r) => r.attempts ?? null, digits: 0, table: 'run' },
  { key: 'turns', label: 'turns', get: (r) => r.turns ?? null, digits: 0, table: 'run' },
  // Every attempt's cost, a resumed brief's earlier ones, its shot plan and its picture checks included.
  { key: 'costUsd', label: 'cost USD', get: (r) => knownCostOf(r), digits: 2, table: 'run' },
  { key: 'wallMinutes', label: 'wall min', get: (r) => (typeof r.wallSeconds === 'number' ? r.wallSeconds / 60 : null), digits: 1, table: 'run' },
];

/** The art director's cost, summed like the run numbers, once any result carries a shot plan. */
const SHOTS_COST = { key: 'shotsUsd', label: 'shots USD', get: (r) => (typeof r.shots?.costUsd === 'number' ? r.shots.costUsd : null), digits: 2, table: 'extra' };

/** The run columns for these runs. */
export function runColumns(...runs) {
  return present(runs).shots ? [...RUN_COLUMNS, SHOTS_COST] : RUN_COLUMNS;
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const diffOf = (a, b) => (a === null || b === null ? null : b - a);
const mean = (values) => {
  const kept = values.filter((value) => value !== null);
  return kept.length === 0 ? null : kept.reduce((total, value) => total + value, 0) / kept.length;
};
const sum = (values) => {
  const kept = values.filter((value) => value !== null);
  return kept.length === 0 ? null : kept.reduce((total, value) => total + value, 0);
};

/** One side of a run, as the comparison describes it. */
function describe(run) {
  return { label: run.label, tool: run.tool, model: run.model ?? null, results: (run.results ?? []).length, manualHashes: run.manualHashes ?? [], manualVersions: run.manualVersions ?? [] };
}

/** A column as the comparison lists it; `table` only for one printed outside the look and run tables. */
const columnView = ({ key, label, digits, rowDigits, table }) => ({
  key,
  label,
  digits,
  ...(rowDigits === undefined ? {} : { rowDigits }),
  ...(table === 'look' || table === 'run' ? {} : { table }),
});

/**
 * Compare run `a` with run `b`. Briefs in only one run are listed, never
 * averaged in. Returns `{ a, b, look, run, rows, totals, onlyInA, onlyInB }`,
 * where each row is `{ id, a, b, diff }` keyed by column, plus `uses3d` and
 * `gateOk` for each side (and `criticPassed` once either run has critic
 * scores), and totals are the means of the look columns over the briefs
 * measured on both sides (`totals.pairs` says how many) and the sums of the
 * run columns over the shared briefs.
 */
export function compareRuns(a, b) {
  const look = lookColumns(a, b);
  const runCols = runColumns(a, b);
  const critics = look.some((column) => column.key === 'critic.mean');
  const columns = [...look, ...runCols];
  const byId = (run) => new Map((run.results ?? []).map((result) => [result.id, result]));
  const left = byId(a);
  const right = byId(b);
  const shared = [...left.keys()].filter((id) => right.has(id)).sort((x, y) => x.localeCompare(y, 'en'));
  const rows = shared.map((id) => {
    const ra = left.get(id);
    const rb = right.get(id);
    const row = { id, a: {}, b: {}, diff: {} };
    for (const column of columns) {
      row.a[column.key] = num(column.get(ra));
      row.b[column.key] = num(column.get(rb));
      row.diff[column.key] = diffOf(row.a[column.key], row.b[column.key]);
    }
    row.a.uses3d = typeof lookOf(ra)?.uses3d === 'boolean' ? ra.metrics.uses3d : null;
    row.b.uses3d = typeof lookOf(rb)?.uses3d === 'boolean' ? rb.metrics.uses3d : null;
    row.a.gateOk = typeof ra.gateOk === 'boolean' ? ra.gateOk : null;
    row.b.gateOk = typeof rb.gateOk === 'boolean' ? rb.gateOk : null;
    if (critics) {
      // D121: a video passes by `passesCritic` on its scores, read again here
      // so a run file written under the old no-defect rule is judged by the new one.
      row.a.criticPassed = criticOf(ra) === null ? null : passesCritic(criticOf(ra).scores);
      row.b.criticPassed = criticOf(rb) === null ? null : passesCritic(criticOf(rb).scores);
    }
    return row;
  });
  const totals = { a: {}, b: {}, diff: {}, pairs: {} };
  for (const column of look) {
    // Over the briefs measured on both sides only, so the two means and their
    // difference cover the same briefs.
    const paired = rows.filter((row) => row.a[column.key] !== null && row.b[column.key] !== null);
    totals.a[column.key] = mean(paired.map((row) => row.a[column.key]));
    totals.b[column.key] = mean(paired.map((row) => row.b[column.key]));
    totals.diff[column.key] = diffOf(totals.a[column.key], totals.b[column.key]);
    totals.pairs[column.key] = paired.length;
  }
  for (const column of runCols) {
    totals.a[column.key] = sum(rows.map((row) => row.a[column.key]));
    totals.b[column.key] = sum(rows.map((row) => row.b[column.key]));
    totals.diff[column.key] = diffOf(totals.a[column.key], totals.b[column.key]);
  }
  for (const side of ['a', 'b']) {
    totals[side].uses3d = rows.filter((row) => row[side].uses3d === true).length;
    totals[side].gatePassed = rows.filter((row) => row[side].gateOk === true).length;
    if (critics) {
      totals[side].criticPassed = rows.filter((row) => row[side].criticPassed === true).length;
      totals[side].criticFailed = rows.filter((row) => row[side].criticPassed === false).length;
    }
  }
  return {
    a: describe(a),
    b: describe(b),
    look: look.map(columnView),
    run: runCols.map(columnView),
    rows,
    totals,
    onlyInA: [...left.keys()].filter((id) => !right.has(id)).sort(),
    onlyInB: [...right.keys()].filter((id) => !left.has(id)).sort(),
  };
}

function fixed(value, digits) {
  return value === null ? '-' : value.toFixed(digits);
}

function signed(value, digits) {
  if (value === null) return '-';
  const text = Math.abs(value).toFixed(digits);
  if (Number(text) === 0) return text;
  return `${value > 0 ? '+' : '-'}${text}`;
}

const yesNo = (value) => (value === null ? '-' : value ? 'yes' : 'no');
const passFail = (value) => (value === null ? '-' : value ? 'pass' : 'fail');

/**
 * A table of groups, each one or more columns under a group label, as lines.
 * Every column is right-aligned and as wide as its widest cell, the first
 * column (the brief) left-aligned.
 */
function table(groups, rows, first = 'brief') {
  const cells = (row) => [row.name, ...groups.flatMap((group) => group.cells(row))];
  const head = [first, ...groups.flatMap((group) => group.heads)];
  const body = rows.map(cells);
  const widths = head.map((cell, i) => Math.max(cell.length, ...body.map((line) => line[i].length)));
  const gap = '  ';
  // The group line: each label over its columns, the last column widened
  // when the label is longer than the columns under it.
  let column = 1;
  const groupLine = [' '.repeat(widths[0])];
  for (const group of groups) {
    const last = column + group.heads.length - 1;
    const span = () => group.heads.reduce((total, _, i) => total + widths[column + i], 0) + (group.heads.length - 1);
    if (group.label.length > span()) widths[last] += group.label.length - span();
    groupLine.push(group.label.padEnd(span()));
    column += group.heads.length;
  }
  const render = (line) => {
    const out = [line[0].padEnd(widths[0])];
    let at = 1;
    for (const group of groups) {
      out.push(group.heads.map((_, i) => line[at + i].padStart(widths[at + i])).join(' '));
      at += group.heads.length;
    }
    return out.join(gap).trimEnd();
  };
  return [groupLine.join(gap).trimEnd(), render(head), ...body.map(render)];
}

/** A group of three cells, A, B and the difference, for a mean column; the pairs row shows its count. */
function meanGroup(column) {
  return {
    label: column.label,
    heads: ['A', 'B', 'diff'],
    cells: (row) => {
      if (row.pairs !== undefined) return ['', '', String(row.pairs[column.key])];
      const digits = row.total === true ? column.digits : (column.rowDigits ?? column.digits);
      return [fixed(row.a[column.key], digits), fixed(row.b[column.key], digits), signed(row.diff[column.key], digits)];
    },
  };
}

/** A group of three cells for a summed column; blank on the pairs row. */
function sumGroup(column) {
  return {
    label: column.label,
    heads: ['A', 'B', 'diff'],
    cells: (row) => (row.pairs !== undefined ? ['', '', ''] : [fixed(row.a[column.key], column.digits), fixed(row.b[column.key], column.digits), signed(row.diff[column.key], column.digits)]),
  };
}

/** The comparison as plain text: a look table, a run table, the critic and shots when either run has them, and the briefs only one run has. */
export function formatCompare(comparison) {
  const { a, b, look, run, rows, totals } = comparison;
  const side = (label, info) => `  ${label} is ${info.label}: ${info.tool}, model ${info.model ?? 'default'}, ${info.results} result${info.results === 1 ? '' : 's'}${info.manualHashes.length > 0 ? `, manual ${info.manualHashes.map((hash) => hash.slice(0, 12)).join(' ')}` : ''}${info.manualVersions.length > 0 ? `, ${info.manualVersions.length} manual version${info.manualVersions.length === 1 ? '' : 's'}` : ''}`;
  const lines = [`Video bench: ${a.label} against ${b.label}, ${rows.length} brief${rows.length === 1 ? '' : 's'} in both`, side('A', a), side('B', b), ''];
  const shortId = (id) => (id.length > 24 ? `${id.slice(0, 23)}~` : id);
  const tableRows = [
    ...rows.map((row) => ({ name: shortId(row.id), ...row })),
    { name: 'mean or total', a: totals.a, b: totals.b, diff: totals.diff, total: true },
  ];
  const pairsRow = { name: 'pairs in the mean', pairs: totals.pairs };
  const inTable = (columns, name) => columns.filter((column) => (column.table ?? (columns === run ? 'run' : 'look')) === name);

  const lookGroups = [
    ...inTable(look, 'look').map(meanGroup),
    {
      label: '3D',
      heads: ['A', 'B'],
      cells: (row) => (row.pairs !== undefined ? ['', ''] : row.total === true ? [String(row.a.uses3d), String(row.b.uses3d)] : [yesNo(row.a.uses3d), yesNo(row.b.uses3d)]),
    },
  ];
  lines.push('Look (means over the briefs measured on both sides; 3D counts videos)', ...table(lookGroups, [...tableRows, pairsRow]), '');

  const runGroups = [
    {
      label: 'gate',
      heads: ['A', 'B'],
      cells: (row) => (row.total === true ? [String(row.a.gatePassed), String(row.b.gatePassed)] : [passFail(row.a.gateOk), passFail(row.b.gateOk)]),
    },
    ...inTable(run, 'run').map(sumGroup),
  ];
  lines.push('Run (totals over the shared briefs on the last line; gate counts passes)', ...table(runGroups, tableRows));

  // The critic's verdict and mean, and the shot plans: only when a run has them.
  const extraLook = inTable(look, 'extra');
  const extraRun = inTable(run, 'extra');
  const criticMean = extraLook.find((column) => column.key === 'critic.mean');
  if (extraLook.length > 0 || extraRun.length > 0) {
    const extraGroups = [];
    if (criticMean !== undefined) {
      extraGroups.push(meanGroup(criticMean), {
        label: 'pass',
        heads: ['A', 'B'],
        cells: (row) => (row.pairs !== undefined ? ['', ''] : row.total === true ? [String(row.a.criticPassed), String(row.b.criticPassed)] : [passFail(row.a.criticPassed), passFail(row.b.criticPassed)]),
      });
    }
    extraGroups.push(...extraLook.filter((column) => column !== criticMean).map(meanGroup), ...extraRun.map(sumGroup));
    lines.push(
      '',
      'Critic and shots (means over the briefs measured on both sides; pass is the score mark, D121)',
      ...table(extraGroups, [...tableRows, pairsRow]),
    );
  }
  const scores = inTable(look, 'scores');
  if (scores.length > 0) {
    lines.push('', 'Critic scores, 1 to 5 (means over the briefs scored on both sides)', ...table(scores.map(meanGroup), [...tableRows, pairsRow]));
  }

  if (comparison.onlyInA.length > 0 || comparison.onlyInB.length > 0) lines.push('');
  if (comparison.onlyInA.length > 0) lines.push(`Only in ${a.label}, left out: ${comparison.onlyInA.join(', ')}`);
  if (comparison.onlyInB.length > 0) lines.push(`Only in ${b.label}, left out: ${comparison.onlyInB.join(', ')}`);
  return `${lines.join('\n')}\n`;
}
