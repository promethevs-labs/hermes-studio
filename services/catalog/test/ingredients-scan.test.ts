import { describe, expect, it } from "vitest";

import {
  CALLS_CAP,
  INGREDIENTS_SCANNER_VERSION,
  MANIM_ANIMATIONS,
  TS_MOTION_NAMES,
  normalisedEntropy,
  pythonPublicNames,
  scanSources,
  stripPython,
  stripTypeScript,
} from "../src/ingredients/scan";

/**
 * The scanner over small synthetic sources. Nothing here is copied from a
 * real topic: each snippet is the shortest text that shows one rule.
 */

const py = (text: string) => [{ path: "scene.py", text }];
const ts = (text: string, path = "scene.tsx") => [{ path, text }];

describe("stripPython", () => {
  it("keeps offsets and newlines", () => {
    const src = 'a = "x y"  # note\nb = 1\n';
    const { code } = stripPython(src);
    expect(code).toHaveLength(src.length);
    expect(code.split("\n")).toHaveLength(3);
    expect(code).toContain("a =");
    expect(code).not.toContain("note");
  });

  it("does not start a comment at a # inside a string", () => {
    const { code } = stripPython('s = "a # b"; FadeIn(m)\n');
    expect(code).toContain("FadeIn(m)");
  });

  it("blanks triple-quoted strings, prefixes and f-strings", () => {
    const src = [
      '"""Docstring with FadeIn( inside."""',
      'r"""raw FadeOut("""',
      "x = f'{Write(a)} text'",
      "y = rb'bytes ShowCreation('",
      "Keep(1)",
    ].join("\n");
    const { code } = stripPython(src);
    expect(code).not.toMatch(/FadeIn|FadeOut|Write|ShowCreation/);
    expect(code).toContain("Keep(1)");
  });

  it("stops an unterminated string at the end of its line", () => {
    const { code } = stripPython("a = 'oops\nKeep(1)\n");
    expect(code).toContain("Keep(1)");
  });

  it("does not treat an identifier ending in r as a prefix", () => {
    const { code } = stripPython('bar"x"\n');
    expect(code.startsWith("bar")).toBe(true);
  });
});

describe("stripTypeScript", () => {
  it("blanks line and block comments", () => {
    const { code } = stripTypeScript("a(); // b()\n/* c(\n) */ d();\n");
    expect(code).toContain("a()");
    expect(code).toContain("d()");
    expect(code).not.toMatch(/b\(|c\(/);
  });

  it("blanks a template literal's text and keeps its expressions", () => {
    const { code } = stripTypeScript("x = `<Card> ${spring(1)} and ${`<Deep ${all(2)}>`} `;");
    expect(code).not.toContain("<Card");
    expect(code).not.toContain("<Deep");
    expect(code).toContain("spring(1)");
    expect(code).toContain("all(2)");
  });

  it("ends a quoted string at a newline so a JSX apostrophe cannot run on", () => {
    const { code } = stripTypeScript("<p>Don't</p>\nKeep(1);\n");
    expect(code).toContain("Keep(1)");
  });

  it("records the text of quoted strings by quote offset", () => {
    const src = 'import a from "mod";';
    const { strings } = stripTypeScript(src);
    expect(strings.get(src.indexOf('"'))).toBe("mod");
  });
});

describe("scanSources: Python, manimkc", () => {
  it("counts names outside strings and comments only", () => {
    const r = scanSources(
      "manimkc",
      py(
        [
          '"""A docstring that mentions FadeIn(x) and Write(y)."""',
          "# FadeIn(z) in a comment",
          'label = "FadeOut(a)"  # FadeOut(b)',
          "FadeOut(m)",
        ].join("\n"),
      ),
    );
    expect(r.calls).toEqual({ FadeOut: 1 });
    expect(r.metrics.animationCalls).toBe(1);
  });

  it("counts self.play, self.voiceover and rate_func, and not other methods", () => {
    const r = scanSources(
      "manimkc",
      py(
        [
          "class A(Scene):",
          "    def construct(self):",
          "        with self.voiceover(text='x'):",
          "            self.play(FadeIn(a), FadeOut(b), rate_func=smooth)",
          "        self.play(Write(c))",
          "        a.set_color(RED).shift(UP)",
          "        a\\",
          "            .scale(2)",
          "        self.wait(1)",
          "        if rate_func == smooth: pass",
        ].join("\n"),
      ),
    );
    expect(r.metrics.plays).toBe(2);
    expect(r.metrics.voiceovers).toBe(1);
    expect(r.metrics.rateFuncs).toBe(1);
    expect(r.calls).toEqual({ FadeIn: 1, FadeOut: 1, Write: 1 });
  });

  it("does not count a call that starts a line after a dot", () => {
    const r = scanSources(
      "manimkc",
      py("m = Square()\nm = (m\n    .set_color(RED)\n    .shift(UP))\n"),
    );
    expect(r.calls).toEqual({ Square: 1 });
  });

  it("skips keywords, builtins, exceptions, def and class names", () => {
    const r = scanSources(
      "manimkc",
      py(
        [
          "def helper(x):",
          "    return len(x) + max(1, 2)",
          "class Thing(Mobject):",
          "    pass",
          "if (x): raise ValueError('no')",
          "print(sorted(range(3)))",
          "helper(1)",
        ].join("\n"),
      ),
    );
    expect(r.calls).toEqual({ helper: 1 });
  });

  it("parses explicit, aliased and parenthesised multi-line imports", () => {
    const r = scanSources(
      "manimkc",
      py(
        [
          "from manimlib import *",
          "from lesson import (",
          "    heading,  # the title",
          "    body as b,",
          "    PANEL_BG,",
          ")",
          "from cslib import caption, MONO",
          "from pl_common import words",
          "heading('t'); b('x'); b('y'); caption('c'); words('w')",
        ].join("\n"),
      ),
    );
    expect(r.calls).toEqual({ body: 2, caption: 1, heading: 1, words: 1 });
    expect(r.metrics.helperCalls).toBe(4);
    expect(r.metrics.distinctHelpers).toBe(3);
  });

  it("treats a module alias of the library as helpers", () => {
    const r = scanSources(
      "manimkc",
      py("import cslib as _cs\nx = _cs.caption('a')\ny = other.caption('b')\n"),
    );
    expect(r.calls).toEqual({ caption: 1 });
    expect(r.metrics.helperCalls).toBe(1);
  });

  it("takes a star import's helpers from libraryNames", () => {
    const src = py(
      [
        "from manimlib import *",
        "from cslib import *",
        "t = caption('x')",
        "u = Text('y')",
        "def words(s): return caption(s)",
        "v = words('z')",
      ].join("\n"),
    );
    const without = scanSources("manimkc", src);
    expect(without.metrics.helperCalls).toBe(0);
    const withNames = scanSources("manimkc", src, {
      libraryNames: ["caption", "words"],
    });
    // words is defined in the file, so it is the file's own, not the library's.
    expect(withNames.metrics.helperCalls).toBe(2);
    expect(withNames.calls).toEqual({ Text: 1, caption: 2, words: 1 });
  });

  it("does not count a library name imported from another module", () => {
    const r = scanSources(
      "manimkc",
      py("from _local import body\nbody('x')\n"),
      { libraryNames: ["body"] },
    );
    expect(r.metrics.helperCalls).toBe(0);
  });

  it("classifies engine calls apart from helpers and animations", () => {
    const r = scanSources(
      "manimkc",
      py(
        [
          "from lesson import card",
          "from pathlib import Path",
          "class Local(Mobject): pass",
          "a = Text('x'); b = Square(); c = VGroup(a, b)",
          "d = card(c); e = Local(); f = Path('p')",
          "g = FadeIn(a)",
        ].join("\n"),
      ),
    );
    expect(r.metrics.engineCalls).toBe(3);
    expect(r.metrics.distinctEngine).toBe(3);
    expect(r.metrics.helperCalls).toBe(1);
    expect(r.metrics.animationCalls).toBe(1);
  });

  it("computes fadeShare over animations", () => {
    const r = scanSources(
      "manimkc",
      py("FadeIn(a); FadeOut(a); FadeIn(b); Write(c)\n"),
    );
    expect(r.metrics.animationCalls).toBe(4);
    expect(r.metrics.fadeShare).toBe(0.75);
    expect(scanSources("manimkc", py("x = 1\n")).metrics.fadeShare).toBeNull();
  });

  it("flags 3D from a call or a base class", () => {
    expect(scanSources("manimkc", py("s = Sphere()\n")).metrics.uses3d).toBe(true);
    expect(
      scanSources("manimkc", py("class S(ThreeDScene):\n    pass\n")).metrics.uses3d,
    ).toBe(true);
    expect(scanSources("manimkc", py("s = Square()\n")).metrics.uses3d).toBe(false);
    expect(scanSources("manimkc", py("# Sphere()\n")).metrics.uses3d).toBe(false);
  });

  it("counts scenes by classes that define construct", () => {
    const src = py(
      [
        "class One(Scene):",
        "    def construct(self):",
        "        pass",
        "",
        "class Helper:",
        "    def other(self):",
        "        pass",
        "",
        "class Two(",
        "    Scene,",
        "):",
        "    def construct(self):",
        "        pass",
      ].join("\n"),
    );
    expect(scanSources("manimkc", src).sceneCount).toBe(2);
    expect(scanSources("manimkc", src, { sceneCount: 7 }).sceneCount).toBe(7);
    expect(scanSources("manimkc", src, { sceneCount: null }).sceneCount).toBeNull();
  });
});

describe("scanSources: Python, blenderkc", () => {
  const shot = [
    "from blenderkc import kit",
    "from blenderkc.kit import effects, materials as M",
    "from blenderkc.kit.geo import box",
    "",
    "def build(shot):",
    "    kit.rigs.dark_studio(shot)",
    "    a = box('a', 1)",
    "    m = M.steel()",
    "    effects.glow(shot, a)",
    "    effects.glow(shot, a)",
    "    shot.label('x')",
    "    kit.geo.box('b', 2)",
  ].join("\n");

  it("keys module calls by their path under the library", () => {
    const r = scanSources("blenderkc", py(shot));
    expect(r.calls).toEqual({
      "effects.glow": 2,
      "geo.box": 2,
      "materials.steel": 1,
      "rigs.dark_studio": 1,
    });
    expect(r.metrics.helperCalls).toBe(6);
    expect(r.metrics.uses3d).toBe(true);
    expect(r.sceneCount).toBe(1);
  });
});

describe("scanSources: TypeScript", () => {
  it("counts JSX opens, calls and namespace members by local name", () => {
    const r = scanSources(
      "remotionkc",
      ts(
        [
          'import * as THREE from "three";',
          'import { spring, useCurrentFrame, AbsoluteFill as Fill } from "remotion";',
          'import { Tex, ramp as r } from "#lib";',
          'import React from "react";',
          "export const A = () => {",
          "  const f = useCurrentFrame();",
          "  const s = spring({ frame: f });",
          "  const v = new THREE.Vector3(1, 2, 3);",
          "  return (",
          "    <Fill>",
          "      <Tex tex='x' />",
          "      <THREE.Mesh />",
          "      <THREE.Mesh />",
          "      {r(f)}{r(f + 1)}",
          "    </Fill>",
          "  );",
          "};",
        ].join("\n"),
      ),
    );
    // An alias counts under the exported name: `Fill` is AbsoluteFill, `r` is ramp.
    expect(r.calls).toEqual({
      AbsoluteFill: 1,
      Tex: 1,
      "THREE.Mesh": 2,
      "THREE.Vector3": 1,
      ramp: 2,
      spring: 1,
      useCurrentFrame: 1,
    });
    expect(r.metrics.helperCalls).toBe(3);
    expect(r.metrics.distinctHelpers).toBe(2);
    expect(r.metrics.engineCalls).toBe(6);
    expect(r.metrics.uses3d).toBe(true);
    expect(r.metrics.plays + r.metrics.voiceovers + r.metrics.rateFuncs).toBe(0);
    expect(r.sceneCount).toBeNull();
    expect(
      scanSources("remotionkc", ts("x"), { sceneCount: 4 }).sceneCount,
    ).toBe(4);
  });

  it("ignores names inside comments, strings and template text", () => {
    const r = scanSources(
      "remotionkc",
      ts(
        [
          'import { Card, spring } from "#lib";',
          "// <Card /> and spring(1)",
          "/* <Card /> */",
          "const a = '<Card />';",
          "const b = `<Card /> ${spring(2)}`;",
          "const c = (",
          "  <p>Don't</p>",
          "  <Card />",
          ");",
        ].join("\n"),
      ),
    );
    // The apostrophe ends at its line, so the next line still counts.
    expect(r.calls).toEqual({ Card: 1, spring: 1 });
  });

  it("does not read a generic argument as a JSX open", () => {
    const r = scanSources(
      "revideokc",
      ts(
        [
          "import { Layout, createRef } from '@revideo/2d';",
          "const ref = createRef<Layout>();",
          "const x = useRef<Layout>(null);",
          "const el = <Layout />;",
        ].join("\n"),
      ),
    );
    expect(r.calls).toEqual({ Layout: 1, createRef: 1 });
  });

  it("classifies a module as library, engine or other by pattern", () => {
    const r = scanSources(
      "remotionkc",
      ts(
        [
          'import { a } from "#lib";',
          'import { b } from "../../lib/index";',
          'import { c } from "../../../src/util";',
          'import { d } from "./theme";',
          'import { e } from "@remotion/transitions";',
          'import { f } from "@revideo/core";',
          'import { g } from "somewhere";',
          "a(); b(); c(); d(); e(); f(); g();",
        ].join("\n"),
      ),
    );
    expect(r.metrics.helperCalls).toBe(3);
    expect(r.metrics.engineCalls).toBe(1);
    expect(Object.keys(r.calls)).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });

  it("skips type-only imports and type specifiers", () => {
    const r = scanSources(
      "remotionkc",
      ts(
        [
          'import type { Timed } from "#lib";',
          'import { type Other, ramp } from "#lib";',
          "Timed(); Other(); ramp(1);",
        ].join("\n"),
      ),
    );
    expect(r.calls).toEqual({ ramp: 1 });
  });

  it("counts motion names as animations and fade as its share", () => {
    const r = scanSources(
      "remotionkc",
      ts(
        [
          'import { spring, interpolate, Easing } from "remotion";',
          'import { fade } from "@remotion/transitions/fade";',
          'import { easeInOutCubic } from "@revideo/core";',
          "spring(); interpolate(); fade(); fade(); easeInOutCubic(1);",
          "Easing.bezier(0, 0, 1, 1);",
        ].join("\n"),
      ),
    );
    expect(r.metrics.animationCalls).toBe(6);
    expect(r.metrics.distinctAnimations).toBe(5);
    expect(r.metrics.fadeShare).toBe(0.3333);
    expect(r.calls.Easing).toBe(1);
  });

  it("flags 3D from a three import or the library's Three", () => {
    expect(
      scanSources("remotionkc", ts('import { ThreeCanvas } from "@remotion/three";')).metrics.uses3d,
    ).toBe(true);
    expect(
      scanSources("revideokc", ts("import {Three} from '#lib';\n<Three />")).metrics.uses3d,
    ).toBe(true);
    expect(
      scanSources("revideokc", ts("import {Rect} from '@revideo/2d';")).metrics.uses3d,
    ).toBe(false);
  });

  it("keeps calls inside template expressions", () => {
    const r = scanSources(
      "remotionkc",
      ts("import { ramp } from '#lib';\nconst s = `x ${ramp(1)} ${`y ${ramp(2)}`}`;"),
    );
    expect(r.calls).toEqual({ ramp: 2 });
  });
});

describe("aliases count under the exported name", () => {
  it("makes `ramp as r` in one file and `ramp` in another one helper, so variety does not move", () => {
    const body = (importLine: string, call: string) =>
      `${importLine}\nimport { spring } from "remotion";\n${call}; spring();\n`;
    const aliased = scanSources("remotionkc", [
      { path: "a.tsx", text: body('import { ramp as r } from "#lib";', "r(1)") },
      { path: "b.tsx", text: body('import { ramp } from "#lib";', "ramp(2)") },
    ]);
    const plain = scanSources("remotionkc", [
      { path: "a.tsx", text: body('import { ramp } from "#lib";', "ramp(1)") },
      { path: "b.tsx", text: body('import { ramp } from "#lib";', "ramp(2)") },
    ]);
    expect(aliased.calls).toEqual({ ramp: 2, spring: 2 });
    expect(aliased.metrics.distinctHelpers).toBe(1);
    expect(aliased.metrics.variety).toBe(plain.metrics.variety);
    expect(aliased.calls).toEqual(plain.calls);
  });

  it("names a library namespace's member by the member, and keeps an engine namespace's qualifier", () => {
    const r = scanSources(
      "revideokc",
      ts(
        [
          "import * as lib from '#lib';",
          "import * as THREE from 'three';",
          "lib.ramp(1); lib.ramp(2); new THREE.Mesh();",
        ].join("\n"),
      ),
    );
    expect(r.calls).toEqual({ "THREE.Mesh": 1, ramp: 2 });
    expect(r.metrics.helperCalls).toBe(2);
  });

  it("uses the local name for a default import", () => {
    const r = scanSources("remotionkc", ts("import Chart from '#lib/chart';\nChart();\n"));
    expect(r.calls).toEqual({ Chart: 1 });
  });

  it("counts a Python alias of a library name or a manim name under the name it stands for", () => {
    const r = scanSources(
      "manimkc",
      py(
        [
          "from manimlib import FadeIn as F, Square as Sq",
          "from lesson import body as b",
          "from cslib import body",
          "F(a); Sq(); b('x'); body('y')",
        ].join("\n"),
      ),
    );
    expect(r.calls).toEqual({ FadeIn: 1, Square: 1, body: 2 });
    expect(r.metrics).toMatchObject({ helperCalls: 2, distinctHelpers: 1, animationCalls: 1, engineCalls: 1 });
  });

  it("is scanner version 2", () => {
    expect(INGREDIENTS_SCANNER_VERSION).toBe(2);
  });
});

describe("JSX text in the TypeScript tokenizer", () => {
  const lib = 'import { Card } from "#lib";\n';

  it("keeps a component after an apostrophe in element text", () => {
    const r = scanSources("remotionkc", ts(`${lib}const a = <p>Don't <Card /></p>;\n`));
    expect(r.calls).toEqual({ Card: 1 });
  });

  it("does not count a component named inside element text", () => {
    const r = scanSources("remotionkc", ts(`${lib}const a = <p>say <b>Card(</b> or "it's" here</p>;\n`));
    expect(r.calls).toEqual({});
  });

  it("reads a string inside an expression container among the children as a string", () => {
    const r = scanSources(
      "remotionkc",
      ts(`${lib}const a = (\n  <div>\n    it's {cond ? "it's <Card />" : 'x'} <Card />\n  </div>\n);\n`),
    );
    expect(r.calls).toEqual({ Card: 1 });
  });

  it("handles a nested element, attributes with strings and braces, and a self-closing tag", () => {
    const r = scanSources(
      "remotionkc",
      ts(
        `${lib}const a = <Card title="it's" onClick={() => go('x>y')}>\n  <Card /> don't <Card></Card>\n</Card>;\nCard();\n`,
      ),
    );
    expect(r.calls).toEqual({ Card: 4 });
  });

  it("does not read a generic call or a comparison as a tag", () => {
    const r = scanSources(
      "remotionkc",
      ts(`${lib}const x = foo<Bar>('x'); const y = a < b && c > d; Card('it');\nconst z = Array<string>(1); Card(2);\n`),
    );
    expect(r.calls).toEqual({ Card: 2 });
  });

  it("finds JSX after return, an arrow, a ternary and a call argument", () => {
    const r = scanSources(
      "remotionkc",
      ts(
        `${lib}function f() { return <p>don't <Card /></p>; }\nconst g = () => <p>it's <Card /></p>;\nconst h = ok ? <p>x's <Card /></p> : null;\nuse(1, <p>y's <Card /></p>);\n`,
      ),
    );
    expect(r.calls).toEqual({ Card: 4 });
  });
});

describe("scanSources: shared rules", () => {
  it("hashes the sources without depending on file order", () => {
    const a = { path: "a.py", text: "FadeIn(x)\n" };
    const b = { path: "b.py", text: "FadeOut(x)\n" };
    const one = scanSources("manimkc", [a, b]);
    const two = scanSources("manimkc", [b, a]);
    expect(one.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(one.sourceHash).toBe(two.sourceHash);
    const changed = scanSources("manimkc", [a, { ...b, text: "FadeOut(y)\n" }]);
    expect(changed.sourceHash).not.toBe(one.sourceHash);
    const renamed = scanSources("manimkc", [a, { ...b, path: "c.py" }]);
    expect(renamed.sourceHash).not.toBe(one.sourceHash);
  });

  it("hashes path, NUL, text, NUL in path order", async () => {
    const { createHash } = await import("node:crypto");
    const files = [
      { path: "b", text: "2" },
      { path: "a", text: "1" },
    ];
    const expected = createHash("sha256")
      .update("a\u00001\u0000b\u00002\u0000")
      .digest("hex");
    expect(scanSources("manimkc", files).sourceHash).toBe(expected);
  });

  it("returns the scanner version and the file and line counts", () => {
    const r = scanSources("manimkc", [
      { path: "a.py", text: "x = 1\ny = 2\n" },
      { path: "b.py", text: "z = 3" },
      { path: "c.py", text: "" },
    ]);
    expect(r.scannerVersion).toBe(INGREDIENTS_SCANNER_VERSION);
    expect(r.metrics.files).toBe(3);
    expect(r.metrics.lines).toBe(3);
  });

  it("gives zero counts for odd input and never throws", () => {
    for (const tool of ["manimkc", "blenderkc", "remotionkc", "revideokc"] as const) {
      for (const text of [
        "",
        "# only a comment\n",
        "// only a comment\n/* and a block",
        '"""never closed FadeIn(',
        "'unterminated FadeIn(",
        "`never closed ${ x(",
        "from import\nimport\n(((",
        "\u0000\u0001 \ud800",
      ]) {
        const r = scanSources(tool, [{ path: "x", text }]);
        expect(r.metrics.helperCalls).toBe(0);
        expect(r.metrics.animationCalls).toBe(0);
        expect(r.metrics.engineCalls).toBe(0);
        expect(r.metrics.variety).toBeNull();
        expect(r.metrics.helperTop5Share).toBeNull();
      }
    }
    expect(scanSources("manimkc", []).metrics.files).toBe(0);
  });

  it("caps calls to the 200 most called names after the metrics", () => {
    const names = Array.from({ length: 250 }, (_, i) => `h${String(i).padStart(3, "0")}`);
    // h000 to h009 are called three times, the rest once.
    const lines = names.flatMap((n, i) => (i < 10 ? [`${n}()`, `${n}()`, `${n}()`] : [`${n}()`]));
    const r = scanSources("manimkc", py(lines.join("\n")), { libraryNames: names });
    expect(r.metrics.helperCalls).toBe(30 + 240);
    expect(r.metrics.distinctHelpers).toBe(250);
    const keys = Object.keys(r.calls);
    expect(keys).toHaveLength(CALLS_CAP);
    expect(keys).toEqual([...keys].sort());
    expect(r.calls.h000).toBe(3);
    // Ties at one call are broken by name, so h010 to h199 stay.
    expect(r.calls.h199).toBe(1);
    expect(r.calls.h200).toBeUndefined();
  });

  it("measures the top five share of helper calls", () => {
    const names = ["a", "b", "c", "d", "e", "f"];
    const body = [..."aaaaaa", ..."bbbb", ..."ccc", ..."dd", ..."e", ..."f"]
      .map((n) => `${n}()`)
      .join("\n");
    const r = scanSources("manimkc", py(body), { libraryNames: names });
    expect(r.metrics.helperCalls).toBe(17);
    expect(r.metrics.helperTop5Share).toBe(0.9412);
  });

  it("measures variety as normalised entropy over helpers and animations", () => {
    const equal = scanSources(
      "manimkc",
      py("from lesson import card\ncard(); FadeIn(a)\n"),
    );
    expect(equal.metrics.variety).toBe(1);
    const one = scanSources("manimkc", py("FadeIn(a); FadeIn(b)\n"));
    expect(one.metrics.variety).toBeNull();
    const skew = scanSources(
      "manimkc",
      py("FadeIn(a); FadeIn(a); FadeIn(a); Write(b)\n"),
    );
    expect(skew.metrics.variety).toBe(0.8113);
  });
});

describe("normalisedEntropy", () => {
  it("is 1 for equal counts, null below two names, and ignores zeros", () => {
    expect(normalisedEntropy([5, 5])).toBe(1);
    expect(normalisedEntropy([2, 2, 2, 2])).toBe(1);
    expect(normalisedEntropy([7])).toBeNull();
    expect(normalisedEntropy([7, 0])).toBeNull();
    expect(normalisedEntropy([])).toBeNull();
    expect(normalisedEntropy([3, 1])).toBe(0.8113);
  });
});

describe("pythonPublicNames", () => {
  it("lists column-0 defs, classes and assignments without a leading underscore", () => {
    const names = pythonPublicNames(
      [
        '"""doc def fake():"""',
        "import os",
        "PANEL_BG = '#161616'",
        "_PRIVATE = 1",
        "SIZE: int = 3",
        "def heading(s): pass",
        "async def later(): pass",
        "class Card: pass",
        "    def method(self): pass",
        "if x == 1: pass",
      ].join("\n"),
    );
    expect(names).toEqual(["Card", "PANEL_BG", "SIZE", "heading", "later"]);
  });
});

describe("exported data", () => {
  it("lists each animation and motion name once", () => {
    expect(new Set(MANIM_ANIMATIONS).size).toBe(MANIM_ANIMATIONS.length);
    expect(new Set(TS_MOTION_NAMES).size).toBe(TS_MOTION_NAMES.length);
    expect(MANIM_ANIMATIONS).toContain("FadeIn");
    expect(TS_MOTION_NAMES).toContain("easeInOutCubic");
  });
});
