# The look of a video: art direction, a shot library and a critic

How the studio stops making videos that all look the same, and how it proves
the change. This is the milestone plan and the decisions behind it. Each
piece ships as its own pull request and records its details in the document
that owns that part of the studio; this page is where to start.

**Status: accepted 2026-11-20, every default taken by the owner. Every
piece is built and the benchmark ran before and after on 2026-11-20.**
Variety rose and the top five share fell on the same twelve briefs; no video
passed the critic on either side, and a video cost about three and a half
times as much. "Results" below has the numbers and what they do not show.

## What was measured

The audit of 2026-11-20 counted calls in every video's scene source
(`services/catalog/src/ingredients/scan.ts`), and `catalog eval report`
prints the result. On the owner's catalog that day:

| Tool | Videos | Variety | Top five helpers | Fades | 3D |
| --- | --- | --- | --- | --- | --- |
| manimkc | 153 | 0.69 | 94% | 81% | 0% |
| remotionkc | 4 | 0.78 | 76% | 3% | 25% |
| revideokc | 3 | 0.80 | 100% | 0% | 67% |

Variety is the normalised entropy of helper and animation calls. The top
five share is the five most-used helpers' share of all helper calls. Fades
is the share of animation calls that are a fade in or out. All three are
cheap signs of look-alike videos, not measures of quality.

Four causes stood out.

1. **Nothing plans the picture.** The brief gives each beat one `show` line.
   The gate checks that the contact sheet file was read, never what is on it.
2. **The libraries hold text and boxes.** manimkc's `lib/` has ten visual
   helpers, all boxes, arrows and tables. remotionkc's has code, terminal and
   chart maths, with no chart or diagram component and no shared palette, so
   each topic rebuilds its own theme. revideokc's has one visual export. No
   tool has icons or a gallery of what it can draw.
3. **The instructions ask for sameness.** `tools/manimkc/AGENTS.md` says
   keeping to the helpers "is what makes the videos read as one series".
   [VIDEO-TOOLS.md](VIDEO-TOOLS.md) calls a change of look a mistake. The
   studio's manimkc manual shows two worked scenes, both a heading over boxes.
4. **Past use feeds the next video.** `manimkc api` ranks the ManimGL names
   by how often past topics called them. Its own helpers print in file order,
   and the most-used ones (`body`, `mono`, `heading`, `stack` in `lesson.py`)
   are not listed at all, so an agent learns them from old scenes.

Research the audit drew on: Code2Video found that a planning step matters
most for how a video looks, and that an asset library, visual anchors and a
critic that reads frames each add to it. TheoremExplainAgent found a planning
step essential, and that retrieval over documentation made videos worse.

## Decisions

### D111. A series fixes its palette, typeface, heading position and voice; the rest must vary

A viewer should know two videos belong together by their colours, their type
and their voice. Layout, shot type, motion and transitions change from scene
to scene and from video to video. This replaces "a change of look reads as a
mistake": a change of palette or typeface inside a series is the mistake, and
two neighbouring scenes with the same layout is one too. A series is a course
code (CS3230, CS4223); a video outside a series uses the tool's default theme.

### D112. remotionkc makes new studio videos unless the picture needs what only another tool has

The routing table's last row sent every video of boxes and arrows to manimkc.
The default becomes remotionkc. manimkc keeps the terminal, the series it
already has, and the rows only it can draw: function plots, glyph-level
equation morphs, vector fields and 3D maths surfaces. revideokc keeps code
edited in place and its lit 3D stage.

Why: remotionkc lays out with CSS, draws charts from data, and has code,
terminal, KaTeX and three.js. The one remotionkc video a studio job has made
("How fast functions grow") used five shot types in a minute and cost $1.94.
That is one job, so the benchmark below is what tests this decision.

### D113. remotionkc gets the shot library first, manimkc second

The library lives in the tool's own repository, under `lib/`, with a theme
that carries D111's fixed part. manimkc is second because 151 of its 153
videos were made at a terminal: its guidance and its `api` listing change in
the guidance piece either way.

### D114. A separate art-director turn writes each scene's shot

After the planner proposes a valid video brief, a second sealed agent turn
(no tools, as the planner has none) reads the brief and adds a `shot` to
every scene: a shot type, the layout, one motion idea and the emphasis. The
person approves it with the storyboard, on the same card. The planner never
writes shots.

Why a separate turn: the benchmark runs fixed scripts, and the shots must be
planned afresh on each run to measure the art direction on its own. It also
keeps the planner's prompt, which two documents quote byte for byte,
unchanged. The cost is one more model call per new script. Unchanged scenes
reuse their stored shots, so switching the tool or the title costs nothing.

### D115. Twelve shot types, and a rule the validator can check

`title`, `build-up-diagram`, `code-walk`, `data-chart`, `comparison`,
`timeline`, `array-or-memory`, `tree-or-graph`, `equation`, `object-3d`,
`metaphor`, `recap-map` (`SHOT_TYPES` in `packages/schema/src/shared.ts`).
A brief of four or more scenes is refused when one type covers more than half
of them, and `title` and `recap-map` appear at most once. A brief with no
shots stays valid, so old briefs, old jobs and a failed art-director turn
still make a video.

The art director's own reply is read more gently than a brief. Its prompt asks
for a tenth under each text limit (180 characters for `layout` and `motion`,
144 for `emphasis`, derived from `SHOT_TEXT_LIMITS`), and a line over its limit
by up to the limit again is cut back to the last whole word that fits, with
nothing added, and logged by the runner, instead of failing the plan. A line
more than twice its limit, or any other fault, is refused as before, and the
brief validator stays strict for a person's edits.

### D116. The critic sends back what it can point to, once, and only reports the scores

After a build passes the gate, a model reads the contact sheets against a
rubric of five scores from 1 to 5: accuracy (the picture shows what the words
say), layout (nothing overlapping, cut off or crowded), relevance (the
picture helps explain the idea), variety (scenes differ in shot and layout)
and pacing (the screen changes with the voice). A defect it can point to in
a named scene goes back to the video agent as a finding, once per job, inside
the existing three attempts. The scores never block: they are stored on the
attempt in the job's run record (`critic` on `JobRunAttempt`), shown on the
job panel, and reported by `catalog eval report`.

A video **passes the critic** when the critic's read of its last attempt
names no defect: `defects` is 0 on that attempt's `critic`. The scores play
no part in passing. A job whose one critic retry is spent and whose last
attempt still has a defect does not pass, and it still reaches review, where
the person sees the defect on the job panel.

Why not block on a score: nobody has compared these scores with the owner's
own ratings yet. Once enough videos carry both a thumbs rating and critic
scores, the report can show whether they agree, and this decision can change.

**Amended 2026-11-20, the owner's call after the benchmark (D121).** Two
parts of this decision changed. The critic now reports by default and no
longer retries unless asked (`STUDIO_VIDEO_CRITIC=retry`), and a video passes
the critic by its scores, not by having no defect. The paragraph above
stands as the rule the 2026-11-20 benchmark was made under. D121 has the
current rule and the reasons. What stays as written: the rubric, the once-only
retry in `retry` mode, and that the scores never block a job.

### D117. Icons are Lucide, installed with the tool

Lucide's licence is ISC, which allows this use. A job's render has no
network, so the icons come from the tool's own `node_modules` or files in its
repository, never from a URL.

### D118. Paid runs are capped and stepped

The owner approved up to $120: a two-brief smoke run capped at $10, the
twelve-brief baseline capped at $50, and the twelve-brief run after the
changes capped at $50. Each run sets `STUDIO_DAILY_USD` on its own runner. A
smoke run that costs more than $5 a video stops the plan until the owner says
otherwise.

### D119. No music or sound in this milestone

No licensed audio exists in any tool's repository, and a studio job cannot
fetch any. It is a later piece of work with its own licence question.

### D120. At a terminal too, remotionkc is the default

D112 moved the studio's default and left the terminal with manimkc, because
the owner had not decided it. The owner decided it on 2026-11-20: a video
made at a terminal goes to remotionkc unless it continues an existing
manimkc series, needs ManimGL's maths animation (function plots, glyph-level
equation morphs, vector fields, 3D maths surfaces), or needs Blender's
photoreal 3D. Those are rows of the routing table in
[VIDEO-TOOLS.md](VIDEO-TOOLS.md) that sit above its last row, so nothing in
the table moves: its last row is now the default everywhere, and the other
rows above it (the silent video, revideokc's code edited in place and lit 3D
stage) still win as before. This amends the sentence in D112 that manimkc
keeps the terminal.

Why: the reason D112 gives for the studio holds at a terminal. The same
plain diagram video went to manimkc there, and the audit's sameness came
from that route.

### D121. The critic reports by default, and a video passes it by its scores (provisional)

The owner decided both on 2026-11-20, after the benchmark in "Results". This
amends D116.

**The default.** `STUDIO_VIDEO_CRITIC` is `report`. The critic reads every
video that passes the gate, and its five scores and its defects are recorded
on the job (the attempt's `critic` in the run record, `critic` in `job.json`,
the job panel). Nothing goes back to the video agent and no retry happens, so
a job makes one attempt for the critic's sake. `retry` stays a supported
value and works as D116 describes (defects it can point to go back once per
job, inside the three attempts), and `off` still turns the critic off.

**The pass mark.** A video passes the critic when no score of the five is
below 3 and the mean of the five is at least 3.5. Zero defects is no longer
the bar. The rule is `passesCritic` in `packages/schema/src/shared.ts`, with
`CRITIC_PASS_MIN_SCORE` (3) and `CRITIC_PASS_MIN_MEAN` (3.5) beside the
critic's types. The bench's `compare` and `critic` records call that one
function. A missing, malformed or out of range score fails. With whole
scores the mean is a multiple of 0.2, so in practice the mean bar is 3.6.

**The mark is provisional.** The threshold was picked after seeing the
benchmark data, so nothing yet shows it separates a good video from a poor
one. It stands until the owner's own thumbs ratings can calibrate it, as
D116 said of scores in general. On the benchmark it passes 6 of 12 videos
before and 8 of 12 after, against 0 and 0 under the old rule. Those two
counts illustrate the mark and do not prove it.

**The retry and the pass mark are separate things.** In `retry` mode a retry
is triggered by defects: the critic named at least one it can point to in a
scene, the job has attempts left, and the retry has not been spent. The pass
mark reads scores and triggers nothing. A video can pass with defects and
fail with none, and a job in any mode reaches review either way.

**Old records.** `passed` on a bench run's `critic` is still written, now by
the new rule. A run file written before this change holds `passed` by the old
rule (no defect on the last attempt). `compare` does not trust the stored
value: it recomputes the pass from the stored scores, so old and new run
files are judged the same way. Nothing is renamed or dropped in `job.run`,
the run file or any `--json` output.

Why: the retry was $20.22 of the $33.82 the twelve jobs cost and moved the
critic's mean from 3.55 to 3.70, and zero of 24 videos had zero defects, so
the old mark separated nothing. Reporting keeps the read, which costs about
$0.05 a video, and drops the part that cost the most.

## The pieces

| Piece | What it is | Where it is written down | State |
| --- | --- | --- | --- |
| Benchmark | Twelve stored briefs, a command that runs them through the video runner on a scratch home under a required spend cap, and a report comparing two runs | `docs/STUDIO-BENCH.md` | built ([#721](https://github.com/promethevs-labs/hermes-studio/pull/721)) |
| Critic record | `critic` on a run record's attempt, and a `critic` column in `catalog eval report` | `services/catalog/SCHEMA.md` | built ([#719](https://github.com/promethevs-labs/hermes-studio/pull/719)) |
| Shot plan | `scenes[].shot` on the brief, the art-director turn, the card, and the plan in the video agent's prompt | [STUDIO-VIDEOS.md](STUDIO-VIDEOS.md), "The shot plan" | built ([#722](https://github.com/promethevs-labs/hermes-studio/pull/722)) |
| Shot library | A theme, shot patterns for every shot type, motion presets, icons, and a gallery with a thumbnail and a "use when" line per pattern, in remotionkc | `tools/remotionkc/docs/SHOTS.md` | built ([remotionkc #11](https://github.com/promethevs-labs/remotionkc/pull/11)) |
| Critic | The model call after the gate, the scores on the job panel, and the one retry it may cause (only with `STUDIO_VIDEO_CRITIC=retry`; the default is `report`, D121) | [STUDIO-VIDEOS.md](STUDIO-VIDEOS.md) | built ([#726](https://github.com/promethevs-labs/hermes-studio/pull/726)) |
| Manual by purpose | The studio's manuals list a tool's patterns by shot type, never by past use, with worked examples that span the shot types; the art director sees the patterns too | [STUDIO-VIDEO-TOOLS.md](STUDIO-VIDEO-TOOLS.md), "The manual by shot type" | built ([#728](https://github.com/promethevs-labs/hermes-studio/pull/728)) |
| Guidance | [VIDEO-TOOLS.md](VIDEO-TOOLS.md), each tool's `AGENTS.md` and the video skills say what D111 fixes and what must vary | each file | built ([#720](https://github.com/promethevs-labs/hermes-studio/pull/720)); manimkc's own part (its `api` listing grouped by purpose, what a series fixes, and `docs/SHOTS.md`) shipped in [manimkc #86](https://github.com/promethevs-labs/manimkc/pull/86) and is pinned here by the bump that also copies `SHOTS.md` into each manimkc job |

## How the change is measured

The benchmark's briefs are fixed scripts, one for each kind of picture: an
array being searched, a tree growing, a graph traversal, numbers on a chart,
a code walk, a comparison, a sequence over time, a memory view, a request
moving through a system, an equation, a layered structure and a metaphor.
The same twelve run before and after, with the same model. The baseline is
`npm run bench:video -- run`, then `score` on it for the critic's scores;
the run after the changes is `run --shots`, which plans each brief's shots
afresh, and `compare` puts the two side by side (docs/STUDIO-BENCH.md, "A
before and after").

| Measure | From | Better is |
| --- | --- | --- |
| Variety | the look metrics on each video's source | higher |
| Top five helper share | the same | lower |
| Fade share | the same | lower |
| Critic scores | the critic, run on both runs' kept contact sheets | higher |
| Gate pass, attempts, turns, cost, wall time | each job's run record | no worse |

The milestone is done when a video made from the same brief scores higher
variety and a lower top five share after the changes than before, passes the
critic as D116 defines it (no defect on its last attempt), and the manuals no
longer rank anything by past use. The final report gives the five scores for
both runs beside that pass or fail, and says plainly what a paid run did not
verify.

## Results

Both runs were made on 2026-11-20 on the owner's Mac with `npm run
bench:video`: the twelve briefs, remotionkc, the `sonnet` model, a scratch
home, a $50 cap each. The baseline ran the code as it was before the shot
plan (#722), on remotionkc before its shot library; the run after ran main
with every piece merged and `run --shots --critic`. All 24 videos passed the
gate and were accepted.

| Measure | Before | After | Change |
| --- | --- | --- | --- |
| Variety (look metric, mean of 12) | 0.61 | 0.78 | +0.17, higher on 10 briefs, level on 1, lower on 1 |
| Top five helper share | 95% | 71% | 24 points lower, lower on all 12 |
| Fade share | not measured for remotionkc | the same | |
| Videos with 3D | 0 | 0 | |
| Critic: accuracy | 3.9 | 4.0 | +0.1 |
| Critic: layout | 3.3 | 3.3 | level |
| Critic: relevance | 4.7 | 4.4 | 0.3 lower |
| Critic: variety | 2.7 | 3.4 | +0.8 |
| Critic: pacing | 3.4 | 3.4 | level |
| Critic: mean of the five | 3.60 | 3.70 | +0.10 |
| Videos that pass the critic (D116) | 0 of 12 | 0 of 12 | |
| Defects the critic named | 40 | 45 | |
| Gate pass | 12 of 12 | 12 of 12 | |
| Attempts | 13 | 24 | every video took the critic's one retry |
| Turns | 276 | 728 | |
| Cost | $10.21 | $35.38 | 3.5 times: $0.85 a video became $2.95 |
| Wall time | 110 minutes | 190 minutes | 9 minutes a video became 16 |

The milestone's test has three parts. The first two hold: a video made from
the same brief scores higher variety and a lower top five share. The third
does not: no video passes the critic, before or after.

Under the provisional score mark of D121, set later the same day, the same
runs give 6 of 12 videos passing before and 8 of 12 after. The mark was
picked after seeing these numbers, so this illustrates it and does not
prove it. The table row above and the third part of the test are as
D116 defined them when the runs were made.

What the numbers say about each piece:

- **The shot plan, the library and the manual do the work.** The first
  attempts of the run after, before any critic had spoken, already scored
  3.4 for variety from the critic against the baseline's 2.7. The one brief
  whose shot plan failed (the art director wrote a layout line of 203
  characters twice, three over the limit) was made with no plan, from the
  manual and the library alone, and had the highest variety of the run
  (0.90).
- **The critic's retry costs more than it returns.** First attempts cost
  $13.60 and the retries $20.22. Across the retry the critic's mean went
  from 3.55 to 3.70 and the defects it named from 48 to 45. The retry fixed
  what it was sent, and the second read named new defects of the same kinds.
- **Zero defects is a bar no video here meets.** The critic is asked for
  defects it can point to and found three to five on every video of both
  runs. As a pass mark, "no defect" does not separate a good video from a
  poor one; the five scores do.
- **Most defects are small text and empty space.** By a keyword count, 26 of
  the 45 defects left after the retries are about text too small or too
  faint to read and 10 about empty or lopsided frames, against 18 and 4 of
  the baseline's 40. The library's patterns draw smaller type than the
  hand-built scenes did. The library is where to fix that.
- **A reading costs cents.** A shot plan cost $0.02 to $0.06 and a critic
  read about $0.05, so $0.36 and $1.20 of the run after.

What these runs do not show:

- One run a side. The same brief run twice would differ, and nothing here
  measures by how much, so a difference of a few hundredths is noise.
- One tool and one model. Nothing was run on manimkc or revideokc, whose
  manuals also changed, or on another model.
- The two critic columns are not read the same way. The baseline's scores
  are a standalone read made after the run; the scores after are the
  critic's read of a second attempt that had already been sent its first
  read's defects.
- The critic judges its own kind: the same model family wrote the videos.
  No person has rated these 24 videos, and the critic's scores have not been
  compared with a person's.
- A video made through the studio's chat. Every job here was posted by the
  bench, so the planner, the card and Accept in the web app were not part of
  a paid run. The card was checked in a browser with a stand-in model.
- No video used 3D, so the 3D patterns have not been in a finished video.

The run files, each job's source and contact sheets are in the scratch home
the runs used, `~/.hermes-bench/look-20261120` on the owner's Mac. `npm run
bench:video -- compare --home ~/.hermes-bench/look-20261120 baseline after`
prints the tables these numbers come from.

## What this does not do

- It does not change the videos already in the library. They can be rated
  with the "same-look" tag, and remade one at a time.
- It does not give manimkc or revideokc a shot library yet (D113).
- It does not add music, sound effects or footage (D119).
- It does not let a person edit a shot plan on the card. A change is asked
  for in the conversation, as for every other part of a video brief.
