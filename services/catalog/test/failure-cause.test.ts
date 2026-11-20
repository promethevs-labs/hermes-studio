import { describe, expect, it } from "vitest";

import { classifyFailure, CLASSIFIED_KINDS, countFailures, FAILURE_KINDS, NO_ERROR_KIND } from "../src/ingredients/failure";

describe("classifyFailure", () => {
  // Every error kind the studio's runners assign (diagram/runner.ts, video/runner.ts).
  const expected: Array<[string, "quality" | "infrastructure"]> = [
    ["gate", "quality"],
    ["wrote-outside", "quality"],
    ["timeout", "infrastructure"],
    ["spawn", "infrastructure"],
    ["toolchain", "infrastructure"],
    ["internal", "infrastructure"],
    ["interrupted", "infrastructure"],
    ["cancelled", "infrastructure"],
    ["not-claimed", "infrastructure"],
  ];

  it.each(expected)("classifies %s as %s, whatever the job's numbers", (kind, cause) => {
    expect(classifyFailure({ errorKind: kind })).toEqual({ kind, cause, classified: true });
    expect(classifyFailure({ errorKind: kind, turns: 30, costUsd: 4, gatedAttempts: 3 }).cause).toBe(cause);
    expect(classifyFailure({ errorKind: kind, turns: null, costUsd: null, gatedAttempts: null }).cause).toBe(cause);
  });

  it("has a rule for exactly the kinds above, each with a reason", () => {
    expect(Object.keys(FAILURE_KINDS).sort()).toEqual(expected.map(([kind]) => kind).sort());
    for (const rule of Object.values(FAILURE_KINDS)) expect(rule.reason).not.toBe("");
    expect([...CLASSIFIED_KINDS].sort()).toEqual([...expected.map(([kind]) => kind), "agent"].sort());
  });

  describe("agent", () => {
    it("is infrastructure when the job had no turns, no cost and no attempt at the gate", () => {
      for (const evidence of [
        {},
        { turns: null, costUsd: null },
        { turns: 0, costUsd: 0, gatedAttempts: 0 },
        { turns: null, costUsd: 0, gatedAttempts: null },
      ]) {
        expect(classifyFailure({ errorKind: "agent", ...evidence })).toEqual({
          kind: "agent",
          cause: "infrastructure",
          classified: true,
        });
      }
    });

    it("is quality when the job took a turn, spent money or reached the gate", () => {
      expect(classifyFailure({ errorKind: "agent", turns: 1, costUsd: null }).cause).toBe("quality");
      expect(classifyFailure({ errorKind: "agent", turns: null, costUsd: 0.02 }).cause).toBe("quality");
      // An earlier attempt reached the gate, then a later request was refused.
      expect(classifyFailure({ errorKind: "agent", turns: 1, costUsd: 0, gatedAttempts: 1 }).cause).toBe("quality");
      expect(classifyFailure({ errorKind: "agent", turns: null, costUsd: null, gatedAttempts: 2 }).cause).toBe("quality");
    });
  });

  it("counts an unknown kind as infrastructure and says it is not classified", () => {
    expect(classifyFailure({ errorKind: "meteor", turns: 9, costUsd: 3 })).toEqual({
      kind: "meteor",
      cause: "infrastructure",
      classified: false,
    });
    // A name on the object prototype is not a rule.
    expect(classifyFailure({ errorKind: "constructor" })).toMatchObject({ cause: "infrastructure", classified: false });
  });

  it("counts a missing or blank kind as infrastructure, named (none)", () => {
    for (const errorKind of [null, undefined, "", "  "]) {
      expect(classifyFailure({ errorKind })).toEqual({ kind: NO_ERROR_KIND, cause: "infrastructure", classified: false });
    }
  });
});

describe("countFailures", () => {
  it("counts by kind and cause, most common first, then by name", () => {
    const counts = countFailures([
      { errorKind: "gate", turns: 3, costUsd: 1 },
      { errorKind: "agent" },
      { errorKind: "agent", turns: 5, costUsd: 1 },
      { errorKind: "agent" },
      { errorKind: "timeout" },
      { errorKind: "gate", turns: 3, costUsd: 1 },
    ]);
    expect(counts).toEqual([
      { kind: "agent", cause: "infrastructure", count: 2, classified: true },
      { kind: "gate", cause: "quality", count: 2, classified: true },
      { kind: "agent", cause: "quality", count: 1, classified: true },
      { kind: "timeout", cause: "infrastructure", count: 1, classified: true },
    ]);
  });

  it("is empty with no failed job", () => {
    expect(countFailures([])).toEqual([]);
  });
});
