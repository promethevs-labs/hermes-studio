/**
 * The ingredients scanner: a static read of a video's scene source that says
 * which library helpers, animations and engine calls the scenes use.
 *
 * It is pure and dependency free. It takes the source text of one video's
 * scene files and returns counts, so the same files always give the same
 * record, and the record can be stored next to the video and compared over
 * time to see how much the videos look alike.
 *
 * Two small hand-written tokenizers (Python, TypeScript) blank out comments
 * and string literals first, keeping every offset and newline in place, so a
 * name inside a docstring or a `#` inside a string never counts. Everything
 * after that is matching on the blanked text. The scanner never throws:
 * unterminated strings, empty files and files of only comments give zero
 * counts.
 */

import { createHash } from "node:crypto";

export const INGREDIENTS_SCANNER_VERSION = 1;

export type IngredientsTool =
  | "manimkc"
  | "blenderkc"
  | "remotionkc"
  | "revideokc";

export interface SourceFile {
  path: string;
  text: string;
}

export interface IngredientMetrics {
  files: number;
  lines: number;
  plays: number;
  voiceovers: number;
  rateFuncs: number;
  helperCalls: number;
  distinctHelpers: number;
  helperTop5Share: number | null;
  animationCalls: number;
  distinctAnimations: number;
  fadeShare: number | null;
  engineCalls: number;
  distinctEngine: number;
  uses3d: boolean;
  variety: number | null;
}

export interface Ingredients {
  scannerVersion: number;
  sourceHash: string;
  sceneCount: number | null;
  calls: Record<string, number>;
  metrics: IngredientMetrics;
}

export interface ScanOptions {
  /** Overrides the scene count the scanner would find in the source. */
  sceneCount?: number | null;
  /**
   * Python only. The public names the tool's library exports, for scenes that
   * star-import it (`from cslib import *`). A called name in this list is a
   * helper unless the file defines it itself. The wiring reads them from the
   * library's own source with {@link pythonPublicNames}.
   */
  libraryNames?: readonly string[];
}

/** How many names `calls` keeps, so the stored JSON stays bounded. */
export const CALLS_CAP = 200;

// ---------------------------------------------------------------------------
// Data: what counts as the library, the engine and an animation
// ---------------------------------------------------------------------------

/**
 * Modules that are each tool's own library. Python topics import them by bare
 * module name (manimkc puts its `lib/` on `sys.path`) or by package
 * (`blenderkc.kit`); the TypeScript tools use the `#lib` package alias, or a
 * relative path that climbs out of the topic into the tool's `lib/` or `src/`.
 * A relative import that stays inside the topic (`./theme`) is topic code, not
 * the library.
 */
export const LIBRARY_MODULE_PATTERNS: Record<IngredientsTool, readonly RegExp[]> =
  {
    // `_shared` is the CS3230 shim that re-exports `lesson`.
    manimkc: [
      /^lib(\..+)?$/,
      /^cslib$/,
      /^lesson$/,
      /^pipechart$/,
      /^_shared$/,
    ],
    blenderkc: [/^blenderkc(\..+)?$/],
    remotionkc: [/^#lib(\/.*)?$/, /^(?:\.\.\/)+(?:lib|src)(?:\/.*)?$/],
    revideokc: [/^#lib(\/.*)?$/, /^(?:\.\.\/)+(?:lib|src)(?:\/.*)?$/],
  };

/** Modules that are the rendering engine rather than the tool's library. */
export const ENGINE_MODULE_PATTERNS: Record<
  "remotionkc" | "revideokc",
  readonly RegExp[]
> = {
  remotionkc: [
    /^remotion(\/.*)?$/,
    /^@remotion\/.+$/,
    /^three(\/.*)?$/,
    /^@react-three\/.+$/,
  ],
  revideokc: [
    /^@revideo\/.+$/,
    /^@motion-canvas\/.+$/,
    /^three(\/.*)?$/,
    /^@react-three\/.+$/,
  ],
};

/**
 * Leading dotted segments dropped from a library path to make a helper's key,
 * so `from lesson import body` is `body`, and
 * `from blenderkc.kit.geo import box` is `geo.box`.
 */
export const LIBRARY_ROOT_SEGMENTS: Record<
  "manimkc" | "blenderkc",
  readonly string[]
> = {
  manimkc: ["lib", "cslib", "lesson", "pipechart", "_shared"],
  blenderkc: ["blenderkc", "kit"],
};

export const MANIM_ANIMATIONS: readonly string[] = [
  "FadeIn",
  "FadeOut",
  "Write",
  "ShowCreation",
  "Create",
  "Uncreate",
  "DrawBorderThenFill",
  "Transform",
  "ReplacementTransform",
  "TransformMatchingTex",
  "TransformMatchingShapes",
  "TransformMatchingStrings",
  "FadeTransform",
  "FadeTransformPieces",
  "MoveToTarget",
  "ApplyMethod",
  "Rotate",
  "Restore",
  "GrowFromCenter",
  "GrowFromPoint",
  "GrowFromEdge",
  "GrowArrow",
  "ShrinkToCenter",
  "Indicate",
  "Flash",
  "FlashAround",
  "FlashUnder",
  "CircleIndicate",
  "FocusOn",
  "ShowPassingFlash",
  "ShowCreationThenDestruction",
  "ShowCreationThenFadeOut",
  "WiggleOutThenIn",
  "Wiggle",
  "ApplyWave",
  "TurnInsideOut",
  "MoveAlongPath",
  "LaggedStart",
  "LaggedStartMap",
  "AnimationGroup",
  "Succession",
  "CountInFrom",
  "ChangeDecimalToValue",
  "UpdateFromFunc",
  "UpdateFromAlphaFunc",
  "MaintainPositionRelativeTo",
  "Homotopy",
  "ApplyPointwiseFunction",
  "ApplyMatrix",
  "ApplyComplexFunction",
  "CyclicReplace",
  "Swap",
  "VFadeIn",
  "VFadeOut",
  "VFadeInThenOut",
  "AddTextWordByWord",
  "ShowIncreasingSubsets",
  "ShowSubmobjectsOneByOne",
  "Broadcast",
];

const EASE_FAMILIES = [
  "Sine",
  "Quad",
  "Cubic",
  "Quart",
  "Quint",
  "Expo",
  "Circ",
  "Back",
  "Elastic",
  "Bounce",
];

/** Motion helpers of the two TypeScript engines, counted as animations. */
export const TS_MOTION_NAMES: readonly string[] = [
  "spring",
  "interpolate",
  "interpolateColors",
  "Easing",
  "TransitionSeries",
  "linearTiming",
  "springTiming",
  "fade",
  "slide",
  "wipe",
  "flip",
  "clockWipe",
  "tween",
  "all",
  "sequence",
  "chain",
  "loop",
  "delay",
  "waitFor",
  "createRef",
  "makeRef",
  ...EASE_FAMILIES.flatMap((f) => [`easeIn${f}`, `easeOut${f}`, `easeInOut${f}`]),
];

const THREE_D_PYTHON = [
  "ThreeDScene",
  "ThreeDAxes",
  "Sphere",
  "Torus",
  "Cube",
  "Prism",
  "Prismify",
  "Surface",
  "ParametricSurface",
  "SurfaceMesh",
  "Cylinder",
  "Cone",
];

const PYTHON_KEYWORDS = [
  "False", "None", "True", "and", "as", "assert", "async", "await", "break",
  "class", "continue", "def", "del", "elif", "else", "except", "finally",
  "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
  "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
  "match", "case",
];

const PYTHON_BUILTINS = [
  "print", "len", "range", "int", "str", "float", "bool", "list", "dict",
  "set", "tuple", "min", "max", "sum", "abs", "round", "enumerate", "zip",
  "sorted", "reversed", "isinstance", "issubclass", "super", "getattr",
  "setattr", "hasattr", "delattr", "type", "iter", "next", "any", "all",
  "map", "filter", "open", "repr", "format", "divmod", "pow", "id", "hash",
  "callable", "vars", "dir", "frozenset", "bytes", "bytearray", "object",
  "property", "staticmethod", "classmethod", "input", "chr", "ord", "hex",
  "oct", "bin", "slice", "complex", "ascii", "compile", "eval", "exec",
  "globals", "locals", "memoryview", "breakpoint",
];

const PYTHON_EXCEPTIONS = [
  "BaseException", "Exception", "ArithmeticError", "AssertionError",
  "AttributeError", "BufferError", "EOFError", "FloatingPointError",
  "GeneratorExit", "ImportError", "ModuleNotFoundError", "IndexError",
  "KeyError", "KeyboardInterrupt", "LookupError", "MemoryError", "NameError",
  "NotImplementedError", "OSError", "IOError", "FileNotFoundError",
  "PermissionError", "TimeoutError", "OverflowError", "RecursionError",
  "RuntimeError", "StopIteration", "StopAsyncIteration", "SyntaxError",
  "IndentationError", "SystemExit", "TypeError", "UnboundLocalError",
  "UnicodeError", "UnicodeDecodeError", "UnicodeEncodeError", "ValueError",
  "ZeroDivisionError", "Warning", "UserWarning", "DeprecationWarning",
  "RuntimeWarning", "NotImplemented",
];

const PYTHON_IGNORED = new Set([
  ...PYTHON_KEYWORDS,
  ...PYTHON_BUILTINS,
  ...PYTHON_EXCEPTIONS,
]);

const ANIMATION_SET: ReadonlySet<string> = new Set(MANIM_ANIMATIONS);
const TS_MOTION_SET: ReadonlySet<string> = new Set(TS_MOTION_NAMES);
const THREE_D_SET: ReadonlySet<string> = new Set(THREE_D_PYTHON);

// ---------------------------------------------------------------------------
// Tokenizers: blank comments and string literals, keep offsets
// ---------------------------------------------------------------------------

interface Stripped {
  /** The text with comments and string contents replaced by spaces. */
  code: string;
  /**
   * Single and double quoted string contents, keyed by the offset of the
   * opening quote. The import parsers read module specifiers from here.
   */
  strings: Map<number, string>;
}

function blank(c: string): string {
  return c === "\n" || c === "\r" ? c : " ";
}

function isIdentChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_$]/.test(c);
}

const PY_STRING_PREFIXES = new Set([
  "r", "b", "f", "u", "rb", "br", "fr", "rf",
]);

/**
 * Blanks Python comments and string literals: `#` comments, single, double
 * and triple quoted strings, with the r, b, f and u prefixes. An f-string is
 * dropped whole. A single-line string ends at its newline when unterminated.
 */
export function stripPython(text: string): Stripped {
  const out: string[] = [];
  const strings = new Map<number, string>();
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charAt(i);
    if (c === "#") {
      while (i < n && text.charAt(i) !== "\n") {
        out.push(blank(text.charAt(i)));
        i++;
      }
      continue;
    }
    if (isIdentChar(c) && !/[0-9]/.test(c)) {
      let j = i;
      while (j < n && isIdentChar(text.charAt(j))) j++;
      const word = text.slice(i, j);
      const q = text.charAt(j);
      if (
        (q === '"' || q === "'") &&
        PY_STRING_PREFIXES.has(word.toLowerCase())
      ) {
        for (let k = i; k < j; k++) out.push(" ");
        i = j;
        i = blankPyString(text, i, out, strings);
        continue;
      }
      out.push(word);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      i = blankPyString(text, i, out, strings);
      continue;
    }
    out.push(c);
    i++;
  }
  return { code: out.join(""), strings };
}

function blankPyString(
  text: string,
  start: number,
  out: string[],
  strings: Map<number, string>,
): number {
  const n = text.length;
  const q = text.charAt(start);
  const triple = text.charAt(start + 1) === q && text.charAt(start + 2) === q;
  const open = triple ? 3 : 1;
  out.push(q.repeat(open));
  let i = start + open;
  const bodyStart = i;
  while (i < n) {
    const c = text.charAt(i);
    if (c === "\\") {
      out.push(" ");
      i++;
      if (i < n) {
        out.push(blank(text.charAt(i)));
        i++;
      }
      continue;
    }
    if (triple) {
      if (c === q && text.charAt(i + 1) === q && text.charAt(i + 2) === q) {
        strings.set(start, text.slice(bodyStart, i));
        out.push(q.repeat(3));
        return i + 3;
      }
    } else {
      if (c === q) {
        strings.set(start, text.slice(bodyStart, i));
        out.push(q);
        return i + 1;
      }
      if (c === "\n") return i; // unterminated: stop at the line end
    }
    out.push(blank(c));
    i++;
  }
  return i;
}

/**
 * Blanks TypeScript comments and string literals: `//` and block comments,
 * single and double quoted strings (which end at a newline when
 * unterminated, so a JSX apostrophe cannot swallow the file), and template
 * literals. The text of a template is blanked but the code inside its `${}`
 * stays, nested to any depth.
 */
export function stripTypeScript(text: string): Stripped {
  const out: string[] = [];
  const strings = new Map<number, string>();
  const n = text.length;
  const exprDepth: number[] = [];
  let inTemplate = false;
  let i = 0;
  while (i < n) {
    const c = text.charAt(i);
    if (inTemplate) {
      if (c === "\\") {
        out.push(" ");
        i++;
        if (i < n) {
          out.push(blank(text.charAt(i)));
          i++;
        }
      } else if (c === "`") {
        out.push("`");
        inTemplate = false;
        i++;
      } else if (c === "$" && text.charAt(i + 1) === "{") {
        out.push("  ");
        exprDepth.push(0);
        inTemplate = false;
        i += 2;
      } else {
        out.push(blank(c));
        i++;
      }
      continue;
    }
    if (c === "/" && text.charAt(i + 1) === "/") {
      while (i < n && text.charAt(i) !== "\n") {
        out.push(blank(text.charAt(i)));
        i++;
      }
      continue;
    }
    if (c === "/" && text.charAt(i + 1) === "*") {
      out.push("  ");
      i += 2;
      while (i < n && !(text.charAt(i) === "*" && text.charAt(i + 1) === "/")) {
        out.push(blank(text.charAt(i)));
        i++;
      }
      if (i < n) {
        out.push("  ");
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      out.push(c);
      i++;
      const bodyStart = i;
      while (i < n) {
        const d = text.charAt(i);
        if (d === "\\") {
          out.push(" ");
          i++;
          if (i < n) {
            out.push(blank(text.charAt(i)));
            i++;
          }
          continue;
        }
        if (d === c) {
          strings.set(start, text.slice(bodyStart, i));
          out.push(c);
          i++;
          break;
        }
        if (d === "\n") break;
        out.push(blank(d));
        i++;
      }
      continue;
    }
    if (c === "`") {
      out.push("`");
      inTemplate = true;
      i++;
      continue;
    }
    if (c === "{" && exprDepth.length > 0) bumpTop(exprDepth, 1);
    if (c === "}" && exprDepth.length > 0) {
      if (exprDepth[exprDepth.length - 1] === 0) {
        exprDepth.pop();
        inTemplate = true;
        out.push(" ");
        i++;
        continue;
      }
      bumpTop(exprDepth, -1);
    }
    out.push(c);
    i++;
  }
  return { code: out.join(""), strings };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function bumpTop(stack: number[], by: number): void {
  const top = stack.length - 1;
  stack[top] = (stack[top] ?? 0) + by;
}

function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function sumOf(map: Map<string, number>): number {
  let s = 0;
  for (const v of map.values()) s += v;
  return s;
}

function countLines(text: string): number {
  if (text === "") return 0;
  const parts = text.split("\n");
  return text.endsWith("\n") ? parts.length - 1 : parts.length;
}

function byCountThenName(a: [string, number], b: [string, number]): number {
  if (b[1] !== a[1]) return b[1] - a[1];
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function top5Share(helpers: Map<string, number>): number | null {
  const total = sumOf(helpers);
  if (total === 0) return null;
  const top = [...helpers.entries()]
    .sort(byCountThenName)
    .slice(0, 5)
    .reduce((s, [, v]) => s + v, 0);
  return round4(top / total);
}

/** Normalised Shannon entropy of the counts, or null for fewer than 2 names. */
export function normalisedEntropy(counts: Iterable<number>): number | null {
  const xs = [...counts].filter((v) => v > 0);
  if (xs.length < 2) return null;
  const total = xs.reduce((s, v) => s + v, 0);
  let h = 0;
  for (const v of xs) {
    const p = v / total;
    h -= p * Math.log(p);
  }
  return round4(h / Math.log(xs.length));
}

function hashSources(files: readonly SourceFile[]): string {
  const sorted = [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const h = createHash("sha256");
  for (const f of sorted) {
    h.update(f.path, "utf8");
    h.update("\0");
    h.update(f.text, "utf8");
    h.update("\0");
  }
  return h.digest("hex");
}

function capCalls(all: Map<string, number>): Record<string, number> {
  const kept = [...all.entries()]
    .filter(([, v]) => v > 0)
    .sort(byCountThenName)
    .slice(0, CALLS_CAP)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out: Record<string, number> = {};
  for (const [k, v] of kept) out[k] = v;
  return out;
}

/** What a scan of one file adds up to, before the metrics are derived. */
interface Tally {
  all: Map<string, number>;
  helpers: Map<string, number>;
  animations: Map<string, number>;
  /** Animation names that are the fade transition (fadeShare's numerator). */
  fades: number;
  engine: Map<string, number>;
  plays: number;
  voiceovers: number;
  rateFuncs: number;
  scenes: number;
  uses3d: boolean;
}

function newTally(): Tally {
  return {
    all: new Map(),
    helpers: new Map(),
    animations: new Map(),
    fades: 0,
    engine: new Map(),
    plays: 0,
    voiceovers: 0,
    rateFuncs: 0,
    scenes: 0,
    uses3d: false,
  };
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

/**
 * The public top-level names of a Python module: its `def`, `class` and plain
 * assignments at column 0 whose name does not start with an underscore. For a
 * library that scenes star-import, this is the list to pass as
 * `libraryNames`.
 */
export function pythonPublicNames(source: string): string[] {
  const { code } = stripPython(source);
  const names = new Set<string>();
  const re =
    /^(?:(?:async[ \t]+)?def|class)[ \t]+([A-Za-z]\w*)|^([A-Za-z]\w*)[ \t]*(?::[^=\n]*)?=(?!=)/gm;
  for (const m of code.matchAll(re)) names.add((m[1] ?? m[2])!);
  return [...names].sort();
}

function stripRoot(full: string, roots: readonly string[]): string {
  const parts = full.split(".");
  let k = 0;
  while (k < parts.length - 1 && roots.includes(parts[k]!)) k++;
  return parts.slice(k).join(".");
}

interface PyImports {
  /** Local name to full dotted target, for names taken from the library. */
  libTargets: Map<string, string>;
  /** Local names imported from anywhere that is not the library or manim. */
  otherImported: Set<string>;
}

function parsePyImports(
  code: string,
  isLibrary: (module: string) => boolean,
): PyImports {
  const libTargets = new Map<string, string>();
  const otherImported = new Set<string>();

  const fromRe =
    /^[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]*(\*|\(([^)]*)\)|((?:[^\n\\]|\\\r?\n)*))/gm;
  for (const m of code.matchAll(fromRe)) {
    const mod = m[1]!;
    if (m[2] === "*") continue;
    const list = (m[3] ?? m[4] ?? "").replace(/\\\r?\n/g, " ");
    const isManim = mod === "manimlib" || mod.startsWith("manimlib.") ||
      mod === "manim" || mod.startsWith("manim.");
    for (const part of list.split(",")) {
      const spec = part.trim();
      if (spec === "") continue;
      const sm = /^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(spec);
      if (!sm) continue;
      const imported = sm[1]!;
      const local = sm[2] ?? imported;
      if (isLibrary(mod)) libTargets.set(local, `${mod}.${imported}`);
      else if (!isManim) otherImported.add(local);
    }
  }

  const importRe = /^[ \t]*import[ \t]+([^\n;]+)/gm;
  for (const m of code.matchAll(importRe)) {
    for (const part of m[1]!.split(",")) {
      const spec = part.trim();
      const sm =
        /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(
          spec,
        );
      if (!sm) continue;
      const mod = sm[1]!;
      const root = mod.split(".")[0]!;
      const local = sm[2] ?? root;
      const target = sm[2] ? mod : root;
      if (isLibrary(mod)) libTargets.set(local, target);
      else otherImported.add(local);
    }
  }
  return { libTargets, otherImported };
}

/** Counts the `class` declarations whose body defines `construct`. */
function countConstructScenes(code: string): number {
  const lines = code.split("\n");
  const indentOf = (s: string) => /^[ \t]*/.exec(s)![0]!.length;
  let scenes = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^([ \t]*)class[ \t]+\w+/.exec(lines[i]!);
    if (!m) continue;
    const base = m[1]!.length;
    // The header may span lines: read on until its parentheses close.
    let depth = 0;
    let j = i;
    for (; j < lines.length; j++) {
      for (const ch of lines[j]!) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
      }
      if (depth <= 0) break;
    }
    for (let k = j + 1; k < lines.length; k++) {
      if (lines[k]!.trim() === "") continue;
      if (indentOf(lines[k]!) <= base) break;
      if (/\bdef[ \t]+construct[ \t]*\(/.test(lines[k]!)) {
        scenes++;
        break;
      }
    }
  }
  return scenes;
}

function scanPythonFile(
  tool: "manimkc" | "blenderkc",
  text: string,
  libraryNames: ReadonlySet<string>,
  into: Tally,
): void {
  const { code } = stripPython(text);
  const patterns = LIBRARY_MODULE_PATTERNS[tool];
  const roots = LIBRARY_ROOT_SEGMENTS[tool];
  const { libTargets, otherImported } = parsePyImports(code, (m) =>
    patterns.some((p) => p.test(m)),
  );

  // Names the file defines itself at column 0 are not the library's.
  const localDefs = new Set<string>();
  for (const m of code.matchAll(/^(?:async[ \t]+)?(?:def|class)[ \t]+(\w+)/gm))
    localDefs.add(m[1]!);
  const classDefs = new Set<string>();
  for (const m of code.matchAll(/^[ \t]*class[ \t]+(\w+)/gm)) classDefs.add(m[1]!);

  const callRe = /(?<![\w.$])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)[ \t]*\(/g;
  const animationsHere = new Map<string, number>();
  const sawNames = new Set<string>();
  for (const m of code.matchAll(callRe)) {
    const path = m[1]!;
    const at = m.index!;
    // A call that starts a line after a dot is part of a method chain.
    let p = at - 1;
    while (p >= 0 && /\s/.test(code.charAt(p))) p--;
    if (p >= 0 && (code.charAt(p) === "." || code.charAt(p) === "@")) continue;
    if (/\b(?:def|class)[ \t]+$/.test(code.slice(Math.max(0, at - 12), at)))
      continue;

    if (path === "self.play") {
      into.plays++;
      continue;
    }
    if (path === "self.voiceover") {
      into.voiceovers++;
      continue;
    }
    const dot = path.indexOf(".");
    if (dot >= 0) {
      const root = path.slice(0, dot);
      const target = libTargets.get(root);
      if (target === undefined) continue; // a method call, not counted
      const key = stripRoot(`${target}${path.slice(dot)}`, roots);
      bump(into.all, key);
      bump(into.helpers, key);
      sawNames.add(key);
      continue;
    }

    const name = path;
    if (PYTHON_IGNORED.has(name)) continue;
    sawNames.add(name);
    const target = libTargets.get(name);
    if (target !== undefined) {
      const key = stripRoot(target, roots);
      bump(into.all, key);
      bump(into.helpers, key);
    } else if (
      libraryNames.has(name) &&
      !localDefs.has(name) &&
      !otherImported.has(name)
    ) {
      bump(into.all, name);
      bump(into.helpers, name);
    } else if (ANIMATION_SET.has(name)) {
      bump(into.all, name);
      bump(animationsHere, name);
    } else if (
      /^[A-Z]/.test(name) &&
      !classDefs.has(name) &&
      !otherImported.has(name)
    ) {
      bump(into.all, name);
      bump(into.engine, name);
    } else {
      bump(into.all, name);
    }
  }
  for (const [k, v] of animationsHere) bump(into.animations, k, v);

  into.rateFuncs += (code.match(/\brate_func[ \t]*=(?!=)/g) ?? []).length;

  if (tool === "blenderkc") {
    into.uses3d = true;
    into.scenes += (code.match(/^def[ \t]+build[ \t]*\(/gm) ?? []).length;
  } else {
    into.scenes += countConstructScenes(code);
    if ([...sawNames].some((n) => THREE_D_SET.has(n))) into.uses3d = true;
    for (const m of code.matchAll(/^[ \t]*class[ \t]+\w+[ \t]*\(([^)]*)\)/gm)) {
      for (const base of m[1]!.split(",")) {
        const b = base.trim().split(".").pop() ?? "";
        if (THREE_D_SET.has(b)) into.uses3d = true;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// TypeScript
// ---------------------------------------------------------------------------

type ModuleKind = "library" | "engine" | "other";

interface TsImport {
  local: string;
  /** The exported name, "default" or "*" for a namespace. */
  imported: string;
  module: string;
  kind: ModuleKind;
  namespace: boolean;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function classifyTsModule(
  tool: "remotionkc" | "revideokc",
  mod: string,
): ModuleKind {
  if (LIBRARY_MODULE_PATTERNS[tool].some((p) => p.test(mod))) return "library";
  if (ENGINE_MODULE_PATTERNS[tool].some((p) => p.test(mod))) return "engine";
  return "other";
}

function parseTsImports(
  tool: "remotionkc" | "revideokc",
  stripped: Stripped,
): TsImport[] {
  const out: TsImport[] = [];
  const re = /\bimport\s+([^;'"`]*?)\s*from\s*(["'])/g;
  for (const m of stripped.code.matchAll(re)) {
    let clause = m[1]!.trim();
    if (clause === "") continue;
    if (/^type\s+[\w${*]/.test(clause)) continue; // import type {...}
    const quoteAt = m.index! + m[0].length - 1;
    const specifier = stripped.strings.get(quoteAt);
    if (specifier === undefined) continue;
    const kind = classifyTsModule(tool, specifier);

    const ns = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (ns) {
      out.push({ local: ns[1]!, imported: "*", module: specifier, kind, namespace: true });
      clause = clause.replace(ns[0], "");
    }
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) {
      for (const part of braces[1]!.split(",")) {
        const spec = part.trim();
        if (spec === "" || /^type\s/.test(spec)) continue;
        const sm = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(
          spec,
        );
        if (!sm) continue;
        out.push({
          local: sm[2] ?? sm[1]!,
          imported: sm[1]!,
          module: specifier,
          kind,
          namespace: false,
        });
      }
      clause = clause.replace(braces[0], "");
    }
    const def = /^\s*([A-Za-z_$][\w$]*)\s*,?\s*$/.exec(clause);
    if (def) {
      out.push({
        local: def[1]!,
        imported: "default",
        module: specifier,
        kind,
        namespace: false,
      });
    }
  }
  return out;
}

function scanTypeScriptFile(
  tool: "remotionkc" | "revideokc",
  text: string,
  into: Tally,
): void {
  const stripped = stripTypeScript(text);
  const code = stripped.code;
  const imports = parseTsImports(tool, stripped);

  for (const imp of imports) {
    if (
      imp.module === "three" || imp.module.startsWith("three/") ||
      imp.module === "@remotion/three" ||
      imp.module.startsWith("@react-three/") ||
      (imp.kind === "library" && /^three$/i.test(imp.imported))
    ) {
      into.uses3d = true;
    }
    const L = escapeRe(imp.local);
    const counts = new Map<string, number>();
    if (imp.namespace) {
      for (const m of code.matchAll(
        new RegExp(`(?<![\\w$.])${L}\\.([\\w$]+)[ \\t]*\\(`, "g"),
      ))
        bump(counts, `${imp.local}.${m[1]}`);
      for (const m of code.matchAll(
        new RegExp(`(?<![\\w$)\\]])<${L}\\.([\\w$]+)(?![\\w$])`, "g"),
      ))
        bump(counts, `${imp.local}.${m[1]}`);
    } else {
      const own =
        new RegExp(`(?<![\\w$.])${L}(?:<[^<>()]*>)?[ \\t]*\\(`, "g");
      const member =
        new RegExp(`(?<![\\w$.])${L}(?:\\.[\\w$]+)+[ \\t]*\\(`, "g");
      const jsx = new RegExp(`(?<![\\w$)\\]])<${L}(?![\\w$])`, "g");
      let n = 0;
      n += (code.match(own) ?? []).length;
      n += (code.match(member) ?? []).length;
      n += (code.match(jsx) ?? []).length;
      if (n > 0) counts.set(imp.local, n);
    }
    for (const [key, n] of counts) {
      bump(into.all, key, n);
      const name = imp.namespace
        ? key.slice(imp.local.length + 1)
        : imp.imported === "default"
          ? imp.local
          : imp.imported;
      if (imp.kind === "library") bump(into.helpers, key, n);
      if (imp.kind === "engine") bump(into.engine, key, n);
      if (TS_MOTION_SET.has(name)) {
        bump(into.animations, key, n);
        if (name === "fade") into.fades += n;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Scans one video's scene files. `files` is every source file of the video;
 * the order does not matter. Never throws.
 */
export function scanSources(
  tool: IngredientsTool,
  files: SourceFile[],
  options: ScanOptions = {},
): Ingredients {
  const tally = newTally();
  const libraryNames = new Set(options.libraryNames ?? []);
  let lines = 0;
  for (const f of files) {
    const text = typeof f.text === "string" ? f.text : "";
    lines += countLines(text);
    try {
      if (tool === "manimkc" || tool === "blenderkc")
        scanPythonFile(tool, text, libraryNames, tally);
      else scanTypeScriptFile(tool, text, tally);
    } catch {
      // A file the scanner cannot read adds nothing.
    }
  }

  const helperCalls = sumOf(tally.helpers);
  const animationCalls = sumOf(tally.animations);
  const isTs = tool === "remotionkc" || tool === "revideokc";
  const fades = isTs
    ? tally.fades
    : (tally.animations.get("FadeIn") ?? 0) + (tally.animations.get("FadeOut") ?? 0);

  // Variety is over helper and animation names together, each name once.
  const dist = new Map<string, number>();
  for (const [k, v] of tally.helpers) dist.set(k, v);
  for (const [k, v] of tally.animations) if (!dist.has(k)) dist.set(k, v);

  const sceneCount =
    options.sceneCount !== undefined
      ? options.sceneCount
      : isTs
        ? null
        : tally.scenes;

  return {
    scannerVersion: INGREDIENTS_SCANNER_VERSION,
    sourceHash: hashSources(files),
    sceneCount,
    calls: capCalls(tally.all),
    metrics: {
      files: files.length,
      lines,
      plays: isTs ? 0 : tally.plays,
      voiceovers: isTs ? 0 : tally.voiceovers,
      rateFuncs: isTs ? 0 : tally.rateFuncs,
      helperCalls,
      distinctHelpers: tally.helpers.size,
      helperTop5Share: top5Share(tally.helpers),
      animationCalls,
      distinctAnimations: tally.animations.size,
      fadeShare: animationCalls === 0 ? null : round4(fades / animationCalls),
      engineCalls: sumOf(tally.engine),
      distinctEngine: tally.engine.size,
      uses3d: tally.uses3d,
      variety: normalisedEntropy(dist.values()),
    },
  };
}
