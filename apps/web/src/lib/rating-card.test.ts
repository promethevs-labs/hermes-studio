import { describe, expect, it } from "vitest";

import { cardReducer, initialCard, type CardAction, type CardState } from "./rating-card";

/**
 * The rating card's rules, as transitions: what a thumb press, the watched
 * crossing and a close each do to the card.
 */

const run = (state: CardState, ...actions: CardAction[]) => actions.reduce(cardReducer, state);
const fresh = () => initialCard(null, false);

describe("a thumb press", () => {
  it("sets the value at once, opens the card for focus on the first tag, and drops the other choice's tags", () => {
    const rated = run(initialCard({ value: 1, tags: ["clear"], note: null }, true), { type: "choose", value: -1 });
    expect(rated).toMatchObject({ value: -1, tags: [], open: true, openedBy: "thumb" });
  });

  it("keeps the way the card came open when it was already open", () => {
    const opened = run(fresh(), { type: "watched" }, { type: "choose", value: 1 });
    expect(opened).toMatchObject({ value: 1, open: true, openedBy: "watched" });
  });

  it("takes the rating back when it is the active choice, and closes the card", () => {
    const cleared = run(fresh(), { type: "choose", value: 1 }, { type: "toggle", tag: "clear" }, { type: "clear" });
    expect(cleared).toMatchObject({ value: 0, tags: [], note: "", open: false, openedBy: null });
  });
});

describe("the watched crossing", () => {
  it("opens the card on its own when the video is unrated and the prompt was never dismissed", () => {
    expect(run(fresh(), { type: "watched" })).toMatchObject({ open: true, openedBy: "watched", prompted: true });
  });

  it("does not open it when the video is already rated", () => {
    expect(run(initialCard({ value: -1, tags: [], note: null }, false), { type: "watched" }).open).toBe(false);
  });

  it("does not open it when the prompt was dismissed before", () => {
    expect(run(initialCard(null, true), { type: "watched" }).open).toBe(false);
  });

  it("treats a rating that was taken back as unrated", () => {
    expect(run(initialCard({ value: 0, tags: [], note: null }, false), { type: "watched" }).open).toBe(true);
  });

  it("never opens it a second time", () => {
    const closed = run(fresh(), { type: "watched" }, { type: "close" });
    expect(run(closed, { type: "watched" }).open).toBe(false);
    // Even if the dismissal was lost, it has already prompted once.
    expect(run({ ...closed, dismissed: false }, { type: "watched" }).open).toBe(false);
  });
});

describe("closing", () => {
  it("shuts the card and remembers the prompt as dismissed, leaving the rating", () => {
    const closed = run(fresh(), { type: "choose", value: 1 }, { type: "close" });
    expect(closed).toMatchObject({ open: false, dismissed: true, value: 1 });
  });

  it("leaves the thumbs working after a dismissal", () => {
    const again = run(initialCard(null, true), { type: "choose", value: -1 });
    expect(again).toMatchObject({ open: true, value: -1 });
  });
});

describe("the draft", () => {
  it("toggles only the tags the choice offers, and holds the note", () => {
    const state = run(
      fresh(),
      { type: "choose", value: -1 },
      { type: "toggle", tag: "too-slow" },
      { type: "toggle", tag: "clear" },
      { type: "toggle", tag: "voice" },
      { type: "toggle", tag: "too-slow" },
      { type: "note", text: "dull" },
    );
    expect(state.tags).toEqual(["voice"]);
    expect(state.note).toBe("dull");
  });

  it("restores a state it saved before a write that failed", () => {
    const before = fresh();
    const pressed = run(before, { type: "choose", value: 1 });
    expect(run(pressed, { type: "restore", state: before })).toEqual(before);
  });

  it("starts from what the store held", () => {
    expect(initialCard({ value: 1, tags: ["clear"], note: "nice" }, false)).toMatchObject({
      value: 1,
      tags: ["clear"],
      note: "nice",
      open: false,
      stored: { value: 1, tags: ["clear"], note: "nice" },
    });
    expect(initialCard({ value: 0, tags: [], note: null }, false).stored).toBeNull();
  });
});
