import { describe, expect, it } from "vitest";

import { SHOT_TYPE_LABELS, SHOT_TYPE_USE, SHOT_TYPES, type ShotType } from "@hermes/schema/shared";

import { readShots } from "../src/drafts/art-director";
import { ART_DIRECTOR_PROMPT, artDirectorMessage, buildArtDirectorSystemPrompt, toolBlock } from "../src/drafts/art-director-prompt";
import { evaluateBrief } from "../src/drafts/planner";
import { BriefError } from "../src/diagram/brief";
import { DATA_FENCE, DATA_FENCE_END } from "../src/diagram/prompt";
import { hasShotPlan, shotPlanHash, validateVideoBrief, withoutShots, withShots, type ValidVideoBrief } from "../src/video/brief";
import { manualText } from "../src/video/manual";
import { videoPaths } from "../src/video/paths";
import { buildVideoPrompt, videoPromptFacing } from "../src/video/prompt";
import { remotionkcManualText, remotionkcPrompt } from "../src/video/remotionkc/manual";
import { revideokcManualText, revideokcPrompt } from "../src/video/revideokc/manual";
import { SHOT_PLAN_STEP, shotTypesSection } from "../src/video/shots";
import { narratedBrief, silentBrief } from "./video-fixture";
import { testVocabulary } from "./vocabulary";

/**
 * The shot plan's rules and words (docs/STUDIO-VIDEOS.md, "The shot plan"),
 * with nothing spawned: the validator's shot rules, the planner's shots
 * stripped, the art director's reply read, and what the video agent is told.
 * The art director's spawns, through a stand-in `claude`, are
 * `art-director.test.ts`.
 */

const vocabulary = testVocabulary();

/** The character the owner's prose never uses, spelled by its code so this file does not use it either. */
const EM_DASH = String.fromCharCode(0x2014);

/** The fixture's narrated two-scene brief, on a topic the test vocabulary holds. */
const narrated = (): ValidVideoBrief => ({ ...narratedBrief(), topic: "tcp-congestion-control" });

function shot(type: ShotType, layout = "Left third: the client box; right two thirds: the API and the database"): Record<string, unknown> {
  return { type, layout, motion: "The request slides right as the voice says crosses", emphasis: "The API box, ringed in the accent colour" };
}

/** A silent brief of `n` scenes on the test vocabulary, each two 8 second beats: its length fits any `n` from 4 to 5. */
function scenes(n: number, types: (ShotType | null)[] = []): Record<string, unknown> {
  const base = silentBrief();
  const beat = (i: number, j: number) => ({ say: `Scene ${i} beat ${j}.`, show: `the picture of scene ${i}`, labels: [], seconds: 8 });
  return {
    ...base,
    topic: "tcp-congestion-control",
    targetSeconds: n * 16,
    scenes: Array.from({ length: n }, (_, i) => ({
      name: `scene_${i}`,
      beats: [beat(i, 0), beat(i, 1)],
      ...(types[i] == null ? {} : { shot: shot(types[i]!) }),
    })),
  };
}

const refusal = (input: unknown): BriefError => {
  try {
    validateVideoBrief(input, vocabulary);
  } catch (error) {
    if (error instanceof BriefError) return error;
    throw error;
  }
  throw new Error("the brief was accepted");
};

describe("the shot vocabulary", () => {
  it("names and explains every type, in sentence case", () => {
    expect(SHOT_TYPES).toHaveLength(12);
    for (const type of SHOT_TYPES) {
      const label = SHOT_TYPE_LABELS[type];
      // Sentence case: a capital first, and lower case after but for "3D".
      expect(label[0]).toBe(label[0]!.toUpperCase());
      const rest = label.replace(/^3D/, "").slice(1);
      expect(rest).toBe(rest.toLowerCase());
      expect(SHOT_TYPE_USE[type].length).toBeGreaterThan(40);
      expect(SHOT_TYPE_USE[type]).not.toContain(EM_DASH);
    }
  });
});

describe("a scene's shot in the validator", () => {
  it("keeps a whole, valid plan, rebuilt field by field", () => {
    const input = scenes(4, ["title", "data-chart", "comparison", "recap-map"]);
    (input.scenes as Record<string, unknown>[])[1]!.shot = { ...shot("data-chart"), extra: "dropped" };
    const brief = validateVideoBrief(input, vocabulary);
    expect(brief.scenes.map((scene) => scene.shot?.type)).toEqual(["title", "data-chart", "comparison", "recap-map"]);
    expect(brief.scenes[1]!.shot).toEqual(shot("data-chart"));
    expect(hasShotPlan(brief)).toBe(true);
  });

  it("keeps a brief with no shots at all valid, as every brief before the plan was", () => {
    const brief = validateVideoBrief(scenes(4), vocabulary);
    expect(brief.scenes.every((scene) => !("shot" in scene))).toBe(true);
    expect(hasShotPlan(brief)).toBe(false);
  });

  it("refuses a brief where only some scenes have a shot, naming the first without one", () => {
    const error = refusal(scenes(4, ["title", "data-chart", null, "recap-map"]));
    expect(error.field).toBe("scenes[2].shot");
    expect(error.message).toMatch(/every scene has a shot, or none does/);
  });

  it("refuses one type on more than half of four or more scenes, and allows exactly half", () => {
    expect(() => validateVideoBrief(scenes(4, ["data-chart", "comparison", "data-chart", "timeline"]), vocabulary)).not.toThrow();
    const error = refusal(scenes(4, ["data-chart", "data-chart", "comparison", "data-chart"]));
    expect(error.field).toBe("scenes[3].shot.type");
    expect(error.message).toMatch(/more than half/);
    expect(refusal(scenes(5, ["metaphor", "metaphor", "comparison", "metaphor", "timeline"])).field).toBe("scenes[3].shot.type");
  });

  it("lets a two-scene brief repeat a type, which the variety rule leaves alone below four scenes", () => {
    const brief = narrated();
    const input = { ...brief, scenes: brief.scenes.map((scene) => ({ ...scene, shot: shot("build-up-diagram") })) };
    expect(validateVideoBrief(input, vocabulary).scenes.map((scene) => scene.shot?.type)).toEqual(["build-up-diagram", "build-up-diagram"]);
  });

  it("refuses title or recap-map twice in any brief", () => {
    expect(refusal(scenes(4, ["title", "data-chart", "title", "recap-map"])).field).toBe("scenes[2].shot.type");
    const brief = narrated();
    const twice = { ...brief, scenes: brief.scenes.map((scene) => ({ ...scene, shot: shot("recap-map") })) };
    expect(refusal(twice)).toMatchObject({ field: "scenes[1].shot.type" });
  });

  it("refuses bad text: an unknown type, an empty, long, multi-line or quoted field", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...shot("title"), type: "slideshow" }, "scenes[1].shot.type"],
      [{ ...shot("title"), layout: "  " }, "scenes[1].shot.layout"],
      [{ ...shot("title"), layout: "x".repeat(201) }, "scenes[1].shot.layout"],
      [{ ...shot("title"), motion: "one\ntwo" }, "scenes[1].shot.motion"],
      [{ ...shot("title"), emphasis: 'the "API" box' }, "scenes[1].shot.emphasis"],
      [{ ...shot("title"), emphasis: "x".repeat(161) }, "scenes[1].shot.emphasis"],
      [{ type: "title", layout: "centre" }, "scenes[1].shot.motion"],
    ];
    for (const [bad, field] of cases) {
      const input = scenes(4, ["title", "data-chart", "comparison", "recap-map"]);
      (input.scenes as Record<string, unknown>[])[1]!.shot = bad;
      expect(refusal(input).field).toBe(field);
    }
    const input = scenes(4, ["title", "data-chart", "comparison", "recap-map"]);
    (input.scenes as Record<string, unknown>[])[1]!.shot = "a chart";
    expect(refusal(input).field).toBe("scenes[1].shot");
  });
});

describe("the planner never writes shots", () => {
  it("drops every shot a planner's video block carries, whole or partial, before the validator reads it", async () => {
    const brief = narrated();
    const topics = { dryRun: async () => ({ ok: true, offline: false, error: null, json: null }) };
    const forged = {
      ...brief,
      topic: "tcp-congestion-control",
      scenes: [{ ...brief.scenes[0], shot: shot("title") }, brief.scenes[1]],
    };
    delete (forged as Partial<ValidVideoBrief>).idempotencyKey;
    const verdict = await evaluateBrief("video", JSON.stringify(forged), "", vocabulary, topics);
    expect(verdict.kind).toBe("valid");
    if (verdict.kind !== "valid") return;
    expect((verdict.brief as ValidVideoBrief).scenes.every((scene) => scene.shot === undefined)).toBe(true);
  });
});

describe("the reuse hash", () => {
  it("moves with a scene's words and nothing else", () => {
    const brief = narrated();
    const hash = shotPlanHash(brief);
    expect(shotPlanHash({ ...brief, title: "Another title", tool: "revideokc" } as ValidVideoBrief)).toBe(hash);
    expect(shotPlanHash(withShots(brief, [shot("title"), shot("recap-map")] as never))).toBe(hash);
    const reworded = { ...brief, scenes: [{ ...brief.scenes[0]!, beats: [{ ...brief.scenes[0]!.beats[0]!, show: "three boxes" }] }, brief.scenes[1]!] };
    expect(shotPlanHash(reworded)).not.toBe(hash);
    expect(withoutShots(withShots(brief, [shot("title"), shot("recap-map")] as never)).scenes).toEqual(brief.scenes);
  });
});

describe("the art director's reply", () => {
  const brief = narrated();
  const reply = (entries: unknown[]): string => `Here is the plan.\n\n\`\`\`shots\n${JSON.stringify({ scenes: entries })}\n\`\`\``;
  const both = [
    { name: "why_it_matters", shot: shot("build-up-diagram") },
    { name: "recap", shot: shot("recap-map") },
  ];

  it("is read as one shot per scene", () => {
    const read = readShots(reply(both), brief);
    expect(read).toEqual({ shots: [shot("build-up-diagram"), shot("recap-map")] });
  });

  it("names exactly what is wrong", () => {
    expect(readShots("No block here.", brief)).toEqual({ problem: "The reply has no fenced block tagged shots." });
    expect(readShots("```shots\n{not json\n```", brief)).toMatchObject({ problem: expect.stringMatching(/^The shots block is not JSON/) });
    expect(readShots(reply(both.slice(0, 1)), brief)).toMatchObject({ problem: expect.stringMatching(/1 entries and the brief has 2 scenes/) });
    expect(readShots(reply([both[1], both[0]]), brief)).toMatchObject({ problem: expect.stringMatching(/^scenes\[0\]\.name: /) });
    expect(readShots(reply([both[0], { name: "recap", shot: { ...shot("recap-map"), layout: "" } }]), brief)).toMatchObject({
      problem: expect.stringMatching(/^scenes\[1\]\.shot\.layout: /),
    });
    expect(readShots(reply([{ name: "why_it_matters", shot: shot("title") }, { name: "recap", shot: shot("title") }]), brief)).toMatchObject({
      problem: expect.stringMatching(/^scenes\[1\]\.shot\.type: .*at most once/),
    });
  });
});

describe("the art director's prompt", () => {
  it("states its role, every shot type with its use, the variety rule and the reply, and is data-fenced", () => {
    for (const type of SHOT_TYPES) expect(ART_DIRECTOR_PROMPT).toContain(`${type} | ${SHOT_TYPE_LABELS[type]} | ${SHOT_TYPE_USE[type]}`);
    expect(ART_DIRECTOR_PROMPT).toContain("You never change the script");
    expect(ART_DIRECTOR_PROMPT).toContain("no one type may be on more than half");
    expect(ART_DIRECTOR_PROMPT).toContain("```shots");
    expect(ART_DIRECTOR_PROMPT).not.toContain(EM_DASH);
    const system = buildArtDirectorSystemPrompt("remotionkc");
    expect(system.startsWith(ART_DIRECTOR_PROMPT)).toBe(true);
    expect(system).toContain(toolBlock("remotionkc"));
    expect(toolBlock("remotionkc")).toMatch(/^-----BEGIN TOOL-----\ntool: remotionkc\nbest at: Remotion/);
    expect(toolBlock("remotionkc")).toContain("Data charts from real data | yes");
    const message = artDirectorMessage(narratedBrief());
    expect(message).toContain(DATA_FENCE);
    expect(message.trimEnd().endsWith(DATA_FENCE_END)).toBe(true);
    expect(message).toContain('"name": "why_it_matters"');
  });
});

describe("the video agent", () => {
  const plain = narrated();
  const planned = withShots(plain, [shot("build-up-diagram"), shot("recap-map")] as never);
  const classes = ["TB1_WhyItMatters", "TB2_Recap"];
  const paths = videoPaths("job-shots", "two-boxes");

  it("reads each scene's shot in the brief", () => {
    expect(videoPromptFacing(planned, classes).scenes).toEqual([
      { class: "TB1_WhyItMatters", name: "why_it_matters", shot: shot("build-up-diagram"), beats: plain.scenes[0]!.beats },
      { class: "TB2_Recap", name: "recap", shot: shot("recap-map"), beats: plain.scenes[1]!.beats },
    ]);
    expect((videoPromptFacing(plain, classes).scenes as Record<string, unknown>[]).every((scene) => !("shot" in scene))).toBe(true);
  });

  it("gains the shot step in each tool's first prompt only when the brief has shots", () => {
    const prompts = (brief: ValidVideoBrief): string[] => [
      buildVideoPrompt({ brief, paths, classes, change: false }),
      remotionkcPrompt({ kind: "first", brief, paths, classes, change: false }),
      revideokcPrompt({ kind: "first", brief, paths, classes, change: false }),
    ];
    for (const text of prompts(planned)) {
      expect(text).toContain(`4. ${SHOT_PLAN_STEP}`);
      expect(text).toMatch(/^6\. Your final message/m);
    }
    for (const text of prompts(plain)) {
      expect(text).not.toContain(SHOT_PLAN_STEP);
      expect(text).toMatch(/^5\. Your final message/m);
    }
  });

  it("finds the shot types in every tool's manual", () => {
    const section = shotTypesSection();
    for (const type of SHOT_TYPES) expect(section).toContain(`- \`${type}\` (${SHOT_TYPE_LABELS[type]}): ${SHOT_TYPE_USE[type]}.`);
    expect(manualText("/job/manimkc", "")).toContain(section);
    expect(remotionkcManualText("/job/remotionkc", "", paths)).toContain(section);
    expect(revideokcManualText("/job/revideokc", "", paths)).toContain(section);
  });
});
