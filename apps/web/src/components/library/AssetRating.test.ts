// @vitest-environment jsdom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ViewRating } from "@/lib/rating-draft";

const actions = vi.hoisted(() => ({
  setRating: vi.fn(),
  dismissRatingPrompt: vi.fn(),
}));
vi.mock("@/lib/asset-actions", () => actions);

const { RatingCard, RatingContext, RatingThumbs, useAssetRating, YourRating } = await import("./AssetRating");

/**
 * The rating card under a library video, driven the way the page drives it:
 * the thumbs in the action row, the card, the Details row, and the crossing
 * `LibraryVideo` reports. The video stands in as a button that calls
 * `crossed`, which is all `LibraryVideo` does with the watched threshold.
 */

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

beforeEach(() => {
  actions.setRating.mockReset();
  actions.dismissRatingPrompt.mockReset();
  actions.setRating.mockImplementation(async (_id: string, rating: ViewRating) => ({
    ok: true,
    value: { value: rating.value, tags: rating.tags ?? [], note: rating.note ?? null },
  }));
  actions.dismissRatingPrompt.mockResolvedValue({ ok: true, value: null });
});

function Harness({ rating, dismissed }: { rating: ViewRating | null; dismissed: boolean }): ReactElement {
  const state = useAssetRating({ assetId: "manimkc:out/a.mp4", rating, dismissed });
  return createElement(
    RatingContext,
    { value: state.state.stored },
    createElement("button", { id: "watched", onClick: state.crossed }, "watched"),
    createElement(RatingThumbs, { rating: state }),
    createElement(RatingCard, { rating: state }),
    createElement("div", { id: "details" }, createElement(YourRating)),
  );
}

async function mount(rating: ViewRating | null = null, dismissed = false) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(Harness, { rating, dismissed }));
  });
  const q = <T extends Element>(selector: string) => {
    const found = host.querySelector<T>(selector);
    if (found === null) throw new Error(`nothing matches ${selector}`);
    return found;
  };
  return {
    host,
    thumb: (words: "Good" | "Not good") => q<HTMLButtonElement>(`button[title="${words}"]`),
    pill: (words: string) => {
      const found = [...host.querySelectorAll("button")].find((b) => b.textContent === words && b.title === "");
      if (found === undefined) throw new Error(`no ${words} button`);
      return found;
    },
    section: () => q<HTMLElement>("section"),
    isOpen: () => q<HTMLElement>("section").closest("[inert]") === null,
    details: () => q<HTMLElement>("#details").textContent,
    watched: () => q<HTMLButtonElement>("#watched"),
  };
}

const click = async (button: HTMLElement) => {
  await act(async () => {
    button.click();
  });
};

function type(field: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the thumbs", () => {
  it("start shut with neither pressed", async () => {
    const ui = await mount();
    expect(ui.isOpen()).toBe(false);
    expect(ui.thumb("Good").getAttribute("aria-pressed")).toBe("false");
    expect(ui.thumb("Not good").getAttribute("aria-pressed")).toBe("false");
  });

  it("save the value at once on a press, open the card and put focus on the first tag", async () => {
    const ui = await mount();
    await click(ui.thumb("Not good"));
    expect(actions.setRating).toHaveBeenCalledWith("manimkc:out/a.mp4", { value: -1 });
    expect(ui.thumb("Not good").getAttribute("aria-pressed")).toBe("true");
    expect(ui.isOpen()).toBe(true);
    expect(document.activeElement?.textContent).toBe("Looks like the others");
    expect(ui.details()).toBe("Not good");
  });

  it("offer the up tags for Good", async () => {
    const ui = await mount();
    await click(ui.thumb("Good"));
    const names = [...ui.section().querySelectorAll('[role="group"][aria-label="What was good"] button')].map((b) => b.textContent);
    expect(names).toEqual(["Clear", "Good visuals", "Good pacing"]);
  });

  it("take the rating back on a press of the active thumb", async () => {
    const ui = await mount({ value: 1, tags: ["clear"], note: null });
    expect(ui.thumb("Good").getAttribute("aria-pressed")).toBe("true");
    expect(ui.details()).toBe("Good (Clear)");
    await click(ui.thumb("Good"));
    expect(actions.setRating).toHaveBeenCalledWith("manimkc:out/a.mp4", { value: 0 });
    expect(ui.thumb("Good").getAttribute("aria-pressed")).toBe("false");
    expect(ui.isOpen()).toBe(false);
    expect(ui.details()).toBe("");
  });

  it("go back and say so when the route did not take the press", async () => {
    actions.setRating.mockResolvedValueOnce({ ok: false, message: "No asset." });
    const ui = await mount();
    await click(ui.thumb("Good"));
    expect(ui.thumb("Good").getAttribute("aria-pressed")).toBe("false");
    expect(ui.isOpen()).toBe(false);
    expect(ui.host.textContent).toContain("Not saved. Try again.");
    expect(ui.details()).toBe("");
  });
});

describe("the card", () => {
  it("saves the value with the tags and note, closes, and remembers the prompt", async () => {
    const ui = await mount();
    await click(ui.thumb("Not good"));
    await click(ui.pill("Too slow"));
    await click(ui.pill("Voice"));
    await click(ui.pill("Voice"));
    await click(ui.pill("Too long"));
    type(ui.section().querySelector<HTMLInputElement>('input[aria-label="Note"]')!, "  dull start ");
    actions.setRating.mockClear();
    await click(ui.pill("Save"));
    expect(actions.setRating).toHaveBeenCalledTimes(1);
    expect(actions.setRating).toHaveBeenCalledWith("manimkc:out/a.mp4", {
      value: -1,
      tags: ["too-slow", "too-long"],
      note: "dull start",
    });
    expect(ui.isOpen()).toBe(false);
    expect(actions.dismissRatingPrompt).toHaveBeenCalledWith("manimkc:out/a.mp4");
    expect(ui.details()).toBe("Not good (Too slow, Too long)dull start");
  });

  it("keeps the card open with the route's words when a save is refused", async () => {
    const ui = await mount();
    await click(ui.thumb("Good"));
    actions.setRating.mockResolvedValueOnce({ ok: false, message: "Not saved (HTTP 503)." });
    await click(ui.pill("Save"));
    expect(ui.isOpen()).toBe(true);
    expect(ui.section().textContent).toContain("Not saved (HTTP 503).");
    expect(actions.dismissRatingPrompt).not.toHaveBeenCalled();
  });

  it("closes on Dismiss and writes the dismissal, leaving the rating and the thumbs", async () => {
    const ui = await mount();
    await click(ui.thumb("Good"));
    await click(ui.section().querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!);
    expect(ui.isOpen()).toBe(false);
    expect(actions.dismissRatingPrompt).toHaveBeenCalledWith("manimkc:out/a.mp4");
    expect(ui.thumb("Good").getAttribute("aria-pressed")).toBe("true");
    // Focus goes back to the thumb, not to the page.
    expect(document.activeElement).toBe(ui.thumb("Good"));
    // Still ratable from the thumbs.
    await click(ui.thumb("Not good"));
    expect(ui.isOpen()).toBe(true);
  });

  it("takes a choice made in the card as a press of the thumb", async () => {
    const ui = await mount();
    await click(ui.watched());
    expect(ui.section().textContent).toContain("What did you think of this video?");
    await click(ui.pill("Not good"));
    expect(actions.setRating).toHaveBeenCalledWith("manimkc:out/a.mp4", { value: -1 });
    expect(ui.thumb("Not good").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("the watched crossing", () => {
  it("opens the card once when the video is unrated and the prompt was never dismissed, without moving focus", async () => {
    const ui = await mount();
    ui.watched().focus();
    await click(ui.watched());
    expect(ui.isOpen()).toBe(true);
    expect(document.activeElement).toBe(ui.watched());
    // Dismissed, it does not come back on its own.
    await click(ui.section().querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!);
    await click(ui.watched());
    expect(ui.isOpen()).toBe(false);
  });

  it("does not open when the video is already rated", async () => {
    const ui = await mount({ value: -1, tags: [], note: null });
    await click(ui.watched());
    expect(ui.isOpen()).toBe(false);
  });

  it("does not open when the prompt was dismissed on an earlier visit", async () => {
    const ui = await mount(null, true);
    await click(ui.watched());
    expect(ui.isOpen()).toBe(false);
  });

  it("does not open it a second time after the first, whatever closed it", async () => {
    const ui = await mount();
    await click(ui.watched());
    await click(ui.thumb("Good"));
    await click(ui.pill("Save"));
    await click(ui.thumb("Good"));
    expect(ui.isOpen()).toBe(false);
    await click(ui.watched());
    expect(ui.isOpen()).toBe(false);
  });
});
