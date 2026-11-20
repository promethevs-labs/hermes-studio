import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { scanSources, type SourceFile } from "../ingredients/scan";
import { TS_SOURCE, manimkcLibraryNames, type ToolComputation } from "./ingredients-scan";
import { type TopicsReport, type VideoTool, videoToolAssetId } from "./video-tool";

/**
 * The compute half of the ingredients scan for a tool's topic folders: where
 * the folders are, the walk of a TypeScript tool's sources, and each rendered
 * video's scan. Only the CLI and `catalog import` reach it. It is a module of
 * its own because the web app imports `ingredients-scan.ts`, and this half's
 * computed paths (`path.join(topicDir, name)`) make Turbopack trace the whole
 * repository into the server bundle: keep it out of the web app's import graph.
 */

/** The folders a topic folder's walk never enters. */
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist"]);
/** A topic folder with more source than this is cut off, and says so. */
const MAX_SOURCE_FILES = 500;

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

/** One `KEY=value` line of a dotenv file, as the tools' own CLIs read it. */
async function dotenvValue(file: string, key: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return "";
  }
  for (const line of text.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match === null || match[1] !== key) continue;
    return (match[2] ?? "").replace(/^(["'])(.*)\1$/, "$2").trim();
  }
  return "";
}

/**
 * Where a tool's topic folders are. The report names it when it can
 * (`topicsRoot`, manimkc). The other tools' CLIs resolve it the same way
 * among themselves: `$<TOOL>_TOPICS` from the environment, else the same
 * line in the checkout's `.env`, else `<checkout>/topics`; a value must be
 * absolute after `~/` is expanded.
 */
export async function resolveTopicsRoot(
  tool: VideoTool,
  report: TopicsReport & { topicsRoot?: unknown },
  checkout: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ dir: string } | { problem: string }> {
  if (typeof report.topicsRoot === "string" && report.topicsRoot.trim() !== "") {
    return { dir: path.resolve(report.topicsRoot) };
  }
  const variable = `${tool.name.toUpperCase()}_TOPICS`;
  let value = (env[variable] ?? "").trim();
  let from = "the environment";
  if (value === "") {
    value = await dotenvValue(path.join(checkout, ".env"), variable);
    from = path.join(checkout, ".env");
  }
  if (value === "") return { dir: path.join(checkout, "topics") };
  const expanded = expandHome(value);
  if (!path.isAbsolute(expanded)) {
    return { problem: `${variable} must be an absolute path, got ${JSON.stringify(value)} (from ${from})` };
  }
  return { dir: path.resolve(expanded) };
}

/** Every `.ts` and `.tsx` under `dir`, skipping node_modules, dist and dot folders; sorted, relative, `/`-separated. */
async function walkTypeScript(dir: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (current: string, prefix: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (found.length >= MAX_SOURCE_FILES) return;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) continue;
        await visit(path.join(current, entry.name), rel);
      } else if (entry.isFile() && TS_SOURCE.test(entry.name)) {
        found.push(rel);
      }
    }
  };
  await visit(dir, "");
  return found;
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/** True when `child` is inside `parent`, so a report cannot point the scan at a file elsewhere. */
function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

interface SectionLike {
  deliverable?: { path?: unknown; exists?: unknown; duration?: unknown } | null;
  files?: unknown;
}

/** The scenes a section's files name, summed, or undefined when none do. */
function reportedSceneCount(files: unknown): number | undefined {
  if (!Array.isArray(files)) return undefined;
  let total = 0;
  for (const file of files as Array<{ scenes?: unknown }>) {
    if (Array.isArray(file?.scenes)) total += file.scenes.length;
  }
  return total > 0 ? total : undefined;
}

/**
 * The ingredients of every rendered video in a tool's report. Source files
 * per video: manimkc and blenderkc, the section's own files under the topic
 * folder; remotionkc and revideokc, every `.ts` and `.tsx` in the topic
 * folder. A video whose source cannot be read is skipped with the reason,
 * and nothing here throws for one topic.
 */
export async function computeIngredientsForTool(
  tool: VideoTool,
  report: TopicsReport & { topicsRoot?: unknown },
  checkout: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<ToolComputation> {
  const result: ToolComputation = { tool: tool.name, videos: [], skipped: [], notes: [] };
  const topics = await resolveTopicsRoot(tool, report, checkout, options.env);
  if ("problem" in topics) {
    result.notes.push(topics.problem);
    result.skipped.push({ id: tool.name, reason: topics.problem });
    return result;
  }

  let libraryNames: string[] | undefined;
  if (tool.name === "manimkc") {
    const names = await manimkcLibraryNames(checkout);
    if (names === null) {
      result.notes.push(`manimkc's library was not found under ${path.join(checkout, "lib")}; star-imported helpers are not counted`);
    } else {
      libraryNames = names;
    }
  }
  const typeScript = tool.name === "remotionkc" || tool.name === "revideokc";

  for (const entry of Array.isArray(report.topics) ? report.topics : []) {
    const topicPath = str(entry?.path);
    if (topicPath === null) continue;
    const topicDir = path.join(topics.dir, topicPath);
    if (!inside(topicDir, topics.dir)) {
      result.skipped.push({ id: topicPath, reason: "the topic path leaves the topics folder" });
      continue;
    }
    let walked: string[] | null = null;

    for (const rawSection of Array.isArray(entry.sections) ? (entry.sections as SectionLike[]) : []) {
      const deliverable = rawSection?.deliverable;
      if (!deliverable || deliverable.exists !== true) continue;
      const videoPath = str(deliverable.path);
      if (videoPath === null) continue;
      const assetId = videoToolAssetId(tool, videoPath);
      try {
        let names: string[];
        if (typeScript) {
          walked ??= await walkTypeScript(topicDir);
          names = walked;
        } else {
          names = (Array.isArray(rawSection.files) ? (rawSection.files as Array<{ file?: unknown }>) : [])
            .map((f) => str(f?.file))
            .filter((f): f is string => f !== null);
        }
        if (names.length === 0) {
          result.skipped.push({ id: assetId, reason: `no source files for ${topicPath}` });
          continue;
        }
        const files: SourceFile[] = [];
        let unreadable: string | null = null;
        for (const name of names) {
          const file = path.join(topicDir, name);
          if (!inside(file, topicDir)) {
            unreadable = `${name} leaves the topic folder`;
            break;
          }
          try {
            files.push({ path: name, text: await readFile(file, "utf8") });
          } catch {
            unreadable = `${path.join(topicDir, name)} cannot be read`;
            break;
          }
        }
        if (unreadable !== null) {
          result.skipped.push({ id: assetId, reason: unreadable });
          continue;
        }
        const sceneCount = reportedSceneCount(rawSection.files);
        const ingredients = scanSources(tool.name, files, {
          ...(sceneCount === undefined ? {} : { sceneCount }),
          ...(libraryNames === undefined ? {} : { libraryNames }),
        });
        const duration = deliverable.duration;
        result.videos.push({
          assetId,
          topicPath,
          durationSeconds: typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : null,
          ingredients,
        });
      } catch (error) {
        result.skipped.push({ id: assetId, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  if (typeScript && result.videos.length > 0 && result.videos.some((v) => v.ingredients.metrics.files >= MAX_SOURCE_FILES)) {
    result.notes.push(`a topic folder held more than ${MAX_SOURCE_FILES} source files; the first ${MAX_SOURCE_FILES} were scanned`);
  }
  return result;
}
