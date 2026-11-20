import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { backendFor } from "../src/video/backend";
import { videoPaths, type VideoPaths } from "../src/video/paths";
import { remotionkcPaths } from "../src/video/remotionkc/paths";

/**
 * The version of a video manual (`manualVersionOf`): the hash of its text
 * with the job's own paths normalised out, so videos made under one manual
 * share a value that `manualHash` (a hash of text holding the job's wrapper
 * path, and the name of its file) cannot give. Checked on all three backends,
 * with two jobs that have different ids and slugs.
 */

const TOOLS = ["manimkc", "remotionkc", "revideokc"] as const;
const LISTING = "palette\n  ACCENT  the one accent colour\n\nhelpers\n  labeled_box(text)  a box with a label\n";

let home: string;
const savedHome = process.env.STUDIO_HOME;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "studio-manual-version-"));
  process.env.STUDIO_HOME = home;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.STUDIO_HOME;
  else process.env.STUDIO_HOME = savedHome;
  await rm(home, { recursive: true, force: true });
});

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A job's paths as its backend builds them, without creating anything on disk. */
function pathsFor(tool: (typeof TOOLS)[number], jobId: string, slug: string): VideoPaths {
  const raw = videoPaths(jobId, slug);
  if (tool === "remotionkc") return { ...raw, sceneFile: path.join(raw.topicDir, "composition.tsx") };
  if (tool === "revideokc") return { ...raw, sceneFile: path.join(raw.topicDir, "scene.tsx") };
  return raw;
}

describe.each(TOOLS)("the %s manual's version", (tool) => {
  const backend = backendFor(tool);

  it("is the same for two jobs whose manuals have different hashes", () => {
    const a = pathsFor(tool, "job-aaaaaaaa", "attention-weights");
    const b = pathsFor(tool, "job-bbbbbbbb", "cache-lines");
    const textA = backend.manual(a.wrapper, LISTING, a);
    const textB = backend.manual(b.wrapper, LISTING, b);

    // The text holds the job's own paths, so the file's name is different for every job.
    expect(textA).toContain(a.wrapper);
    expect(textA).not.toContain(b.wrapper);
    expect(sha(textA)).not.toBe(sha(textB));
    // And the version, which rests on the same inputs with those paths set aside, is not.
    expect(backend.manualVersion(LISTING, a)).toBe(backend.manualVersion(LISTING, b));
    expect(backend.manualVersion(LISTING, a)).toMatch(/^[0-9a-f]{64}$/);
    expect(backend.manualVersion(LISTING, a)).not.toBe(sha(textA));
  });

  it("changes when the manual's real content does", () => {
    const a = pathsFor(tool, "job-aaaaaaaa", "attention-weights");
    expect(backend.manualVersion(`${LISTING}  fade_in(x)  a new helper\n`, a)).not.toBe(backend.manualVersion(LISTING, a));
  });

  it("does not depend on where the studio keeps its jobs", async () => {
    const a = pathsFor(tool, "job-aaaaaaaa", "attention-weights");
    const here = backend.manualVersion(LISTING, a);
    const elsewhere = await mkdtemp(path.join(tmpdir(), "studio-manual-version-other-"));
    process.env.STUDIO_HOME = elsewhere;
    try {
      expect(backend.manualVersion(LISTING, pathsFor(tool, "job-cccccccc", "other"))).toBe(here);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("the remotionkc manual's version and Remotion's guides", () => {
  it("still tells a checkout that has the guides from one that has none, which is real content", async () => {
    const backend = backendFor("remotionkc");
    const a = pathsFor("remotionkc", "job-aaaaaaaa", "attention-weights");
    const b = pathsFor("remotionkc", "job-bbbbbbbb", "cache-lines");
    const without = backend.manualVersion(LISTING, a);
    const guides = remotionkcPaths(b).remotionGuides;
    await mkdir(guides, { recursive: true });
    await writeFile(path.join(guides, "REFERENCE.md"), "# guides\n", "utf8");
    const withGuides = backend.manualVersion(LISTING, b);

    expect(withGuides).not.toBe(without);
    // Two jobs whose checkouts both have them agree.
    const c = pathsFor("remotionkc", "job-cccccccc", "third");
    await mkdir(remotionkcPaths(c).remotionGuides, { recursive: true });
    await writeFile(path.join(remotionkcPaths(c).remotionGuides, "REFERENCE.md"), "# guides\n", "utf8");
    expect(backend.manualVersion(LISTING, c)).toBe(withGuides);
  });
});
