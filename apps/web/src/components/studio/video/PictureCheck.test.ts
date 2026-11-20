// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { pictureCheck, stepRows, videoStepCount, type VideoCritic, type VideoJob } from "@/lib/studio-video-job";

import { PictureCheck } from "./VideoJobPanel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));

/**
 * The review's picture check block (docs/STUDIO-VIDEOS.md, "The critic"):
 * nothing with no critic; with one, five tiles, a low score in the warning
 * colour, and one line per defect sent back, per defect still open and per
 * note, each scene named by its title. And the step list shows "Picture
 * check" only where the runner sent the step.
 */

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const mounted: Array<() => void> = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.();
});

const CRITIC: VideoCritic = {
  attempt: 2,
  attempts: 3,
  scores: { accuracy: 4, layout: 3, relevance: 5, variety: 2, pacing: 4 },
  defects: [{ scene: "TB2_Recap", problem: "A label runs off the right edge.", fix: "Shorten it." }],
  notes: ["the two scenes share one layout"],
  sentBack: [{ scene: "TB1_WhyItMatters", problem: "The title overlaps the axis label.", fix: "Move the title up." }],
};

function job(over: Partial<VideoJob> = {}): VideoJob {
  return {
    jobId: "j1",
    kind: "video",
    state: "awaiting_review",
    phase: "ready",
    title: "Two boxes",
    topic: "networks",
    slug: "two-boxes",
    target: "videos/two-boxes.mp4",
    classes: ["TB1_WhyItMatters", "TB2_Recap"],
    draftId: null,
    parentJob: null,
    attempt: 3,
    turns: 2,
    costUsd: 0.1,
    costSource: "result",
    steps: [],
    lineChanges: [],
    gate: null,
    exitCode: 0,
    written: [],
    indexed: false,
    error: null,
    errorKind: null,
    requested: "2026-11-20T00:00:00.000Z",
    started: "2026-11-20T00:00:01.000Z",
    finished: "2026-11-20T00:10:00.000Z",
    updated: "2026-11-20T00:10:00.000Z",
    cancelRequestedAt: null,
    note: "",
    brief: { scenes: [{ name: "why_it_matters" }, { name: "recap" }] } as unknown as VideoJob["brief"],
    critic: CRITIC,
    ...over,
  };
}

async function mount(value: VideoJob): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(PictureCheck, { job: value, chapters: null }));
  });
  mounted.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}

describe("PictureCheck", () => {
  it("draws nothing when no critic scored the job", async () => {
    expect((await mount(job({ critic: null }))).innerHTML).toBe("");
    expect((await mount(job({ critic: undefined }))).innerHTML).toBe("");
  });

  it("shows the five scores, the attempt, and each line with its badge", async () => {
    const host = await mount(job());
    expect(host.querySelector("h3")?.textContent).toBe("Picture check");
    expect(host.textContent).toContain("Attempt 2 of 3");
    const tiles = [...host.querySelectorAll("ul")[0]!.querySelectorAll("li")];
    expect(tiles.map((tile) => tile.textContent)).toEqual(["Matches the words4 / 5", "Layout3 / 5", "Relevance5 / 5", "Variety2 / 5", "Pacing4 / 5"]);
    // A score of 3 or less reads in the warning colour, a higher one does not.
    expect(tiles.map((tile) => tile.lastElementChild!.className.includes("text-warn-text"))).toEqual([false, true, false, true, false]);
    const lines = [...host.querySelectorAll("ul")[1]!.querySelectorAll("li")].map((line) => line.textContent);
    expect(lines).toEqual([
      "Sent backWhy it matters: The title overlaps the axis label.",
      "OpenRecap: A label runs off the right edge.",
      "NoteThe two scenes share one layout",
    ]);
  });

  it("after a fallback shows the earlier attempt's defects as open, none sent back", async () => {
    // What the runner sends when the retry did not pass: attempt 1's run, its defect never fixed.
    const host = await mount(job({ critic: { ...CRITIC, attempt: 1, defects: CRITIC.sentBack, sentBack: [], notes: [] } }));
    expect(host.textContent).toContain("Attempt 1 of 3");
    const lines = [...host.querySelectorAll("ul")[1]!.querySelectorAll("li")].map((line) => line.textContent);
    expect(lines).toEqual(["OpenWhy it matters: The title overlaps the axis label."]);
  });

  it("says the build in review was not scored when the scores are an earlier attempt's, its defects sent back", async () => {
    const stale: VideoCritic = {
      ...CRITIC,
      attempt: 1,
      attempts: 2,
      build: 2,
      current: false,
      unscoredReason: "the critic did not answer within 180 s",
      defects: [],
      notes: [],
    };
    const host = await mount(job({ critic: stale }));
    const warning = host.querySelector("p");
    expect(warning?.textContent).toBe("Attempt 2, the build in review, was not scored (the critic did not answer within 180 s). These scores are attempt 1's.");
    expect(warning?.className).toContain("text-warn-text");
    const lines = [...host.querySelectorAll("ul")[1]!.querySelectorAll("li")].map((line) => line.textContent);
    expect(lines).toEqual(["Sent backWhy it matters: The title overlaps the axis label."]);
    // Scores of the build in review need no such line.
    const fresh = await mount(job({ critic: { ...CRITIC, build: 2, current: true, unscoredReason: null } }));
    expect(fresh.querySelector("p")).toBeNull();
  });

  it("leaves out the line list when the critic found nothing", async () => {
    const host = await mount(job({ critic: { ...CRITIC, defects: [], notes: [], sentBack: [] } }));
    expect(host.querySelectorAll("ul")).toHaveLength(1);
  });
});

describe("the picture check's words", () => {
  it("are null with no critic, and name each line's kind", () => {
    expect(pictureCheck(job({ critic: null }))).toBeNull();
    expect(pictureCheck(job())?.lines.map((line) => line.kind)).toEqual(["sent back", "open", "note"]);
  });

  it("make a step only where the runner sent one", () => {
    const step = (name: string, state = "done") => ({ name, state, rounds: 1, note: null }) as VideoJob["steps"][number];
    const without = job({ steps: [step("storyboard"), step("check"), step("ready")] });
    expect(stepRows(without).some((row) => row.key === "critic")).toBe(false);
    const running = job({ state: "running", steps: [step("storyboard"), step("check"), step("critic", "running"), step("ready", "pending")] });
    expect(stepRows(running).find((row) => row.key === "critic")).toMatchObject({ label: "Picture check", status: "current" });
    expect(videoStepCount(running)).toBe("Step 10 of 11");
  });
});
