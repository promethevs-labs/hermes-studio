# The look of a video: art direction, a shot library and a critic

How the studio stops making videos that all look the same, and how it proves
the change. This is the milestone plan and the decisions behind it. Each
piece ships as its own pull request and records its details in the document
that owns that part of the studio; this page is where to start.

**Status: accepted 2026-11-20, every default taken by the owner. In
progress.** The table under "The pieces" says what is built.

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

## The pieces

| Piece | What it is | Where it is written down | State |
| --- | --- | --- | --- |
| Benchmark | Twelve stored briefs, a command that runs them through the video runner on a scratch home under a required spend cap, and a report comparing two runs | `docs/STUDIO-BENCH.md` | built ([#721](https://github.com/promethevs-labs/hermes-studio/pull/721)) |
| Critic record | `critic` on a run record's attempt, and a `critic` column in `catalog eval report` | `services/catalog/SCHEMA.md` | built ([#719](https://github.com/promethevs-labs/hermes-studio/pull/719)) |
| Shot plan | `scenes[].shot` on the brief, the art-director turn, the card, and the plan in the video agent's prompt | [STUDIO-VIDEOS.md](STUDIO-VIDEOS.md), "The shot plan" | built ([#722](https://github.com/promethevs-labs/hermes-studio/pull/722)) |
| Shot library | A theme, shot patterns for every shot type, motion presets, icons, and a gallery with a thumbnail and a "use when" line per pattern, in remotionkc | `tools/remotionkc/docs/SHOTS.md` | built ([remotionkc #11](https://github.com/promethevs-labs/remotionkc/pull/11)) |
| Critic | The model call after the gate, the one retry it may cause, and the scores on the job panel | [STUDIO-VIDEOS.md](STUDIO-VIDEOS.md) | built ([#726](https://github.com/promethevs-labs/hermes-studio/pull/726)) |
| Manual by purpose | The studio's manuals list a tool's patterns by shot type, never by past use, with worked examples that span the shot types; the art director sees the patterns too | [STUDIO-VIDEO-TOOLS.md](STUDIO-VIDEO-TOOLS.md), "The manual by shot type" | built ([#728](https://github.com/promethevs-labs/hermes-studio/pull/728)) |
| Guidance | [VIDEO-TOOLS.md](VIDEO-TOOLS.md), each tool's `AGENTS.md` and the video skills say what D111 fixes and what must vary | each file | built ([#720](https://github.com/promethevs-labs/hermes-studio/pull/720)) |

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

## What this does not do

- It does not change the videos already in the library. They can be rated
  with the "same-look" tag, and remade one at a time.
- It does not give manimkc or revideokc a shot library yet (D113).
- It does not add music, sound effects or footage (D119).
- It does not let a person edit a shot plan on the card. A change is asked
  for in the conversation, as for every other part of a video brief.
