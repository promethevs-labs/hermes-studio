# The video bench

Built 2026-11-20 and run twice that day, before and after the look
milestone (docs/STUDIO-LOOK.md, "Results"). A fixed set of twelve
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
| `dry-run --tool T [--only a,b] [--label L] [--shots] [--critic] [--json]` | Prints what `run` would post: ids, slugs and predicted seconds, and whether shots and a standalone critic would be asked for, or the job bodies with `--json`. No network, nothing started |
| `setup --home DIR [--reuse]` | Builds a scratch home (below) |
| `run --home DIR --label L --tool T --cap USD [--model M] [--only a,b] [--port N] [--keep-going] [--resume] [--shots] [--critic]` | Posts each brief, one at a time, to a runner it starts, follows each job, accepts it, reads its critic, and writes the run file. This is the verb that spends money |
| `score --home DIR --label L --cap USD [--port N] [--only a,b] [--again]` | Asks the critic about each accepted video of a run that already exists and has no critic recorded, and writes the scores into its run file. It spends money too |
| `compare --home DIR A B [--json]` | Compares two run labels in the same home |

`--cap` is the most this one command may spend, in US dollars, and it has no
default. For `run` it covers one run label in total, so a `--resume` counts what
the label already spent against it. For `score` it covers that one score pass,
which starts from nothing. It is not a limit on the whole home: a home holds
several runs, and a cap that read as "this home may spend this much in a day"
left the 2026-11-20 run with $37.67 of a $50 cap, because the home's rolling
day already held $12.33. Each command prints one line at the start, such as
`Home has spent $12.33 in the last 24 hours; this run may spend up to $50.00
more (runner cap $62.33).`

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
| `STUDIO_DAILY_USD` | What the home had already spent in its last 24 hours when the command started, plus what `--cap` leaves this command (below) |
| `AUTH_SECRET` | A fresh random value, so the runner never reads the web app's environment, which would also hand it the web app's catalog file |

Everything else passes through from the shell that started it, the tool
roots included. `CATALOG_COPY_OK` is removed: the bench catalog is a primary.

Before anything is posted, `run` checks that nothing already listens on the
port, then works out the runner's cap (the next section), waits for
`/api/health`, and stops with nothing posted unless the runner reports the
same cap it was given, finds the claude CLI, and the chosen tool's doctor
passes (it waits up to 15 minutes for the doctor's first check). Then it
prints one line naming the number of briefs, the tool and the model, and
starts.

### The cap of one command

The runner's `STUDIO_DAILY_USD` is a rolling 24 hours over everything the
home's runner spent: video jobs, each picture check, shot plans, planner turns
and diagram jobs, checked when a job is queued. It is the only thing that
stops a paid agent session, so it stays as the hard backstop, and it never
gets weaker than what the person typed. The person typed `--cap` to say what
this command may spend, so the bench sets the runner's cap to the home's
spend plus that number:

1. The bench starts a runner over the home that only answers one question
   and posts nothing, reads `dailyCap.totalUsd` from its `/api/health`, and
   stops it. The figure is the runner's own, from the same `spendWindow` the
   cap refuses on, so spend older than 24 hours is not in it. The bench reads
   no job files itself. If the runner gives no figure, the command stops with
   nothing posted.
2. For `run`, the allowance is `--cap` less what this label already spent, read
   from its run file (zero for a new label). A resume is never handed a fresh
   cap: with $4 recorded under `--cap 5`, it may spend $1 more, whether or not
   that $4 is still inside the home's rolling day. A label that has already
   reached `--cap` stops before anything is started; pass a larger `--cap`.
   For `score` the allowance is `--cap`.
3. The runner the command works with starts at the home's spend plus the
   allowance, and the command prints both numbers. With $12.33 spent and
   `--cap 50`, the runner cap is $62.33.

The bench also keeps its own check: a `run` stops before posting once this
label's recorded costs reach `--cap`, and a `score` once what it spent reaches
it. Spend that ages out of the rolling day while a command runs gives the
runner more room, never less, so that check is what holds a label to its cap
over a long run. The runner still refuses a job once the rolling day reaches
its cap, and a running job is never stopped by it.

For each brief, in id order, it posts the brief with the run's `tool`, the
`--model` when one is given (else the runner's default), the slug
`<id>-<label>` and the idempotency key `bench-video:<label>:<id>:<attempt>`.
It polls the job every ten seconds until it settles, accepts a job that
reached review (so the video lands in the scratch catalog and gets an
ingredients row) and records a failed one. A label is lower-case letters and
digits joined by single hyphens, at most 20 characters.

It stops cleanly, with what finished written down, when:

- the runner answers 429 at its daily cap;
- the run's own recorded costs reach `--cap`, checked before each post;
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
capPlan, shotsAsked, criticAsked, startedAt, endedAt, manualHashes, results,
stopReason?, scoring? }`. `capUsd` is the `--cap` typed for the latest command,
and `capPlan` says what it meant: `{ perCommandUsd, labelSpentUsd,
homeSpentUsd, runnerCapUsd }`, which are `--cap`, what the label had already
spent, what the home had spent in its last 24 hours when the command started,
and the cap the runner was started with. It is null in a file written before
the command got that far, and in a run file from before it existed. Each result `{ id, jobId, state, gateOk, attempts,
turns, costUsd, wallSeconds, renderSeconds, metrics: { variety,
helperTop5Share, fadeShare, uses3d } | null, shots, critic, criticCostUsd,
checkCostUsd, error }`, plus `slug`, `tries`, `errorKind` and
`earlierCostUsd`. `shots` and `critic` are below. `criticCostUsd` is what the
runner's own picture checks of the job's attempts cost, read from the run
history in its `job.json`, since a critic's cost is never on the job's own
`cost_usd`. `checkCostUsd` is what the standalone checks the bench asked for
cost. Both count toward the cap; only the first is part of what making the
video cost, which `compare` sets side by side. `wallSeconds` is the
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

A resume must ask for shots the same way the run did (`--shots` or not), or
it is refused; `--critic` may differ.

The look metrics come from the job's kept scene source, `jobs/<id>/source/`
under `DIR/studio`, scanned by the catalog's own `scanSources`
(`services/catalog/src/ingredients/scan.ts`), with manimkc's library names
read from `MANIMKC_ROOT`, as `catalog video put` does. That is simpler than
reading `catalog eval report`, which reports by tool, model and manual rather
than by job. A result has metrics only when its state is `accepted`: a
failed job can keep the untouched scene stub, which scans like a busy
picture. `compare` likewise leaves any result that did not land out of the
look means.

## Shots

The stored briefs carry no shots, on purpose: with `run --shots` the art
director plans them afresh on each run. Before each brief is posted, the
bench sends it, exactly as it is about to be posted, to `POST
/api/video/shots` (docs/STUDIO-VIDEOS.md, "The shot plan"), and records the
answer on the result as `shots: { state, costUsd, reason, types, brief }`:

| `state` | What the bench does |
| --- | --- |
| `planned`, `reused` | Posts the brief the route answered, which carries `scenes[].shot`, under the run's own slug, tool, model and key. `types` is each scene's shot type, and `brief` the planned brief |
| `failed` | Posts the stored brief with no shots, and keeps the route's reason |
| `off` | Stops before posting, since the run asked for shots and the runner cannot plan them (`STUDIO_ART_DIRECTOR=off`); with `--keep-going` it posts the stored brief |
| `refused` | The route did not answer 200. A 429 stops the run cleanly, as the enqueue's does; anything else stops it unless `--keep-going` |

The art director's cost counts in the bench's own cap arithmetic and in the
totals. The bench checks its cap again after a plan and stops before posting
the job when the plan reached it. A resume never pays for a second plan: a
result recorded as `planned`, `reused` or `failed` keeps what it has, and the
planned brief in the run file is posted again. A plan request that got no
answer is asked again on a resume, and anything it cost is not known to the
bench (the runner's cap still counts it).

## The critic

After a job is accepted the bench reads its `critic` from `GET
/api/jobs/{id}` (docs/STUDIO-VIDEOS.md, "The critic") and records it on every
run as `critic: { source, attempt, current, scores, mean, defects, notes,
sentBack, passed, error }`. `source` is `job` for the runner's own check and
`standalone` for one the bench asked for. `current` says whether the scores
are of the build in review. `mean` is the mean of the five scores. `passed`
is D116 of docs/STUDIO-LOOK.md: the critic's read of the last attempt names
no defect; the scores never block. It is null when the build in review was
not scored, and `error` then says why.

With `run --critic`, a landed video whose job has no critic of its build in
review (the runner's critic is off, or its check gave no answer) gets a
standalone check, `POST /api/jobs/{id}/critic`, recorded with `source:
"standalone"` and its cost in `checkCostUsd`, counted toward the cap. A job that already has a critic of the
build in review is never checked again. A 409 (no kept sheet) is recorded and
the run goes on, a 429 stops it, and a 503 (`STUDIO_VIDEO_CRITIC=off`) stops
it unless `--keep-going`. The video itself is already recorded as accepted
when that happens, so `score` can check it later.

`score` does the same for a run file that already exists, such as a baseline
made before the critic did. It starts a runner over the home as `run` does,
with the same guards (the port free, the cap in force, the claude CLI found)
except the tool's doctor, which reading kept sheets does not need. For each
accepted result with no critic recorded, it reads the job's own critic first
and records that when it is of the build in review, paying nothing; else it
calls the standalone route. Each answer is written into the run file as it
comes (atomically), so a stop leaves what was scored and the next `score`
carries on. A result a standalone check already answered for, a 409
included, is left alone unless `--again`. A 409 is recorded and the scoring
goes on; a 429, a 503 or no answer stops it. `--cap` is required. Its own
stop is what this scoring spent reaching the cap, kept in the run file's
`scoring: { startedAt, endedAt, capUsd, spentUsd, homeSpentUsd,
runnerCapUsd, stopReason? }`; the
runner's rolling day counts the home's earlier spending as well, which is why the
runner is started at that spending plus `--cap`. The record also keeps
`homeSpentUsd` and `runnerCapUsd`, the same two numbers as a run's `capPlan`. Never run
`score` on a home while a `run` on it is going.

## A before and after

1. `run` the baseline, before the changes: `run --label base`.
2. `score` it: `score --label base`, which gives the baseline the critic's
   scores whether or not the runner had a critic when it ran.
3. After the changes, `run --shots --label art`. The runner's critic scores
   each attempt as it goes; add `--critic` to check any video it did not.
4. `compare base art`.

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

Measured on 2026-11-20, remotionkc with the `sonnet` model:

| Run | Twelve briefs | A video | Wall time a video |
| --- | --- | --- | --- |
| `run`, before the look milestone | $10.21 | $0.46 to $1.56, mean $0.85 | 9 minutes |
| `run --shots --critic` on main, the critic's retry on | $35.38 | $2.44 to $3.82, mean $2.95 | 16 minutes |
| `score` on twelve accepted videos | $0.51 | $0.04 | half a minute |

In the second run a shot plan cost $0.02 to $0.06 a brief ($0.36 in all),
the runner's own critic about $0.05 a read ($1.20 for 24 reads), and the
critic's retry $20.22 of the $33.82 the jobs cost. Each is recorded per
result (`shots.costUsd`, `criticCostUsd`, `checkCostUsd`) and counted toward
the cap. Other tools and models are unmeasured.

A paid run needs the owner's go-ahead and `--cap`, which has no default. The
cap is the most that one command may spend (see "The cap of one command"), so
`--cap 50` on a home that already spent $12.33 that day may spend $50 more. The
runner's own cap is checked when a job is queued and never stops a job
already running, so a run can end up to one job's cost over the cap.

## Comparing runs

`compare --home DIR base art` prints two tables under 100 columns: the look
numbers (variety, top-five helper share, fade share, 3D) with each mean and
difference taken over the briefs measured on both sides, and a line saying
how many pairs that was; and the run numbers (gate pass, attempts, turns,
cost with earlier attempts, the shot plan and the runner's own picture checks
included, and a standalone check left out since it measures rather than
makes the video, wall minutes) with their totals. Each shows A, B and the difference.
A brief only one run has is listed below the tables and left out of all of them.
`--json` prints the same comparison as data.

When either run carries critic scores or shot plans, two more tables follow.
The first has the critic's mean, the pass or fail (D116, counted on the last
line), the distinct shot types per video and the art director's cost. The
second has each of the five critic dimensions. Every mean and its difference
cover only the briefs measured on both sides, with the pairs shown, so a
baseline with no shots and a run with them shows each side's figures per
brief and no shot type mean. A critic of an earlier build than the one in
review, or of a video that did not land, is left out. With neither run
carrying them, the output is as before. `lookColumns` and `runColumns` in
`scripts/lib/bench-video/compare.mjs` are where the columns are chosen.

## What the tests cover

The tests make no paid call and write only under the OS temp directory:
every brief passes `validateVideoBrief` with the bench vocabulary and stays
in the band; ids and needs are unique; `compare`'s exact text on two fixture
runs, with the critic and shots on one side, on both and on neither; `run`'s
loop against a stand-in HTTP server that plays a runner (the guard's header
rules, a doctor that answers late, 201, 409, 429, a failed job, a stop
mid-job, a resume and the cap; shots planned, reused on a resume with no
second call, failed, off and refused at 429, the plan's cost in the cap; the
critic read from the job, and the standalone route called only when needed);
`score` over an existing run file with a 409 and a 429; the cap of one
command (a fresh home, earlier spend inside the rolling day, spend older
than 24 hours left out by the studio's own `spendWindow`, a resume counting
the label's spend, a label already at its cap, and a score pass); and
`setup`'s refusals.
No test runs the loop against the real `createApi`: that needs the catalog,
the gate and a backend replaced, as `services/studio/test/video-run-record.test.ts`
does, and the stand-in covers the same routes.
