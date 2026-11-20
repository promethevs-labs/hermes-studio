# The video bench

Built 2026-11-20, never run against a real model yet. A fixed set of twelve
video briefs, a command that runs them through the studio's video runner
against a scratch home, and a report that compares two runs.

It exists to measure whether a later change makes agent-made videos more
varied: an art-direction step, a shot library, a vision critic. The same
briefs go through before and after the change, and the comparison says what
moved. Every run costs money, so nothing about it runs by itself.

## What it is

| Piece | Where |
| --- | --- |
| The twelve briefs | `bench/video/briefs/<id>.json`, each `{ id, needs, brief }` |
| The topics they are filed under | `bench/video/topics.json` |
| The command | `scripts/bench-video.mjs`, as `npm run bench:video -- <verb>` |
| The logic, testable on its own | `scripts/lib/bench-video/*.mjs` |
| The tests | `scripts/lib/bench-video/*.test.mjs` |

Each brief is a complete studio video brief with no `tool`, a slug equal to
its id, 60 to 75 seconds long, narrated with `af_heart` for a `familiar`
audience. Each covers one thing a picture can mainly need, named in its
`needs` line:

| Id | What the picture mainly needs |
| --- | --- |
| `binary-search-halving` | A sorted array being searched |
| `bst-insert-path` | A tree growing |
| `bfs-frontier` | A graph traversal |
| `growth-rates-chart` | Real numbers on a chart |
| `loop-running-total` | A code walk |
| `tcp-versus-udp` | A side-by-side comparison |
| `tcp-three-way-handshake` | A sequence over time |
| `recursion-stack-frames` | A memory view |
| `load-balancer-request` | A system diagram with a request moving through it |
| `dominant-term` | An equation with a term that stops mattering |
| `memory-hierarchy-layers` | A layered or physical structure |
| `hash-table-coat-check` | A metaphor |

The narration follows the planner's storyboard rules (`STORYBOARD_RULES` in
`services/studio/src/drafts/planner-prompt.ts`). A `show` line says what
happens on screen and never names a tool, a helper or a visual style, since
the bench measures what the agent chooses for the picture. `validate` refuses
a `show` line with a tool or style word in it.

Change a brief and the runs before and after it no longer compare. Add a new
brief rather than edit one that has runs.

## The verbs

Run them from a checkout through npm, which starts node with `tsx` so the
studio's own validator and the catalog's scanner are imported as they are.
Add `--silent` before `bench:video` when you pipe `--json` output.

| Verb | What it does |
| --- | --- |
| `validate` | Checks every brief against the bench's rules and against `validateVideoBrief` itself, with each of manimkc, remotionkc and revideokc. No network, nothing started |
| `dry-run --tool T [--only a,b] [--label L] [--json]` | Prints what `run` would post: ids, slugs and predicted seconds, or the bodies with `--json`. No network, nothing started |
| `setup --home DIR [--reuse]` | Builds a scratch home (below) |
| `run --home DIR --label L --tool T --cap USD [--model M] [--only a,b] [--port N] [--keep-going] [--resume]` | Posts each brief, one at a time, to a runner it starts, follows each job, accepts it, and writes the run file. This is the verb that spends money |
| `compare --home DIR A B [--json]` | Compares two run labels in the same home |

The predicted seconds in `validate` and `dry-run` use the studio's fallback
rate of 15.2 characters a second. The runner uses gnosia-audio's own rate,
and refuses a brief whose lines miss its target by more than a fifth, which
costs nothing.

## The scratch home

`setup --home DIR` makes:

| Path | What it is |
| --- | --- |
| `DIR/catalog.db` | A catalog migrated, with `seed/` imported and flipped, as `scripts/e2e.mjs` builds one, plus the three bench topics added with `catalog topic add --owner local` |
| `DIR/blobs/` | Its blob store: `HERMES_HOME` is `DIR` for every command and for the runner |
| `DIR/studio/` | The runner's `STUDIO_HOME`: jobs, their records, their kept source and sheets |
| `DIR/runs/<label>.json` | One run file per label, and `<label>.runner.log`, the runner's output |
| `DIR/bench-home.json` | The marker; `run` refuses a directory without it |

`setup` refuses a `DIR` inside this checkout, inside the main checkout, or
inside `~/.gnosia` or `~/.hermes`, and also one that contains any of them,
with symlinks resolved first. It refuses a `DIR` that already holds a
catalog unless `--reuse`, which only migrates it and adds missing topics.
A directory under `/tmp` is the usual choice.

What a run does not keep inside the home: the agent runs on this machine's
claude login (`STUDIO_AGENT_AUTH`, as the studio always does), and each video
tool narrates through its own checkout's settings, so voiced lines land in
that tool's own clip cache.

## A run

`run` starts its own runner, `node --import tsx services/studio/src/index.ts`,
as a child in its own process group, with:

| Variable | Value |
| --- | --- |
| `CATALOG_DB`, `DATABASE_URL` | `DIR/catalog.db` |
| `HERMES_HOME`, `GNOSIA_HOME` | `DIR` |
| `STUDIO_HOME` | `DIR/studio` |
| `STUDIO_PORT` | `--port`, 7260 by default; 7250, the studio's own, is refused |
| `STUDIO_OWNER` | `local` |
| `STUDIO_DAILY_USD` | `--cap` |
| `AUTH_SECRET` | A fresh random value, so the runner never reads the web app's environment, which would also hand it the web app's catalog file |

Everything else passes through from the shell that started it, the tool
roots included. `CATALOG_COPY_OK` is removed: the bench catalog is a primary.

Before anything is posted, `run` checks that nothing already listens on the
port, waits for `/api/health`, and stops with nothing posted unless the
runner reports the same cap it was given, finds the claude CLI, and the
chosen tool's doctor passes (it waits up to 15 minutes for the doctor's
first check). Then it prints one line naming the number of briefs, the tool,
the model and the cap, and starts.

For each brief, in id order, it posts the brief with the run's `tool`, the
`--model` when one is given (else the runner's default), the slug
`<id>-<label>` and the idempotency key `bench-video:<label>:<id>:<attempt>`.
It polls the job every ten seconds until it settles, accepts a job that
reached review (so the video lands in the scratch catalog and gets an
ingredients row) and records a failed one. A label is lower-case letters and
digits joined by single hyphens, at most 20 characters.

It stops cleanly, with what finished written down, when:

- the runner answers 429 at the daily cap;
- the run's own recorded costs reach the cap, checked before each post;
- any other enqueue refusal, a failed accept, or a job that failed with an
  error kind that says the machine is the problem (`agent`, `spawn`,
  `toolchain`, `internal`, `not-claimed`) comes back, unless `--keep-going`;
- a job runs past three hours, which it cancels;
- it gets SIGINT, SIGTERM or SIGHUP. It cancels the running job and stops
  the runner, then everything the runner started. A second signal asks the
  runner to cancel the job while it still answers, then stops it at once.

Stopping is `stopTree` in `scripts/lib/bench-video/runner.mjs`. The runner
puts each agent and each render in a process group of its own, so its own
group never reaches them. Before signalling, the bench walks the process
table (`ps -axo pid,ppid,pgid`) down from the runner and notes every group
under it, and walks again on every poll while the runner drains, since a
detached child keeps the runner as its parent only while the runner lives.
It sends SIGTERM to the runner's group and waits up to 45 seconds (two after
a second signal), then sends SIGTERM and, five seconds later, SIGKILL to
every noted group still alive, and polls each one. The log says when all
are stopped, or which groups survived.

The run file is written after every step: `{ label, tool, model, capUsd,
startedAt, endedAt, manualHashes, results, stopReason? }`, each result `{ id,
jobId, state, gateOk, attempts, turns, costUsd, wallSeconds, renderSeconds,
metrics: { variety, helperTop5Share, fadeShare, uses3d } | null, error }`,
plus `slug`, `tries`, `errorKind` and `earlierCostUsd`. `wallSeconds` is the
job record's start to finish, else the bench's own clock. `turns` is the sum
over `run.json`'s attempts when every attempt has a count, since the job
record's own `turns` is the last attempt's alone, and that figure otherwise. A label whose run
file exists is refused unless `--resume`, which must use the same tool and
model. A resume skips every brief recorded as accepted, failed or cancelled,
accepts one still waiting for review, reposts one whose post got no answer
(recorded as `unanswered`) under the same key, so the runner answers with
the job it already has rather than queueing a second, and posts the rest as
a new attempt, which is paid again. What an earlier attempt cost stays in `earlierCostUsd` and counts
toward the cap.

The look metrics come from the job's kept scene source, `jobs/<id>/source/`
under `DIR/studio`, scanned by the catalog's own `scanSources`
(`services/catalog/src/ingredients/scan.ts`), with manimkc's library names
read from `MANIMKC_ROOT`, as `catalog video put` does. That is simpler than
reading `catalog eval report`, which reports by tool, model and manual rather
than by job. A result has metrics only when its state is `accepted`: a
failed job can keep the untouched scene stub, which scans like a busy
picture. `compare` likewise leaves any result that did not land out of the
look means.

## Starting a real run on the owner's Mac

A worktree's submodules are empty, so point the tool roots at the main
checkout's `tools/`, whose environments are installed there:

```sh
MAIN=<path to the main checkout>
npm run bench:video -- setup --home /tmp/hermes-bench
MANIMKC_ROOT=$MAIN/tools/manimkc \
REMOTIONKC_ROOT=$MAIN/tools/remotionkc \
REVIDEOKC_ROOT=$MAIN/tools/revideokc \
TLDRAWKC_ROOT=$MAIN/tools/tldrawkc \
npm run bench:video -- run --home /tmp/hermes-bench --label base --tool manimkc \
  --only binary-search-halving --cap 5
```

That is one brief with a small cap, the right first run. Drop `--only` and
raise `--cap` for all twelve. The run refuses to start when the tool's doctor
fails, and says why.

## What it costs

Unknown until measured. Past studio videos cost about $2 to $3.60 each, and
these are 60 to 75 seconds, so a guess for twelve is $25 to $45 a run. The
first real run is the measurement.

A paid run needs the owner's go-ahead and `--cap`, which has no default. The
cap is the runner's `STUDIO_DAILY_USD`: a rolling 24 hours over everything
this home's runner spent, checked when a job is queued. It never stops a job
already running, so a run can end up to one job's cost over the cap.

## Comparing runs

`compare --home DIR base art` prints two tables under 100 columns: the look
numbers (variety, top-five helper share, fade share, 3D) with each mean and
difference taken over the briefs measured on both sides, and a line saying
how many pairs that was; and the run numbers (gate pass, attempts, turns,
cost with earlier attempts included, wall minutes) with their totals. Each shows A, B and the difference.
A brief only one run has is listed below the tables and left out of both.
`--json` prints the same comparison as data.

`lookColumns` in `scripts/lib/bench-video/compare.mjs` is where critic scores
join later: a result that carries `critic: { <name>: <number> }` gets a look
column for each name, compared like the scanner's numbers.

## What the tests cover

The tests make no paid call and write only under the OS temp directory:
every brief passes `validateVideoBrief` with the bench vocabulary and stays
in the band; ids and needs are unique; `compare`'s exact text on two fixture
runs; `run`'s loop against a stand-in HTTP server that plays a runner
(the guard's header rules, a doctor that answers late, 201, 409, 429, a
failed job, a stop mid-job, a resume and the cap); and `setup`'s refusals.
No test runs the loop against the real `createApi`: that needs the catalog,
the gate and a backend replaced, as `services/studio/test/video-run-record.test.ts`
does, and the stand-in covers the same routes.
