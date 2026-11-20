/**
 * The manual's second worked composition (`manual.ts`): three scenes of
 * three different shot types, a `SequenceDiagram` (timeline), a `Compare`
 * (comparison) and an `ArrayView` (array-or-memory), in one series theme,
 * joined by `SceneTrack` transitions under one `HeadingBand`, each change
 * cued on the word that names it.
 *
 * The doctor does not render it, to keep its check short; the real-sandbox
 * suite (`test/video-remotionkc-sandbox.test.ts`) narrates, lints, stills and
 * builds it inside the job's profiles, so the manual shows only code that
 * has rendered here.
 */

/** Three chapters, about thirty seconds voiced. */
export const WORKED_NARRATION = [
  {
    scene: "WK1_Handshake",
    title: "Three messages open a connection",
    lines: ["The client says hello, the server answers, and one more reply opens the connection.", "Only then does the page travel: a request, and its answer."],
  },
  {
    scene: "WK2_Choice",
    title: "Two ways to send",
    lines: ["TCP keeps every byte in order, and sends again whatever is lost.", "UDP skips all of that: its header is smaller, and its first byte leaves at once."],
  },
  {
    scene: "WK3_Search",
    title: "Halving the search",
    lines: ["Binary search checks the middle, rules out the left half, and finds twenty-three."],
  },
] as const;

export const WORKED_TOPIC_YML = `title: "Worked composition"
topic: worked-composition
concepts: []
tags: []
prerequisites: []
materials: []
prefix: WK
narrated:
  composition: composition.tsx
  output: worked_composition.mp4
`;

/** Three shot types in one theme, with transitions that keep every cue frame. */
export const WORKED_COMPOSITION = `// A worked composition: three shot types (a sequence diagram, a comparison,
// an array), one series theme, one heading band over a SceneTrack whose
// transitions move no scene in time, every change cued on a spoken word.
import React from "react";
import { ArrayView, Compare, HeadingBand, NarrationTrack, SceneFrame, SceneTrack, SequenceDiagram, ThemeProvider, defineTopic, sceneCues, seriesTheme, type TimedScene, type TopicProps } from "#lib";

const THEME = seriesTheme();

// timeline: parties exchange messages in order, time running down.
const Handshake: React.FC<{ scene: TimedScene }> = ({ scene }) => {
  const cue = sceneCues(scene);
  return (
    <SceneFrame heading={false}>
      <SequenceDiagram
        lanes={[{ name: "Client", icon: "laptop", color: 1 }, { name: "Server", icon: "server", color: 0 }]}
        messages={[
          { from: 0, to: 1, label: "SYN", sub: "hello", at: cue.at(0, "hello") },
          { from: 1, to: 0, label: "SYN-ACK", sub: "the answer", at: cue.at(0, "answers") },
          { from: 0, to: 1, label: "ACK", sub: "one more reply", at: cue.at(0, "reply") },
          { from: 0, to: 1, label: "GET /index.html", at: cue.at(1, "request"), color: 1 },
          { from: 1, to: 0, label: "200 OK", at: cue.at(1, "answer"), color: 2 },
        ]}
        states={[{ lane: 0, after: 2, text: "ESTABLISHED", at: cue.at(0, "opens") }]}
      />
    </SceneFrame>
  );
};

// comparison: two options weighed point by point, a row per spoken point.
const Choice: React.FC<{ scene: TimedScene }> = ({ scene }) => {
  const cue = sceneCues(scene);
  return (
    <SceneFrame heading={false}>
      <Compare
        columns={[{ title: "TCP", sub: "a connection", icon: "link", color: 1 }, { title: "UDP", sub: "single datagrams", icon: "send", color: 4 }]}
        rows={[
          { label: "Order kept", cells: [{ text: "in order", verdict: "yes" }, { text: "any order", verdict: "no" }] },
          { label: "Lost data", cells: [{ text: "sent again", verdict: "yes" }, { text: "gone", verdict: "no" }] },
          { label: "Header", cells: [{ text: "20 bytes", verdict: "partly" }, { text: "8 bytes", verdict: "yes" }] },
          { label: "First byte", cells: [{ text: "after a handshake", verdict: "partly" }, { text: "at once", verdict: "yes" }] },
        ]}
        steps={[cue.at(0, "order"), cue.at(0, "lost"), cue.at(1, "header"), cue.at(1, "once")]}
        highlight={[{ at: cue.at(1, "skips"), index: 1 }]}
      />
    </SceneFrame>
  );
};

// array-or-memory: a pointer moves, a half is ruled out, a cell is found.
const Search: React.FC<{ scene: TimedScene }> = ({ scene }) => {
  const cue = sceneCues(scene);
  return (
    <SceneFrame heading={false}>
      <ArrayView
        name="xs"
        values={[2, 5, 8, 12, 16, 23, 38]}
        pointers={[{ name: "mid", keys: [[cue.at(0, "middle"), 3], [cue.at(0, "finds"), 5]], color: 0 }]}
        discard={[{ at: cue.at(0, "left"), lo: 0, hi: 3 }]}
        compares={[{ at: cue.at(0, "middle"), i: 3 }]}
        marks={[{ at: cue.at(0, "finds"), i: 5, tone: "good" }]}
        notes={[{ at: cue.at(0, "middle"), text: "xs[3] is 12, less than 23: look right" }, { at: cue.at(0, "finds"), text: "xs[5] is 23: found" }]}
      />
    </SceneFrame>
  );
};

const VIEWS: React.FC<{ scene: TimedScene }>[] = [Handshake, Choice, Search];

const Worked: React.FC<TopicProps> = ({ timeline }) => {
  if (!timeline) return null;
  return (
    <ThemeProvider theme={THEME}>
      <NarrationTrack timeline={timeline} />
      <SceneTrack scenes={timeline.scenes} transitions={["cut", "push", "wipe"]} render={(scene, i) => {
        const View = VIEWS[i]!;
        return <View scene={scene} />;
      }} />
      <HeadingBand scenes={timeline.scenes} kicker="Networks and search" />
    </ThemeProvider>
  );
};

export default defineTopic({ component: Worked });
`;
