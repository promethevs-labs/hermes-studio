import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "../src/env";

/**
 * The web app's catalog code never reaches `ingredients-tools.ts`.
 *
 * That module walks a video tool's topic folders with computed paths, and
 * Turbopack reads such a path in anything a route imports as "this could open
 * any file" and traces the whole repository into the server bundle (the
 * warning `npm run build` prints). `content/videos.ts` imports
 * `ingredients-scan.ts`, the studio half, so the folder half lives apart. Only
 * the CLI (`commands/`) and `catalog import` (`index/run.ts`) may import it.
 */

const SRC = path.join(REPO_ROOT, "services/catalog/src");
const ALLOWED_IMPORTERS = new Set(["commands/ingredients.ts", "index/run.ts"]);

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

describe("ingredients-tools.ts import graph", () => {
  it("is imported by the CLI command and the import run, and nothing else", async () => {
    const importers: string[] = [];
    for (const file of await sourceFiles(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      if (rel === "index/ingredients-tools.ts") continue;
      if (/from\s+["'][^"']*ingredients-tools["']/.test(await readFile(file, "utf8"))) importers.push(rel);
    }
    expect(importers.filter((rel) => !ALLOWED_IMPORTERS.has(rel))).toEqual([]);
  });

  it("is not imported by the studio half", async () => {
    const text = await readFile(path.join(SRC, "index/ingredients-scan.ts"), "utf8");
    expect(text).not.toMatch(/ingredients-tools["']/);
  });
});
