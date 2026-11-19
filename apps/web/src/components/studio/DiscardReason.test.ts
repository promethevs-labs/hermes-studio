// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { JobReview } from "@hermes/schema/shared";
import type { VideoJob } from "@/lib/studio-video-job";

const router = { push: vi.fn(), refresh: vi.fn(), replace: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: unknown; href: string }) => createElement("a", { href, ...rest }, children as never),
}));
type Answer = { ok: boolean; text: string; next: string | null; data: Record<string, unknown> };
const verb = {
  run: vi.fn<(...args: unknown[]) => Promise<Answer>>(async () => ({ ok: true, text: "Done.", next: null, data: {} })),
};
// `busy` is the verb in flight, as the real hook holds it.
vi.mock("@/components/studio/use-job-verb", async () => {
  const { useState } = await import("react");
  return {
    useJobVerb: () => {
      const [busy, setBusy] = useState<string | null>(null);
      const run = async (jobId: string, name: string, ...rest: unknown[]) => {
        setBusy(name);
        try {
          return await verb.run(jobId, name, ...rest);
        } finally {
          setBusy(null);
        }
      };
      return { run, refresh: vi.fn(), busy, send: vi.fn(), go: vi.fn() };
    },
  };
});

const { DiscardedReason, DiscardReasonCard } = await import("./DiscardReason");
const { Actions } = await import("./video/VideoJobPanel");

/**
 * What a Discard press does on a video job in review: it opens a card that
 * asks why, and the card's three ways out. Skip discards as before, with no
 * reason. Discard sends the tags and the note. Keep it discards nothing. A
 * refusal from the runner shows in the card and leaves the job alone. A
 * discarded job says why, and says nothing when its record carries no review
 * (a runner one version behind).
 */

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  vi.clearAllMocks();
});

const JOB = { jobId: "j1", kind: "video", state: "awaiting_review" } as unknown as VideoJob;

async function mountNode(node: ReturnType<typeof createElement>): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
  });
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}

const mountActions = () =>
  mountNode(createElement(Actions, { job: JOB, path: "/studio?job=j1", accept: true, discard: true, change: true }));

const button = (host: HTMLElement, name: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll("button")].find((entry) => entry.textContent === name);
  if (found === undefined) throw new Error(`no ${name} button`);
  return found;
};
const press = async (host: HTMLElement, name: string) => {
  await act(async () => {
    button(host, name).click();
  });
};
function type(field: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Discard on a video job in review", () => {
  it("asks why, and sends nothing until a way out is pressed", async () => {
    const host = await mountActions();
    await press(host, "Discard");
    expect(host.querySelector("h3")?.textContent).toBe("Why discard this video?");
    expect(verb.run).not.toHaveBeenCalled();
    // The tags are the down tags, by their labels.
    const tags = [...host.querySelectorAll('[role="group"] button')].map((b) => b.textContent);
    expect(tags).toEqual([
      "Looks like the others",
      "Too much text",
      "Too slow",
      "Too fast",
      "Picture does not match the words",
      "Wrong or misleading",
      "Voice",
      "Too long",
    ]);
    expect((host.querySelector("input") as HTMLInputElement).placeholder).toBe("Anything else? (optional)");
  });

  it("Skip discards with no reason, exactly as the old confirm did", async () => {
    const host = await mountActions();
    await press(host, "Discard");
    await press(host, "Skip");
    expect(verb.run).toHaveBeenCalledTimes(1);
    expect(verb.run).toHaveBeenCalledWith("j1", "discard");
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("Discard sends the chosen tags and the note", async () => {
    const host = await mountActions();
    await press(host, "Discard");
    await press(host, "Too slow");
    await press(host, "Voice");
    await press(host, "Too slow");
    await press(host, "Wrong or misleading");
    type(host.querySelector("input") as HTMLInputElement, "  the narrator mumbles ");
    // The card's own Discard, the second button of that name once the card is open.
    const discard = [...host.querySelectorAll("button")].filter((b) => b.textContent === "Discard");
    expect(discard).toHaveLength(1);
    await act(async () => {
      discard[0]!.click();
    });
    expect(verb.run).toHaveBeenCalledWith("j1", "discard", { body: { tags: ["voice", "wrong"], note: "the narrator mumbles" } });
  });

  it("keeps the card, and says so, when the runner refuses: nothing is discarded", async () => {
    verb.run.mockResolvedValueOnce({ ok: false, text: "tags must come from the down list", next: null, data: {} } as never);
    const host = await mountActions();
    await press(host, "Discard");
    await press(host, "Voice");
    await press(host, "Discard");
    expect(host.querySelector("h3")?.textContent).toBe("Why discard this video?");
    expect(host.textContent).toContain("tags must come from the down list");
    // The tag is still chosen, so a second try needs no retyping.
    expect(button(host, "Voice").getAttribute("aria-pressed")).toBe("true");
  });

  it("Keep it puts the card away without discarding", async () => {
    const host = await mountActions();
    await press(host, "Discard");
    await press(host, "Keep it");
    expect(verb.run).not.toHaveBeenCalled();
    expect(host.querySelector("h3")).toBeNull();
    expect(button(host, "Discard")).toBeTruthy();
  });

  it("says Discarding on the press that sent it, and waits on every press while it runs", async () => {
    let finish: () => void = () => {};
    verb.run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ ok: true, text: "Done.", next: null, data: {} });
        }),
    );
    const host = await mountActions();
    await press(host, "Discard");
    await press(host, "Skip");
    expect(button(host, "Discarding").disabled).toBe(true);
    expect(button(host, "Discard").disabled).toBe(true);
    expect(button(host, "Accept").disabled).toBe(true);
    await act(async () => finish());
    expect(verb.run).toHaveBeenCalledTimes(1);
  });
});

describe("the reason card for a diagram", () => {
  it("offers only the reasons a still picture can have", async () => {
    const host = await mountNode(
      createElement(DiscardReasonCard, {
        subject: "diagram",
        discarding: false,
        disabled: false,
        onSkip: () => {},
        onDiscard: () => {},
        onKeep: () => {},
      }),
    );
    expect(host.querySelector("h3")?.textContent).toBe("Why discard this diagram?");
    const tags = [...host.querySelectorAll('[role="group"] button')].map((b) => b.textContent);
    expect(tags).toEqual(["Looks like the others", "Too much text", "Wrong or misleading"]);
  });
});

describe("DiscardedReason", () => {
  const review = (patch: Partial<JobReview>): JobReview => ({
    verdict: "discard",
    tags: [],
    note: null,
    at: "2026-11-20T10:00:00.000Z",
    ...patch,
  });
  const text = async (value: JobReview | null | undefined) =>
    (await mountNode(createElement(DiscardedReason, { review: value }))).textContent;

  it("shows the tag labels and the note of a discard that gave a reason", async () => {
    expect(await text(review({ tags: ["too-slow", "voice"], note: "mumbles" }))).toBe("Reason: Too slow, Voice.mumbles");
  });

  it("renders nothing for a missing review field, a null, a Skip, or an accept", async () => {
    expect(await text(undefined)).toBe("");
    expect(await text(null)).toBe("");
    expect(await text(review({}))).toBe("");
    expect(await text(review({ verdict: "accept", tags: ["voice"] }))).toBe("");
  });
});
