// `bench:video compare`: two run files side by side, per brief and in total.
// Pure: it takes the two parsed runs and returns a comparison, which the CLI
// prints as text (under 100 columns) or as JSON.

/** The look numbers, per result. Each is `{ key, label, get, digits }`. */
const BASE_LOOK = [
  { key: 'variety', label: 'variety', get: (r) => r.metrics?.variety ?? null, digits: 2 },
  { key: 'helperTop5Share', label: 'top-five share', get: (r) => r.metrics?.helperTop5Share ?? null, digits: 2 },
  { key: 'fadeShare', label: 'fade share', get: (r) => r.metrics?.fadeShare ?? null, digits: 2 },
];

/**
 * The look columns for these runs: the scanner's three numbers, then one per
 * score any result carries under `critic` (`{ critic: { clarity: 0.8 } }`),
 * in name order. This is where a later critic's per-result scores join the
 * comparison: write them on the results and they are compared like the rest.
 */
export function lookColumns(...runs) {
  const names = new Set();
  for (const run of runs) {
    for (const result of run?.results ?? []) {
      const critic = result?.critic;
      if (critic === null || typeof critic !== 'object') continue;
      for (const [name, value] of Object.entries(critic)) if (typeof value === 'number') names.add(name);
    }
  }
  const critics = [...names].sort().map((name) => ({ key: `critic.${name}`, label: name, get: (r) => (typeof r.critic?.[name] === 'number' ? r.critic[name] : null), digits: 2 }));
  return [...BASE_LOOK, ...critics];
}

/** The run numbers, per result: summed in the totals, where the look numbers are averaged. */
const RUN_COLUMNS = [
  { key: 'attempts', label: 'attempts', get: (r) => r.attempts ?? null, digits: 0 },
  { key: 'turns', label: 'turns', get: (r) => r.turns ?? null, digits: 0 },
  { key: 'costUsd', label: 'cost USD', get: (r) => r.costUsd ?? null, digits: 2 },
  { key: 'wallMinutes', label: 'wall min', get: (r) => (typeof r.wallSeconds === 'number' ? r.wallSeconds / 60 : null), digits: 1 },
];

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const diffOf = (a, b) => (a === null || b === null ? null : b - a);
const mean = (values) => {
  const present = values.filter((value) => value !== null);
  return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0) / present.length;
};
const sum = (values) => {
  const present = values.filter((value) => value !== null);
  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0);
};

/** One side of a run, as the comparison describes it. */
function describe(run) {
  return { label: run.label, tool: run.tool, model: run.model ?? null, results: (run.results ?? []).length, manualHashes: run.manualHashes ?? [] };
}

/**
 * Compare run `a` with run `b`. Briefs in only one run are listed, never
 * averaged in. Returns `{ a, b, look, run, rows, totals, onlyInA, onlyInB }`,
 * where each row is `{ id, a, b, diff }` keyed by column, plus `uses3d` and
 * `gateOk` for each side, and totals are the means of the look columns and
 * the sums of the run columns over the shared briefs.
 */
export function compareRuns(a, b) {
  const look = lookColumns(a, b);
  const columns = [...look, ...RUN_COLUMNS];
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
    row.a.uses3d = typeof ra.metrics?.uses3d === 'boolean' ? ra.metrics.uses3d : null;
    row.b.uses3d = typeof rb.metrics?.uses3d === 'boolean' ? rb.metrics.uses3d : null;
    row.a.gateOk = typeof ra.gateOk === 'boolean' ? ra.gateOk : null;
    row.b.gateOk = typeof rb.gateOk === 'boolean' ? rb.gateOk : null;
    return row;
  });
  const totals = { a: {}, b: {}, diff: {} };
  for (const column of look) {
    totals.a[column.key] = mean(rows.map((row) => row.a[column.key]));
    totals.b[column.key] = mean(rows.map((row) => row.b[column.key]));
    totals.diff[column.key] = diffOf(totals.a[column.key], totals.b[column.key]);
  }
  for (const column of RUN_COLUMNS) {
    totals.a[column.key] = sum(rows.map((row) => row.a[column.key]));
    totals.b[column.key] = sum(rows.map((row) => row.b[column.key]));
    totals.diff[column.key] = diffOf(totals.a[column.key], totals.b[column.key]);
  }
  for (const side of ['a', 'b']) {
    totals[side].uses3d = rows.filter((row) => row[side].uses3d === true).length;
    totals[side].gatePassed = rows.filter((row) => row[side].gateOk === true).length;
  }
  return {
    a: describe(a),
    b: describe(b),
    look: look.map(({ key, label, digits }) => ({ key, label, digits })),
    run: RUN_COLUMNS.map(({ key, label, digits }) => ({ key, label, digits })),
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
function table(groups, rows) {
  const cells = (row) => [row.name, ...groups.flatMap((group) => group.cells(row))];
  const head = ['brief', ...groups.flatMap((group) => group.heads)];
  const body = rows.map(cells);
  const widths = head.map((cell, i) => Math.max(cell.length, ...body.map((line) => line[i].length)));
  const gap = '  ';
  // The group line: each label over its columns.
  let column = 1;
  const groupLine = [' '.repeat(widths[0])];
  for (const group of groups) {
    const span = group.heads.reduce((total, _, i) => total + widths[column + i], 0) + (group.heads.length - 1);
    groupLine.push(group.label.length > span ? group.label.slice(0, span) : group.label.padEnd(span));
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

/** The comparison as plain text: a look table, a run table, and the briefs only one run has. */
export function formatCompare(comparison) {
  const { a, b, look, run, rows, totals } = comparison;
  const side = (label, info) => `  ${label} is ${info.label}: ${info.tool}, model ${info.model ?? 'default'}, ${info.results} result${info.results === 1 ? '' : 's'}${info.manualHashes.length > 0 ? `, manual ${info.manualHashes.map((hash) => hash.slice(0, 12)).join(' ')}` : ''}`;
  const lines = [`Video bench: ${a.label} against ${b.label}, ${rows.length} brief${rows.length === 1 ? '' : 's'} in both`, side('A', a), side('B', b), ''];
  const shortId = (id) => (id.length > 24 ? `${id.slice(0, 23)}~` : id);
  const tableRows = [
    ...rows.map((row) => ({ name: shortId(row.id), ...row })),
    { name: 'mean or total', a: totals.a, b: totals.b, diff: totals.diff, total: true },
  ];

  const lookGroups = [
    ...look.map((column) => ({
      label: column.label,
      heads: ['A', 'B', 'diff'],
      cells: (row) => [fixed(row.a[column.key], column.digits), fixed(row.b[column.key], column.digits), signed(row.diff[column.key], column.digits)],
    })),
    {
      label: '3D',
      heads: ['A', 'B'],
      cells: (row) => (row.total === true ? [String(row.a.uses3d), String(row.b.uses3d)] : [yesNo(row.a.uses3d), yesNo(row.b.uses3d)]),
    },
  ];
  lines.push('Look (the mean over the shared briefs on the last line; 3D counts videos)', ...table(lookGroups, tableRows), '');

  const runGroups = [
    {
      label: 'gate',
      heads: ['A', 'B'],
      cells: (row) => (row.total === true ? [String(row.a.gatePassed), String(row.b.gatePassed)] : [passFail(row.a.gateOk), passFail(row.b.gateOk)]),
    },
    ...run.map((column) => ({
      label: column.label,
      heads: ['A', 'B', 'diff'],
      cells: (row) => [fixed(row.a[column.key], column.digits), fixed(row.b[column.key], column.digits), signed(row.diff[column.key], column.digits)],
    })),
  ];
  lines.push('Run (totals over the shared briefs on the last line; gate counts passes)', ...table(runGroups, tableRows));

  if (comparison.onlyInA.length > 0 || comparison.onlyInB.length > 0) lines.push('');
  if (comparison.onlyInA.length > 0) lines.push(`Only in ${a.label}, left out: ${comparison.onlyInA.join(', ')}`);
  if (comparison.onlyInB.length > 0) lines.push(`Only in ${b.label}, left out: ${comparison.onlyInB.join(', ')}`);
  return `${lines.join('\n')}\n`;
}
