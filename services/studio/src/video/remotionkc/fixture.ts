/**
 * The remotionkc doctor's fixture (phase 3 of docs/STUDIO-VIDEO-TOOLS.md): a
 * small topic built from two of the library's shot patterns, an
 * `EquationFocus` (KaTeX, its terms lit on spoken words) and a `Stage3D` (a
 * lit three.js card with a shadow and a label pinned to it, through
 * `@remotion/three`), inside the series theme, so a doctor that renders it
 * proves the parts a real job needs: WebGL through Metal inside the profile,
 * KaTeX's fonts, the theme and the patterns, both ports (the server and
 * Chrome's DevTools), narration in the narration profile, and the sidecars
 * after the build.
 *
 * It is also the first of the manual's worked compositions (`manual.ts`):
 * the agent learns from code this machine has rendered inside the same
 * profile its own will. The second is `worked.ts`, which the real-sandbox
 * suite renders.
 */

/** Two short chapters, about ten seconds voiced. */
export const FIXTURE_NARRATION = [
  {
    scene: "DF1_Formula",
    title: "A formula, term by term",
    lines: ["The formula lights one term, then the other, and adds them up."],
  },
  {
    scene: "DF2_Stage",
    title: "A stage in depth",
    lines: ["Then a lit card turns on a stage, and its shadow turns with it."],
  },
] as const;

export const FIXTURE_TOPIC_YML = `title: "Doctor fixture"
topic: doctor-fixture
concepts: []
tags: []
prerequisites: []
materials: []
prefix: DF
narrated:
  composition: composition.tsx
  output: doctor_fixture.mp4
`;

/** A string in the fixture's source that the doctor's gate parse must find. */
export const FIXTURE_LABEL = "A lit card";

/** The worked composition: an equation lit term by term, then a lit three.js card with a shadow. */
export const FIXTURE_COMPOSITION = `// The doctor's fixture and a worked composition: two shot patterns in the
// series theme, an equation (EquationFocus) and an object in 3D (Stage3D),
// each cued on a spoken word, one Sequence per scene with its own heading.
import React from "react";
import { Sequence, useCurrentFrame } from "remotion";
import { EquationFocus, NarrationTrack, SceneFrame, Stage3D, ThemeProvider, defineTopic, ramp, sceneCues, seriesTheme, useTheme, type TimedScene, type TopicProps } from "#lib";

// The series look: one theme for the whole topic. Colours and fonts come from it, never literals.
const THEME = seriesTheme();
const KICKER = "Doctor fixture";

const Formula: React.FC<{ scene: TimedScene }> = ({ scene }) => {
  const cue = sceneCues(scene);
  return (
    <SceneFrame kicker={KICKER} index={1} title={scene.title}>
      <EquationFocus
        tex={String.raw\`\\htmlClass{a}{4} + \\htmlClass{b}{12}\`}
        colors={{ a: 1, b: 0 }}
        parts={{ a: [[cue.at(0, "term"), "focus"], [cue.at(0, "other"), "normal"]], b: [[cue.at(0, "other"), "focus"]] }}
        notes={[{ part: "a", text: "one term", at: cue.at(0, "term") }, { part: "b", text: "the other", at: cue.at(0, "other") }]}
        worked={{ tex: String.raw\`= 16\`, at: cue.at(0, "adds") }}
        share={{ at: cue.at(0, "adds"), caption: "Where the sixteen comes from", segments: [{ part: "a", label: "one term", value: 4 }, { part: "b", label: "the other", value: 12 }] }}
        size={150}
      />
    </SceneFrame>
  );
};

const Stage: React.FC<{ scene: TimedScene }> = ({ scene }) => {
  const t = useTheme();
  const f = useCurrentFrame();
  const cue = sceneCues(scene);
  // Everything that moves takes its value from the frame, never useFrame().
  const turn = ramp(f, cue.at(0, "turns"), 45);
  return (
    <SceneFrame kicker={KICKER} index={2} title={scene.title}>
      <Stage3D camera={{ preset: "orbit", from: 0, to: scene.durationInFrames, target: [0, 0.8, 0], distance: 8, elevation: 22, amount: 30 }}
        labels={[{ text: "A lit card", sub: "its shadow turns with it", position: [0, 1.7, 0], at: cue.at(0, "card") }]}>
        <mesh position={[0, 0.9, 0]} rotation={[0, -0.9 * turn, 0]} castShadow>
          <boxGeometry args={[2.6, 1.6, 0.12]} />
          <meshStandardMaterial color={t.color.accent} metalness={0.2} roughness={0.4} />
        </mesh>
      </Stage3D>
    </SceneFrame>
  );
};

const VIEWS: Record<string, React.FC<{ scene: TimedScene }>> = { DF1_Formula: Formula, DF2_Stage: Stage };

const Fixture: React.FC<TopicProps> = ({ timeline }) => {
  if (!timeline) return null;
  return (
    <ThemeProvider theme={THEME}>
      <NarrationTrack timeline={timeline} />
      {timeline.scenes.map((s) => {
        const View = VIEWS[s.scene]!;
        return (
          <Sequence key={s.scene} from={s.from} durationInFrames={s.durationInFrames}>
            <View scene={s} />
          </Sequence>
        );
      })}
    </ThemeProvider>
  );
};

export default defineTopic({ component: Fixture });
`;
