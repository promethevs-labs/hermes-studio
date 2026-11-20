import { SHOT_TYPE_LABELS, SHOT_TYPES, type ShotType } from "@hermes/schema/shared";

/**
 * remotionkc's shot patterns (D113 of docs/STUDIO-LOOK.md): the `shots` list
 * of `remotionkc api --json`, one component per entry with the shot type it
 * serves, a use-when line and a usage line, as `lib/shots/catalog.ts` holds
 * them.
 *
 * Read once per job by `remotionkcApiListing`, which the remotionkc doctor
 * also runs at the studio's start and every refresh, so the art director's
 * TOOL block (`shotPatternsFor`) takes the last read with no subprocess of
 * its own. The manual's section and the art director's lines are both
 * grouped by shot type in `SHOT_TYPES` order, and within a type in the
 * catalogue's order: never ordered or annotated by how often a pattern was
 * used, since the list is for choosing by what the scene needs.
 */

export interface ShotPattern {
  /** The exported component, an identifier. */
  name: string;
  shotType: ShotType;
  /** One line, starting "use when". */
  useWhen: string;
  /** A minimal JSX line that renders it. */
  usage: string;
}

const NAME = /^[A-Z][A-Za-z0-9]{0,60}$/;

/** One line of text the CLI gave, or null when it is not one plain line short enough to put in a prompt. */
function line(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "" || text.length > limit || /[\r\n]/.test(text) || text.includes("-----") || text.includes("```")) return null;
  return text;
}

/**
 * The shot patterns in an `api --json` answer, each checked: an identifier
 * for a name, a shot type from `SHOT_TYPES`, and one plain line each for the
 * use-when and usage text. An entry that fails any of those is left out
 * rather than trusted, and an answer with no `shots` (a checkout before the
 * shot library) gives none.
 */
export function readShotPatterns(json: unknown): ShotPattern[] {
  const shots = typeof json === "object" && json !== null ? (json as { shots?: unknown }).shots : undefined;
  if (!Array.isArray(shots)) return [];
  const out: ShotPattern[] = [];
  const seen = new Set<string>();
  for (const entry of shots) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, shotType, useWhen, usage } = entry as Record<string, unknown>;
    if (typeof name !== "string" || !NAME.test(name) || seen.has(name)) continue;
    if (typeof shotType !== "string" || !(SHOT_TYPES as readonly string[]).includes(shotType)) continue;
    const when = line(useWhen, 240);
    const example = line(usage, 400);
    if (when === null || example === null) continue;
    seen.add(name);
    out.push({ name, shotType: shotType as ShotType, useWhen: when, usage: example });
  }
  return out;
}

/** The patterns grouped by shot type, in `SHOT_TYPES` order, each type's patterns in the order given; types with none are left out. */
export function byShotType(patterns: readonly ShotPattern[]): { type: ShotType; patterns: ShotPattern[] }[] {
  return SHOT_TYPES.map((type) => ({ type, patterns: patterns.filter((pattern) => pattern.shotType === type) })).filter((group) => group.patterns.length > 0);
}

/** The patterns of the last `api --json` read, by listing text, so the manual shows exactly the read its listing came from. */
const readsByListing = new Map<string, ShotPattern[]>();
/** The patterns of the last read, for the art director. */
let lastRead: ShotPattern[] = [];

/** Keep a read's patterns: under its listing text for the manual, and as the latest for the art director. */
export function rememberShotPatterns(listing: string, patterns: ShotPattern[]): void {
  readsByListing.delete(listing);
  readsByListing.set(listing, patterns);
  // A few listings at most are ever live at once: one per checkout state.
  while (readsByListing.size > 8) readsByListing.delete(readsByListing.keys().next().value!);
  lastRead = patterns;
}

/** The patterns read with this listing text; none for a listing no read here produced. */
export function shotPatternsOfListing(listing: string): ShotPattern[] {
  return readsByListing.get(listing) ?? [];
}

/** The last read's patterns (none before the first read). */
export function lastShotPatterns(): ShotPattern[] {
  return lastRead;
}

/** Forget every read (tests). */
export function forgetShotPatterns(): void {
  readsByListing.clear();
  lastRead = [];
}

/** Markdown inline code for a text that may hold backticks itself (a `String.raw` template): a fence one longer than its longest run. */
export function inlineCode(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  if (longest === 0) return `\`${text}\``;
  const fence = "`".repeat(longest + 1);
  return `${fence} ${text} ${fence}`;
}

/** The heading `remotionkc api` opens its text with when it lists shots. */
const API_SHOTS_HEADING = "Shots, by what the scene needs";

/**
 * The api text without its opening shots section, which the manual shows
 * from the JSON instead: everything from the `rules` line on. A listing that
 * does not open with the shots heading is returned as it is.
 */
export function listingWithoutShots(listing: string): string {
  if (!listing.trimStart().startsWith(API_SHOTS_HEADING)) return listing;
  const at = listing.search(/^rules$/m);
  return at === -1 ? listing : listing.slice(at);
}

/**
 * The manual's "Shot patterns" section, ending in a blank line: every
 * pattern under its shot type's label, with its use-when line and its usage
 * line. Empty when the checkout lists none.
 */
export function shotPatternsSection(patterns: readonly ShotPattern[], docs: string): string {
  const groups = byShotType(patterns);
  if (groups.length === 0) return "";
  const lines = [
    "## Shot patterns, by shot type",
    "",
    `The library has a pattern for each shot type: a component that lays a whole scene's body out in the theme, takes its timing as frame numbers, and reads its colours and fonts from \`useTheme\`. They are listed under the shot type a scene's \`shot\` names, in the order of "Shot types" above. \`${docs}/SHOTS.md\` has each one's props, defaults and a fuller example: Read a pattern's entry there before you use it.`,
    "",
  ];
  for (const group of groups) {
    lines.push(`### \`${group.type}\` (${SHOT_TYPE_LABELS[group.type]})`, "");
    for (const pattern of group.patterns) {
      lines.push(`- \`${pattern.name}\`: ${pattern.useWhen}.`, `  ${inlineCode(pattern.usage)}`);
    }
    lines.push("");
  }
  const missing = SHOT_TYPES.filter((type) => !groups.some((group) => group.type === type));
  if (missing.length > 0) lines.push(`No pattern covers ${missing.map((type) => `\`${type}\``).join(", ")}: build those scenes by hand inside \`SceneFrame\`.`, "");
  lines.push("");
  return lines.join("\n");
}
