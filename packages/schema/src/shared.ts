/**
 * The constants and plain types both halves of the repo have to agree on, with
 * no imports.
 *
 * This file deliberately pulls in nothing — not drizzle, not node. That is
 * what makes it importable from a `"use client"` component in `src/` through
 * the `@hermes/schema/shared` subpath without dragging drizzle and a
 * database driver into the browser bundle (layering rule 8 in ARCHITECTURE.md), while
 * `state.ts` re-exports the same values for the service and the migrations.
 *
 * Before bundle 5 these lived twice: `KNOWLEDGE_LIMITS` in the web app's
 * `storage.ts` and a copy in `state.ts`, with a comment asking the two to stay
 * in step. They are now one definition, because the web app clamps a recap on
 * the way in and the database refuses one that was not clamped, and those two
 * numbers being different is a CHECK failure the learner sees as "save
 * failed" for no visible reason.
 */

/** Bounds on a recap, so one runaway session cannot fill a column or a quota. */
export const KNOWLEDGE_LIMITS = {
  summaryChars: 1200,
  listItems: 8,
  itemChars: 300,
} as const;

/** Scheduler bounds, mirroring scripts/learn/lib/schedule.mjs. */
export const SCHEDULE_LIMITS = {
  minEase: 1.3,
  defaultEase: 2.5,
  maxIntervalDays: 36500,
} as const;

/** BKT prior, mirroring scripts/learn/lib/bkt.mjs (`DEFAULT_PARAMS.pL0`). */
export const DEFAULT_P_L = 0.25;

/**
 * The image types a course cover may be, by the file extension its blob key
 * and its export file carry. A closed list: `catalog course cover` refuses
 * anything else by its magic bytes, and the cover route serves only these.
 */
export const COURSE_COVER_TYPES = {
  webp: "image/webp",
  jpg: "image/jpeg",
  png: "image/png",
} as const;
export type CourseCoverExt = keyof typeof COURSE_COVER_TYPES;

/**
 * The largest cover `catalog course cover` stores, in bytes. A card shows it
 * at 960x540 at most, where a WebP is under 100 KB and even a PNG is well
 * under this; anything larger is a photo nobody resized.
 */
export const COURSE_COVER_MAX_BYTES = 2 * 1024 * 1024;

/** The default single learner. One row until auth exists; not a UUID so it stays readable. */
export const LOCAL_LEARNER_ID = "local";

/**
 * The deployment secrets' environment names, shared so the web app's auth
 * core, the BYOK seal and the launchers all read the same variables.
 */
export const OWNER_PASSWORD_VAR = "OWNER_PASSWORD";
export const AUTH_SECRET_VAR = "AUTH_SECRET";

/**
 * The per-launch secret a desktop launcher puts in the spawned server's
 * environment and then redeems at `GET /api/auth/local` for a real session
 * cookie. A random value minted per launch — it is never written to an
 * `.env` file, so a deployment that never runs a launcher simply has it
 * unset, and the route refuses everyone.
 */
export const LOCAL_TOKEN_VAR = "HERMES_LOCAL_TOKEN";

/** Shortest secret accepted: 32 characters is what `openssl rand -base64 32` yields. */
export const MIN_SECRET_LENGTH = 32;

/**
 * The reserved owner of shared content (phase 4 of docs/CONTENT-MIGRATION.md,
 * D23): rows every owner may read and nobody signs in as. A learner id like
 * any other, so `owner_id` needs no second kind of foreign key; its `learner`
 * row is created on first write (`ensureLearner`), as `local`'s is.
 */
export const COMMONS_OWNER = "commons";

/**
 * Whose content one owner may read: their own and the commons. The one
 * definition both the web app (`currentOwner()`) and the catalog's readers use,
 * so a page and a CLI read cannot disagree about what is visible.
 */
export function readableOwners(owner: string): readonly string[] {
  return owner === COMMONS_OWNER ? [COMMONS_OWNER] : [owner, COMMONS_OWNER];
}

/**
 * Who is asking, and whose rows they may see. Every content read takes one
 * (`dbSource`, the asset and concept queries), and every content write is
 * stamped with `owner`.
 */
export interface OwnerScope {
  readonly owner: string;
  readonly readable: readonly string[];
}

/** The scope an owner reads with today: their own rows and the commons. */
export function ownerScope(owner: string): OwnerScope {
  return { owner, readable: readableOwners(owner) };
}

/**
 * The header the web app names the signed-in owner in when it calls the
 * studio runner (`services/studio`). Only the app's server sets it, from
 * `currentOwner()`: the proxy route strips any a page sent before setting its
 * own. The runner serves the one owner it was started for (`STUDIO_OWNER`)
 * and refuses a request naming another.
 */
export const STUDIO_OWNER_HEADER = "x-hermes-owner";

/**
 * Event types in the log. The `learn` CLI writes the first five; the web app
 * writes `watched`, when the learner marks a library asset watched or read
 * (payload `{ asset, kind }`, no concept).
 *
 * `watched` is study for the streak (`STUDY_EVENT_TYPES` in
 * `apps/web/src/lib/habit-core.ts`) and is not evidence: both replays,
 * `replayMastery` and `replayReviews`, read only `observation` and `review`,
 * so watching a video never moves p(L) or schedules a card.
 *
 * `visit` is written by the web app each time the owner opens a course or
 * module page (payload `{ course, module? }`, no concept, no session), by
 * `POST /api/learner/preference` beside the `lastVisited` it keeps. It is
 * neither study nor evidence: the sidebar's Recent and Home's "Pick up where
 * you left off" read it (`apps/web/src/lib/recent.ts`), so a visit older than
 * the five the `recentModules` preference keeps still shows (L7 of
 * docs/proposals/library-by-type-and-day.md).
 *
 * Adding a type here also changes the `event_type_check` constraint, so it
 * needs a migration (`0008` for `watched`, `0025` for `visit`).
 */
export const EVENT_TYPES = [
  "session-start",
  "observation",
  "review",
  "session-close",
  "void",
  "watched",
  "visit",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Where a recap came from: `KnowledgeSource`, below, is this same list.
 */
export const RECAP_SOURCES = ["agent", "manual"] as const;
export type RecapSource = (typeof RECAP_SOURCES)[number];

/**
 * The tutor's model providers, in the order the cascade tries them
 * (`packages/tutor/src/providers.ts`), and the vocabulary of
 * `provider_key.provider` (docs/BYOK.md).
 */
export const PROVIDER_IDS = [
  "nvidia",
  "gemini",
  "openrouter",
  "openai",
  "anthropic",
  "deepseek",
  "glm",
  "qwen",
  "moonshot",
  "minimax",
  "mimo",
  "mistral",
  "groq",
  "xai",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * A provider the owner added themselves (docs/TUTOR-MODELS.md, T14): any
 * OpenAI-compatible endpoint, named `custom-<slug>`. The id lives in the same
 * `provider` columns as a built-in's, so its key is a `provider_key` row and
 * its models are chain entries like any other.
 */
const CUSTOM_PROVIDER_PREFIX = "custom-";
/** `custom-`, then 1 to 40 lowercase letters, digits and hyphens, not starting or ending with a hyphen. */
const CUSTOM_PROVIDER_ID_PATTERN = /^custom-[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
/** The same rule, written for the table's CHECK (a JavaScript pattern, read by the `regexp` function `connect` registers). */
export const CUSTOM_PROVIDER_ID_SQL = "^custom-[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$";
export type CustomProviderId = `custom-${string}`;
/** A built-in provider or one the owner added: what a `provider` column holds. */
export type ProviderName = ProviderId | CustomProviderId;

/** How many providers an owner may add, and how long a name and a base URL may be. */
export const CUSTOM_PROVIDER_LIMITS = { maxProviders: 10, maxLabelChars: 60, maxBaseUrlChars: 300 } as const;

export function isCustomProviderId(value: unknown): value is CustomProviderId {
  return typeof value === "string" && CUSTOM_PROVIDER_ID_PATTERN.test(value);
}

/** A built-in id or a custom one's shape. Whether the owner has that custom provider is the caller's to check. */
export function isProviderName(value: unknown): value is ProviderName {
  return isProviderId(value) || isCustomProviderId(value);
}

/** The hosts a custom provider may reach over plain http: this machine, for a local model server. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A custom provider's base URL, checked (T14): `https:`, or `http:` to this
 * machine only (a local Ollama or LM Studio), with no user name, password,
 * query, fragment or `@` in the path, at most `maxBaseUrlChars` as typed and
 * as stored, and a trailing slash dropped, since the tutor appends
 * `/chat/completions` and `/models`. The owner's key for the provider is sent
 * to exactly this URL and no built-in key ever is. The reason never repeats the value.
 */
export function checkBaseUrl(value: unknown): { ok: true; url: string } | { ok: false; reason: string } {
  if (typeof value !== "string") return { ok: false, reason: "The base URL must be text." };
  const raw = value.trim();
  if (raw.length === 0) return { ok: false, reason: "Enter the provider's base URL." };
  if (raw.length > CUSTOM_PROVIDER_LIMITS.maxBaseUrlChars) {
    return { ok: false, reason: `The base URL is longer than ${CUSTOM_PROVIDER_LIMITS.maxBaseUrlChars} characters.` };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "That is not a URL. It looks like https://api.example.com/v1." };
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return { ok: false, reason: "The base URL must start with https:// (plain http:// only for localhost)." };
  }
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "Put the key in the API key field, not in the URL." };
  if (url.search !== "" || url.hash !== "") return { ok: false, reason: "The base URL takes no query or fragment." };
  // The table's CHECK refuses an `@` anywhere in the path, so this says why
  // here rather than letting the write fail (R3-2-08).
  if (url.pathname.includes("@")) return { ok: false, reason: "The base URL's path cannot contain @." };
  const normal = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  // Parsing percent-encodes what it must (a space is three characters), so
  // the stored value is measured again against the CHECK's limit.
  if (normal.length > CUSTOM_PROVIDER_LIMITS.maxBaseUrlChars) {
    return { ok: false, reason: `The base URL is longer than ${CUSTOM_PROVIDER_LIMITS.maxBaseUrlChars} characters.` };
  }
  return { ok: true, url: normal };
}

/** A custom provider's name, checked: 1 to `maxLabelChars` characters with no control characters. */
export function checkProviderLabel(value: unknown): { ok: true; label: string } | { ok: false; reason: string } {
  if (typeof value !== "string") return { ok: false, reason: "The name must be text." };
  const label = value.trim().replace(/\s+/g, " ");
  if (label.length === 0) return { ok: false, reason: "Give the provider a name." };
  if (label.length > CUSTOM_PROVIDER_LIMITS.maxLabelChars) {
    return { ok: false, reason: `The name is longer than ${CUSTOM_PROVIDER_LIMITS.maxLabelChars} characters.` };
  }
  if (/[\u0000-\u001f\u007f]/.test(label)) return { ok: false, reason: "The name has a character it cannot hold." };
  return { ok: true, label };
}

/** The id a new custom provider gets from its name: `custom-<slug>`, with `-2`, `-3`… when `taken` has it. */
export function customProviderId(label: string, taken: readonly string[]): CustomProviderId {
  const slug =
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/, "") || "provider";
  const used = new Set(taken);
  let id: CustomProviderId = `${CUSTOM_PROVIDER_PREFIX}${slug}`;
  for (let n = 2; used.has(id); n += 1) id = `${CUSTOM_PROVIDER_PREFIX}${slug}-${n}`;
  return id;
}

/**
 * The bounds on a stored provider key (docs/BYOK.md, decision 5). Saving
 * checks the shape only; the Test button is the real check. The floor keeps
 * the four characters Settings shows from being a large part of the key: every
 * real key is well past it (NVIDIA's and OpenRouter's are about 70, Gemini's
 * 39). The ceiling bounds the ciphertext, which a CHECK repeats.
 */
export const PROVIDER_KEY_LIMITS = { minChars: 16, maxChars: 512 } as const;

/** Each provider as a person reads it: every message, card and attempt shows this, never the id. */
export const PROVIDER_LABELS = {
  nvidia: "NVIDIA NIM",
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  glm: "Zhipu GLM",
  qwen: "Alibaba Qwen",
  moonshot: "Moonshot Kimi",
  minimax: "MiniMax",
  mimo: "Xiaomi MiMo",
  mistral: "Mistral",
  groq: "Groq",
  xai: "xAI Grok",
} as const satisfies Record<ProviderId, string>;

/** A provider's label, or the value itself when it names no provider. */
export function providerLabel(value: string): string {
  return isProviderId(value) ? PROVIDER_LABELS[value] : value;
}

/** Whether `value` names a provider the tutor knows. */
function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * The bounds on the tutor's model chain (docs/TUTOR-MODELS.md): how many
 * entries an owner may keep, and how long a model id may be. Every tutor turn
 * walks the chain until one answers, so the entry cap also caps how many
 * provider requests one failing turn can spend. The id cap is well past any
 * real id (OpenRouter's longest are about 60 characters). A CHECK repeats both.
 */
export const TUTOR_MODEL_LIMITS = { maxEntries: 10, maxModelChars: 200 } as const;

/**
 * A model chain grouped by provider: each provider's entries together, in
 * their order, and the providers in the order each first appears. Settings
 * shows the chain this way (each provider's models under it) and the tutor
 * walks it this way, so the two cannot disagree even for a chain written
 * before the grouping, whose providers could interleave. Stable, and the
 * identity on a chain that is already grouped.
 */
export function groupByProvider<T extends { provider: string }>(chain: readonly T[]): T[] {
  const order: string[] = [];
  const blocks = new Map<string, T[]>();
  for (const entry of chain) {
    let block = blocks.get(entry.provider);
    if (block === undefined) {
      block = [];
      blocks.set(entry.provider, block);
      order.push(entry.provider);
    }
    block.push(entry);
  }
  return order.flatMap((provider) => blocks.get(provider) ?? []);
}

/** Printable ASCII with no space: what a model id is made of, and all a request header or JSON body needs. */
export const MODEL_ID_PATTERN = /^[\x21-\x7e]+$/;

/**
 * Whether a model id looks like an API key rather than a model
 * (docs/TUTOR-MODELS.md, T11): it starts with a provider key prefix (NVIDIA's
 * `nvapi-`, OpenRouter's `sk-or-`, OpenAI-style `sk-`, Google's `AIza`), or it
 * holds a run of 20 or more letters and digits with both in it, which random
 * key material does and model ids, whose words are split by `-`, `.`, `/` or
 * `:`, do not. A model chain row is stored in the clear and exported, so a
 * key pasted into the wrong field must never reach it.
 */
export function looksLikeKey(model: string): boolean {
  if (/^(nvapi-|sk-|AIza)/.test(model)) return true;
  for (const run of model.match(/[A-Za-z0-9]{20,}/g) ?? []) {
    if (/[0-9]/.test(run) && /[A-Za-z]/.test(run)) return true;
  }
  return false;
}

/**
 * A model id as sent by a person or a provider, checked (docs/TUTOR-MODELS.md,
 * T5, T11): surrounding whitespace dropped, then 1 to `maxModelChars`
 * characters of printable ASCII with no whitespace, and nothing that looks
 * like an API key. The reason never repeats the value.
 */
export function checkModelId(value: unknown): { ok: true; model: string } | { ok: false; reason: string } {
  if (typeof value !== "string") return { ok: false, reason: `"model" must be a string.` };
  const model = value.trim();
  if (model.length === 0) return { ok: false, reason: "The model id is empty." };
  if (model.length > TUTOR_MODEL_LIMITS.maxModelChars) {
    return { ok: false, reason: `A model id is at most ${TUTOR_MODEL_LIMITS.maxModelChars} characters.` };
  }
  if (!MODEL_ID_PATTERN.test(model)) {
    return { ok: false, reason: "A model id is printable ASCII with no spaces." };
  }
  if (looksLikeKey(model)) {
    return { ok: false, reason: "That looks like an API key, not a model id. Keys go under Provider keys." };
  }
  return { ok: true, model };
}

/**
 * Preference keys the web app and the CLI both know by name.
 *
 * `preference` is a key/value table precisely so a new one costs no migration,
 * but the handful that are read from two places are named here so a typo in one
 * of them is a type error rather than a silently missing value.
 */
export const PREFERENCE_KEYS = {
  /** One of `THEME_MODES`. Mirrored into a cookie so the root layout can render it. */
  theme: "theme",
  /** Bumps on a progress reset so client UI state remounts. */
  epoch: "epoch",
  /** `{ courseSlug, moduleSlug?, at }`. */
  lastVisited: "lastVisited",
  /**
   * `{ courseSlug, moduleSlug?, at }[]`, newest first, at most five: the
   * modules Home lists under "Pick up where you left off". Never written by a
   * browser: `POST /api/learner/preference` keeps it whenever it writes
   * `lastVisited`, which stays a single object because the course list
   * resumes from it (docs/proposals/home-page.md).
   */
  recentModules: "recentModules",
  /** `Record<moduleId, UserResource[]>`. Keyed by module, which joins nothing. */
  userResources: "userResources",
  /**
   * `string[]`: the slugs of the courses the learner has set aside. Absent or
   * empty means every course is active, so a course added later starts
   * active. The Courses page folds these under "Inactive courses", and
   * Continue learning on it and on Today leaves them out.
   */
  inactiveCourses: "inactiveCourses",
  /** BKT parameters, overriding `DEFAULT_PARAMS`. Was `model.json`'s `params`. */
  bktParams: "bktParams",
  /**
   * `{ concepts: number; reviews: boolean }`: the learner's own daily target,
   * concepts to teach or probe plus whether clearing the due queue counts.
   * Unread and unwritable since the habit layer was removed (H1 of
   * docs/proposals/home-page.md); named so the stored rows keep a name.
   */
  dailyTarget: "dailyTarget",
  /**
   * A whole number of free misses per Monday-to-Sunday week before the streak
   * breaks, 0 to 7. Unread and unwritable since H1, like `dailyTarget`.
   */
  dailyLeeway: "dailyLeeway",
  /**
   * How the tutor talks: one of `TUTOR_STYLES` in `apps/web/src/lib/preferences.ts`,
   * default `"guide-concise"`. Written from Settings; read by the concept
   * tutor and the session question writer (`apps/web/src/lib/settings.ts`).
   */
  tutorStyle: "tutorStyle",
  /**
   * `"system"` (follow the operating system's reduced-motion setting, the
   * default) or `"always"` (reduce motion whatever the system says). Written
   * from Settings; read by the signed-in layout through
   * `apps/web/src/lib/motion-preference.ts`, which `lib/motion.ts` builds on.
   */
  reducedMotion: "reducedMotion",
  /**
   * The model and effort the studio's video agent runs with (D53 of
   * docs/STUDIO-VIDEOS.md): `{ model, effort }`, each `"default"` or a value
   * the CLI takes. Written from the studio's settings panel; the runner reads
   * it at job start through `catalog preference get`. See
   * `studioAgentPreference` for the reading every consumer shares.
   */
  studioVideoAgent: "studioVideoAgent",
  /** The same for the studio's diagram agent. Absent means today's `sonnet`, the runner's default. */
  studioDiagramAgent: "studioDiagramAgent",
  /**
   * `{ key, kind, title, href, at }[]`, newest pin first: the rows the owner
   * pinned in the sidebar's Recent (L7 of
   * docs/proposals/library-by-type-and-day.md), each a copy of the row as it
   * was pinned, so a pin outlives the row leaving Recent. Written by
   * `POST /api/learner/recent`, never through the preference route.
   */
  pinned: "pinned",
} as const;

export type PreferenceKey = (typeof PREFERENCE_KEYS)[keyof typeof PREFERENCE_KEYS];

/** The two preference keys D53 of docs/STUDIO-VIDEOS.md names, and the only ones `catalog preference get` answers. */
export const STUDIO_AGENT_PREFERENCE_KEYS = [PREFERENCE_KEYS.studioVideoAgent, PREFERENCE_KEYS.studioDiagramAgent] as const;
export type StudioAgentPreferenceKey = (typeof STUDIO_AGENT_PREFERENCE_KEYS)[number];

/** The effort levels `claude --effort` takes (2.1.274). */
export const AGENT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

/** A studio agent's model and effort: `"default"` means the owner's Claude Code default, resolved by the runner. */
export interface StudioAgentPreference {
  model: string;
  effort: "default" | AgentEffort;
}

/**
 * A model name `claude --model` could take, and the one rule every reader and
 * writer of a studio agent preference shares: an alias or a full id, lower
 * case, letters, digits, dots and hyphens, and at most one context suffix in
 * brackets at the end (`claude-fable-5-1[1m]`). Never a flag. A looser rule at
 * set time than at read time once stored "Sonnet", which the runner then read
 * as "default" and ran on the owner's own, dearer default.
 */
const AGENT_MODEL = /^[a-z][a-z0-9.-]{0,79}(\[[0-9a-z]{1,8}\])?$/;

/** Whether a string is a model name a studio agent preference may hold (see `AGENT_MODEL`). */
export function isAgentModel(value: unknown): value is string {
  return typeof value === "string" && AGENT_MODEL.test(value);
}

/**
 * A stored `studioVideoAgent` or `studioDiagramAgent` value, read the one way
 * the web app, the runner and the CLI all read it: each field kept when it is
 * a value the CLI takes, and `"default"` otherwise, so a hand-edited row can
 * never put a stray flag on the agent's command line.
 */
export function studioAgentPreference(value: unknown): StudioAgentPreference {
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const model = typeof record.model === "string" && (record.model === "default" || isAgentModel(record.model)) ? record.model : "default";
  const effort =
    typeof record.effort === "string" && (AGENT_EFFORTS as readonly string[]).includes(record.effort)
      ? (record.effort as AgentEffort)
      : "default";
  return { model, effort };
}

/** Clamp one list of strings the way both the web app and the store must. */
export function clampKnowledgeList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().slice(0, KNOWLEDGE_LIMITS.itemChars))
    .filter((value) => value !== "")
    .slice(0, KNOWLEDGE_LIMITS.listItems);
}

/** Clamp a recap summary the way both the web app and the store must. */
export function clampSummary(value: unknown): string {
  return typeof value === "string"
    ? value.trim().slice(0, KNOWLEDGE_LIMITS.summaryChars)
    : "";
}

/* -------------------------------------------------------------------------- */
/* The learner state shape                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What a learner snapshot looks like once it leaves the database.
 *
 * These are declared here because both sides need them:
 * `services/catalog/src/state/` builds the snapshot and the web app's
 * provider consumes it, importing them from `@hermes/schema/shared`.
 *
 * The keys deliberately match the old localStorage document, minus `version`.
 * They are the argument to `/api/learner/import`, and a component reading
 * `state.completed[id]` should not have to care that the bytes now come from
 * the catalog.
 */

/**
 * The theme is two choices stored as one string. The **palette** is `classic`
 * (the original kit colours) or `hermes` (the brand's); the **appearance** is
 * `light`, `dark`, or `system`, which follows the device's
 * `prefers-color-scheme`. One string, not two keys, so the cookie the root
 * layout reads, the `preference` row and the import each keep a single value.
 *
 * The first four names predate the palette axis and keep their meaning, so
 * nothing already stored changes: `light`, `dark` and `system` are the classic
 * palette, and `hermes` is Hermes light. The two Hermes modes that came later
 * say both halves. Adding a mode here is the whole schema change;
 * `themeModeFor` must still name every pair.
 */
export const THEME_MODES = ["light", "hermes", "dark", "system", "hermes-dark", "hermes-system"] as const;

export type ThemeMode = (typeof THEME_MODES)[number];

export const THEME_PALETTES = ["classic", "hermes"] as const;
export type ThemePalette = (typeof THEME_PALETTES)[number];

export const THEME_APPEARANCES = ["light", "dark", "system"] as const;
export type ThemeAppearance = (typeof THEME_APPEARANCES)[number];

/** The mode a stored or posted value names, or null for anything else. */
export function asThemeMode(value: unknown): ThemeMode | null {
  // The palette predates the rename: cookies and preference rows written
  // before it still say `self-learn*`, which are the hermes modes renamed.
  if (typeof value === "string" && (value.startsWith("self-learn") || value.startsWith("gnosia"))) {
    const prefix = value.startsWith("self-learn") ? "self-learn" : "gnosia";
    value = `hermes${value.slice(prefix.length)}`;
  }
  return typeof value === "string" && (THEME_MODES as readonly string[]).includes(value) ? (value as ThemeMode) : null;
}

const MODE_FOR: Record<ThemePalette, Record<ThemeAppearance, ThemeMode>> = {
  classic: { light: "light", dark: "dark", system: "system" },
  hermes: { light: "hermes", dark: "hermes-dark", system: "hermes-system" },
};

/** The one mode that stores a palette and an appearance together. */
export function themeModeFor(palette: ThemePalette, appearance: ThemeAppearance): ThemeMode {
  return MODE_FOR[palette][appearance];
}

/** Which palette a mode draws with. */
export function paletteOf(mode: ThemeMode): ThemePalette {
  return mode === "hermes" || mode.startsWith("hermes-") ? "hermes" : "classic";
}

/** Whether a mode is light, dark, or follows the device. */
export function appearanceOf(mode: ThemeMode): ThemeAppearance {
  if (mode === "dark" || mode === "hermes-dark") return "dark";
  if (mode === "system" || mode === "hermes-system") return "system";
  return "light";
}

/** Where a recap came from. The same vocabulary as `RECAP_SOURCES`. */
export type KnowledgeSource = RecapSource;

/**
 * Durable record of what the learner established about one curriculum item.
 * `topicId` is the curriculum item id (`cs4263-m1-t1`), not a shared-vocabulary
 * topic slug; the name predates the catalog and is kept so the components and
 * the old localStorage payload still line up.
 */
export interface TopicKnowledge {
  topicId: string;
  summary: string;
  keyPoints: string[];
  misconceptions: string[];
  openQuestions: string[];
  source: KnowledgeSource;
  updatedAt: string;
  /** How many agent sessions have been folded into this record. */
  sessions: number;
}

/** Fields a summariser (or the learner) supplies; the rest is derived. */
export interface KnowledgeInput {
  summary: string;
  keyPoints: string[];
  misconceptions: string[];
  openQuestions: string[];
  source: KnowledgeSource;
}

export interface UserResource {
  id: string;
  title: string;
  url: string;
}

/** At most 50 modules, 50 links each: a personal reading list, not a mirror. */
export const USER_RESOURCE_LIMITS = { modules: 50, perModule: 50, chars: 2_000, moduleIdChars: 128 } as const;

/**
 * Whether a reading-list URL may be stored: http(s) only. The value comes back
 * out into an href, and a stored `javascript:` URL would be a self-inflicted
 * XSS on the next render.
 */
export function isUserResourceUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * A reading list with what the preference route would refuse dropped rather
 * than refused: a URL that is not http(s), a field past the length cap, a
 * module id too long, and anything past the module and per-module caps. For
 * a writer that must not fail on one bad entry (the legacy import), so every
 * way in is held to the preference route's rules.
 */
export function keepValidUserResources(value: Record<string, readonly UserResource[]>): Record<string, UserResource[]> {
  const out: Record<string, UserResource[]> = {};
  for (const [moduleId, list] of Object.entries(value)) {
    if (Object.keys(out).length >= USER_RESOURCE_LIMITS.modules) break;
    if (moduleId === "" || moduleId.length > USER_RESOURCE_LIMITS.moduleIdChars) continue;
    const kept = list
      .filter(
        (r) =>
          isUserResourceUrl(r.url) &&
          [r.id, r.title, r.url].every((text) => typeof text === "string" && text.length <= USER_RESOURCE_LIMITS.chars),
      )
      .slice(0, USER_RESOURCE_LIMITS.perModule)
      .map((r) => ({ id: r.id, title: r.title, url: r.url }));
    if (kept.length > 0) out[moduleId] = kept;
  }
  return out;
}

export interface LastVisited {
  courseSlug: string;
  moduleSlug?: string;
  at: string;
}

export interface LearnerState {
  theme: ThemeMode;
  completed: Record<string, true>;
  notes: Record<string, string>;
  userResources: Record<string, UserResource[]>;
  /** Per-curriculum-item recaps. */
  knowledge: Record<string, TopicKnowledge>;
  /** Bumps when progress is reset so local UI state can remount. */
  epoch: number;
  lastVisited?: LastVisited;
  /** Course slugs the learner set aside (`PREFERENCE_KEYS.inactiveCourses`). */
  inactiveCourses: string[];
  /**
   * What the learner asked to be called (`learner.display_name`), shown in
   * the sidebar's account row and set on Settings. Absent until they set one.
   */
  displayName?: string;
  /**
   * The learner's pixel sprite (`learner.avatar`), shown in the sidebar's
   * account row and chosen on Settings' Profile tab. Every learner row has
   * one, drawn at random when the row is made; absent only in the state
   * rendered before anything is known, or with the database unreachable.
   */
  avatar?: AvatarId;
}

/**
 * The pixel sprites a learner can wear, in the order the picker lists them:
 * the library's familiars (docs/design/BRAND.md, "Avatar sprites"). The
 * names are stored in `learner.avatar`, whose check constraint and random
 * default are written from this list, so adding one is a migration; the
 * pictures are `apps/web/src/components/avatar/sprites.ts`.
 */
export const AVATARS = [
  "owl",
  "cat",
  "bookworm",
  "fox",
  "hedgehog",
  "raven",
  "frog",
  "mouse",
  "moth",
  "tortoise",
  "rabbit",
  "bat",
] as const;

export type AvatarId = (typeof AVATARS)[number];

export function isAvatar(value: unknown): value is AvatarId {
  return typeof value === "string" && (AVATARS as readonly string[]).includes(value);
}

/** What a learner's sprite is called in words, for its picker label and a screen reader. */
export function avatarLabel(id: AvatarId): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** The longest name `learner.display_name` takes, in characters. */
export const DISPLAY_NAME_MAX = 60;

/**
 * A name as it is stored: trimmed, inner runs of whitespace (a tab, a line
 * break) as one space, and null when nothing is left. Anything but a string
 * is null too. Length is the writer's to refuse (`DISPLAY_NAME_MAX`), never
 * cut here, so a reader cannot silently shorten what was saved.
 */
export function cleanDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned === "" ? null : cleaned;
}

/**
 * The tutor's wrong options for one note check (`check_distractor`): how many
 * a row holds, and the longest one the parser and the table take.
 */
export const CHECK_DISTRACTOR_LIMITS = { options: 3, maxOptionChars: 400 } as const;

/** The longest name `asset_name.title` takes, in characters. */
export const ASSET_NAME_MAX = 200;

/**
 * An asset's name as the learner typed it, stored the way `cleanDisplayName`
 * stores theirs: trimmed, whitespace runs as one space, null when nothing is
 * left. Null means "no name of mine", so the source's title shows again.
 */
export function cleanAssetName(value: unknown): string | null {
  return cleanDisplayName(value);
}

/* -------------------------------------------------------------------------- */
/* Ratings: a learner's thumbs up or down on an asset                         */
/* -------------------------------------------------------------------------- */

/** What a thumbs down may say was wrong. Stored in `asset_rating.tags` and `job.review`. */
export const RATING_TAGS_DOWN = [
  "same-look",
  "too-much-text",
  "too-slow",
  "too-fast",
  "picture-mismatch",
  "wrong",
  "voice",
  "too-long",
] as const;
export type RatingTagDown = (typeof RATING_TAGS_DOWN)[number];

/** What a thumbs up may say was good. */
export const RATING_TAGS_UP = ["clear", "good-visuals", "good-pacing"] as const;
export type RatingTagUp = (typeof RATING_TAGS_UP)[number];

export type RatingTag = RatingTagDown | RatingTagUp;

/** The words a page shows for each tag, in sentence case. */
export const RATING_TAG_LABELS: Readonly<Record<RatingTag, string>> = {
  "same-look": "Looks like the others",
  "too-much-text": "Too much text",
  "too-slow": "Too slow",
  "too-fast": "Too fast",
  "picture-mismatch": "Picture does not match the words",
  wrong: "Wrong or misleading",
  voice: "Voice",
  "too-long": "Too long",
  clear: "Easy to follow",
  "good-visuals": "Good visuals",
  "good-pacing": "Good pacing",
};

/** The longest note a rating or a review takes, and the most tags one carries. */
export const RATING_LIMITS = { maxNoteChars: 2000, maxTags: 8 } as const;

/** Where a rating was given: the library's asset page, or the studio's review. */
export const RATING_SURFACES = ["library", "studio"] as const;
export type RatingSurface = (typeof RATING_SURFACES)[number];

/** Down, cleared, up. A 0 is a rating taken back, stored as a row of its own. */
export const RATING_VALUES = [-1, 0, 1] as const;
export type RatingValue = (typeof RATING_VALUES)[number];

/** A rating as it is stored: a value, its tags, and a note or null. */
export interface CleanRating {
  value: RatingValue;
  tags: RatingTag[];
  note: string | null;
}

/**
 * The tags a value may carry: down tags with -1, up tags with 1, none with 0.
 * Readonly, so a caller cannot grow the vocabulary by pushing onto it.
 */
export function ratingTagsFor(value: RatingValue): readonly RatingTag[] {
  if (value === -1) return RATING_TAGS_DOWN;
  if (value === 1) return RATING_TAGS_UP;
  return [];
}

/**
 * A note as a rating or a review stores it: trimmed, null when blank. The
 * inside is kept as typed, line breaks included, since a note is prose.
 * Refuses rather than cuts one past `RATING_LIMITS.maxNoteChars`.
 */
function cleanNote(value: unknown): { ok: true; note: string | null } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true, note: null };
  if (typeof value !== "string") return { ok: false, reason: "A note is text." };
  const note = value.trim();
  if (note === "") return { ok: true, note: null };
  if (note.length > RATING_LIMITS.maxNoteChars) {
    return { ok: false, reason: `A note is at most ${RATING_LIMITS.maxNoteChars} characters; this one has ${note.length}.` };
  }
  return { ok: true, note };
}

/** A tag list checked against `allowed`, in the order given, each tag once. */
function cleanTags(
  value: unknown,
  allowed: readonly string[],
  what: string,
): { ok: true; tags: string[] } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true, tags: [] };
  if (!Array.isArray(value)) return { ok: false, reason: "Tags are a list." };
  const tags: string[] = [];
  for (const tag of value) {
    if (typeof tag !== "string") return { ok: false, reason: "Each tag is text." };
    if (!allowed.includes(tag)) {
      return {
        ok: false,
        reason:
          allowed.length === 0
            ? `${what} carries no tags, so "${tag}" cannot go on it.`
            : `"${tag}" is not a tag ${what} takes. Known: ${allowed.join(", ")}.`,
      };
    }
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > RATING_LIMITS.maxTags) {
    return { ok: false, reason: `At most ${RATING_LIMITS.maxTags} tags; this has ${tags.length}.` };
  }
  return { ok: true, tags };
}

/**
 * A rating from a form or a flag, checked and cleaned: `value` is -1, 0 or 1
 * (0 takes a rating back); `tags` must belong to that value's list
 * (`ratingTagsFor`), each kept once in the order given; `note` is trimmed and
 * null when blank. Pure, so a page and the writer refuse the same input with
 * the same sentence.
 */
export function cleanRating(input: {
  value: unknown;
  tags?: unknown;
  note?: unknown;
}): { ok: true; rating: CleanRating } | { ok: false; reason: string } {
  const value = input.value;
  if (value !== -1 && value !== 0 && value !== 1) {
    return { ok: false, reason: "A rating is -1 (down), 0 (cleared) or 1 (up)." };
  }
  const what = value === -1 ? "a thumbs down" : value === 1 ? "a thumbs up" : "a cleared rating";
  const tags = cleanTags(input.tags, ratingTagsFor(value), what);
  if (!tags.ok) return tags;
  const note = cleanNote(input.note);
  if (!note.ok) return note;
  return { ok: true, rating: { value, tags: tags.tags as RatingTag[], note: note.note } };
}

/**
 * What every "the learner dismissed the rating prompt for this asset"
 * preference key starts with: one `preference` row per asset,
 * `ratingPrompt:<asset id>`, the shape `favorite:<asset id>` and
 * `playback:<asset id>` already take (`@hermes/tutor/favorite`,
 * `@hermes/tutor/playback`). Those two prefixes live with their features;
 * this one is here because the rating vocabulary is.
 */
export const RATING_PROMPT_PREFERENCE_PREFIX = "ratingPrompt:";

export function ratingPromptKey(assetId: string): string {
  return `${RATING_PROMPT_PREFERENCE_PREFIX}${assetId}`;
}

/* -------------------------------------------------------------------------- */
/* A job's run and review records (`job.run`, `job.review`)                   */
/* -------------------------------------------------------------------------- */

/** One gate pass over an attempt's output. */
export interface JobRunGate {
  ok: boolean;
  steps: Array<{ name: string; ok: boolean }>;
  findings: number;
  warnings: number;
}

/**
 * What a vision critic scores on a video attempt's contact sheets, each
 * from 1 (poor) to 5 (good):
 *
 * - `accuracy`: the picture shows what the words say.
 * - `layout`: nothing overlaps, is cut off or is crowded.
 * - `relevance`: the picture helps explain the idea and is not decoration.
 * - `variety`: scenes differ in shot and layout.
 * - `pacing`: the screen changes with the voice, with no long held frames.
 */
export const CRITIC_DIMENSIONS = ["accuracy", "layout", "relevance", "variety", "pacing"] as const;
export type CriticDimension = (typeof CRITIC_DIMENSIONS)[number];

/** The lowest and highest score a critic gives on one dimension. */
export const CRITIC_SCORE_RANGE = { min: 1, max: 5 } as const;

/**
 * The pass mark for a critic's scores (D121 of docs/STUDIO-LOOK.md). It is
 * provisional: the numbers were picked after seeing the 2026-11-20 benchmark,
 * and they stand until the owner's own thumbs ratings can calibrate them.
 * A video passes when no score is below `CRITIC_PASS_MIN_SCORE` and the mean
 * of the five is at least `CRITIC_PASS_MIN_MEAN`.
 */
export const CRITIC_PASS_MIN_SCORE = 3;
export const CRITIC_PASS_MIN_MEAN = 3.5;

/**
 * Whether a critic's scores pass the mark above. The one place the rule
 * lives: the bench's compare and anything that reports a pass call this.
 * It reads scores only; a defect never decides it, and a retry in `retry`
 * mode keys on defects, not on this. Fails closed: anything that is not an
 * object with a finite score from `CRITIC_SCORE_RANGE.min` to
 * `CRITIC_SCORE_RANGE.max` for each of `CRITIC_DIMENSIONS` does not pass.
 * The mean is compared as a sum, so a mean of exactly 3.5 passes with no
 * rounding in the way.
 */
export function passesCritic(scores: unknown): boolean {
  if (scores === null || typeof scores !== "object" || Array.isArray(scores)) return false;
  let sum = 0;
  for (const dimension of CRITIC_DIMENSIONS) {
    const score = (scores as Record<string, unknown>)[dimension];
    if (typeof score !== "number" || !Number.isFinite(score)) return false;
    if (score < CRITIC_SCORE_RANGE.min || score > CRITIC_SCORE_RANGE.max) return false;
    if (score < CRITIC_PASS_MIN_SCORE) return false;
    sum += score;
  }
  return sum >= CRITIC_PASS_MIN_MEAN * CRITIC_DIMENSIONS.length;
}

/**
 * A critic's read of one attempt's contact sheets: whole scores from 1
 * (poor) to 5 (good) on each of `CRITIC_DIMENSIONS`, all five required.
 */
export interface JobRunCritic {
  /** The model that judged, when the stream named one. */
  model: string | null;
  /** What the critic's own call cost. */
  costUsd: number | null;
  scores: Record<CriticDimension, number>;
  /** How many pointable defects it sent back to the agent. */
  defects: number;
  /** How many remarks it only reported. */
  notes: number;
}

/** One attempt of a job, as the runner saw it. */
export interface JobRunAttempt {
  /** 1, 2, 3: the attempt's number. */
  n: number;
  /** An ISO 8601 instant with a zone, stored in UTC as `toISOString` writes it (`normaliseInstant`), or null when not known. */
  startedAt: string | null;
  endedAt: string | null;
  turns: number | null;
  costUsd: number | null;
  gate: JobRunGate | null;
  /**
   * A vision critic's verdict on this attempt, when one judged it. The one
   * key an attempt may leave out: a record written before critics existed
   * has none, and keeps none when checked.
   */
  critic?: JobRunCritic | null;
}

/**
 * The runner's record of how a job was run (`job.run`): which harness and
 * model, with what effort and manual, and what each attempt did.
 * `transcriptPath` is relative to the runner's `STUDIO_HOME`, as
 * `job.candidate_path` is, and an absolute one is refused.
 */
export interface JobRun {
  harness: { name: string; version: string | null };
  /** The model the job asked for, and the one the stream said answered. */
  model: { passed: string | null; resolved: string | null };
  effort: string | null;
  manualHash: string | null;
  /**
   * The hash of the manual's text with everything job-specific normalised
   * out (the job's own paths), so two jobs run under the same manual share
   * one. `manualHash` names the file the agent read and differs for every
   * video job; this is the value to group jobs by. The one key a run record
   * may leave out: a record written before it existed has none, and keeps
   * none when checked.
   */
  manualVersion?: string | null;
  auth: string | null;
  attempts: JobRunAttempt[];
  /** How many times the job called each tool or helper, by name. */
  calls: Record<string, number>;
  renderSeconds: number | null;
  transcriptPath: string | null;
}

/** What a person decided about a job's output. */
export const JOB_VERDICTS = ["accept", "discard", "revise"] as const;
export type JobVerdict = (typeof JOB_VERDICTS)[number];

/** A person's verdict detail on a job (`job.review`). Tags are from `RATING_TAGS_DOWN`. */
export interface JobReview {
  verdict: JobVerdict;
  tags: RatingTagDown[];
  note: string | null;
  /** When the review was written: an ISO 8601 instant, stored in UTC (`normaliseInstant`). */
  at: string;
}

/** Bounds on a `JobRun`, so one record cannot grow without limit. */
export const JOB_RUN_LIMITS = { maxAttempts: 20, maxGateSteps: 100, maxCalls: 500, maxChars: 500 } as const;

type Check<T> = { ok: true; value: T } | { ok: false; reason: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `YYYY-MM-DDTHH:MM:SS`, an optional fraction of 1 to 9 digits, and an
 * explicit zone: `Z`, or a `+hh:mm` or `-hh:mm` offset.
 */
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * An ISO 8601 instant with an explicit zone, as `toISOString` writes it (in
 * UTC, with milliseconds), or null for anything else: a time with no zone
 * (which each reader would place in its own), a date alone, a locale form
 * such as `11/20/2026 10:00`, or a calendar date that does not exist
 * (`2026-02-30`, `24:00`), which `Date.parse` would quietly roll over. So the
 * same instant is always stored as the same string, whatever offset it came
 * in.
 */
export function normaliseInstant(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const match = ISO_INSTANT.exec(value);
  if (match === null) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  // The fields as written, read back through the calendar: a day or hour that
  // does not exist comes back as a different one.
  const fields = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    fields.getUTCFullYear() !== year ||
    fields.getUTCMonth() !== month - 1 ||
    fields.getUTCDate() !== day ||
    fields.getUTCHours() !== hour ||
    fields.getUTCMinutes() !== minute ||
    fields.getUTCSeconds() !== second
  ) {
    return null;
  }
  const [offsetHours, offsetMinutes] = [match[7], match[8]].map((part) => (part === undefined ? 0 : Number(part))) as [number, number];
  if (offsetHours > 23 || offsetMinutes > 59) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

const isAmount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** The keys `value` has that `known` does not name, so a misspelt field is refused rather than dropped. */
function strayKeys(value: Record<string, unknown>, known: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !known.includes(key));
}

function shortText(value: unknown, field: string, nullable: boolean): Check<string | null> {
  if (value === null && nullable) return { ok: true, value: null };
  if (typeof value !== "string" || value === "" || value.length > JOB_RUN_LIMITS.maxChars) {
    return {
      ok: false,
      reason: `${field} is ${nullable ? "null or " : ""}text of 1 to ${JOB_RUN_LIMITS.maxChars} characters.`,
    };
  }
  return { ok: true, value };
}

/**
 * A path relative to the runner's `STUDIO_HOME`: no leading slash, no drive
 * letter, no backslash, no `.` or `..` segment. The same rule
 * `job.candidate_path` holds to, since `STUDIO_HOME` moves between machines
 * and an absolute path would carry this one's into the database.
 */
export function isStudioRelativePath(value: string): boolean {
  if (value === "" || value.length > JOB_RUN_LIMITS.maxChars) return false;
  if (value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:/.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function checkGate(value: unknown, field: string): Check<JobRunGate | null> {
  if (value === null) return { ok: true, value: null };
  if (!isPlainObject(value)) return { ok: false, reason: `${field} is null or an object.` };
  const stray = strayKeys(value, ["ok", "steps", "findings", "warnings"]);
  if (stray.length > 0) return { ok: false, reason: `${field} has unknown fields: ${stray.join(", ")}.` };
  if (typeof value.ok !== "boolean") return { ok: false, reason: `${field}.ok is true or false.` };
  if (!Array.isArray(value.steps) || value.steps.length > JOB_RUN_LIMITS.maxGateSteps) {
    return { ok: false, reason: `${field}.steps is a list of at most ${JOB_RUN_LIMITS.maxGateSteps}.` };
  }
  const steps: JobRunGate["steps"] = [];
  for (const [index, step] of value.steps.entries()) {
    const at = `${field}.steps[${index}]`;
    if (!isPlainObject(step) || strayKeys(step, ["name", "ok"]).length > 0) {
      return { ok: false, reason: `${at} is { name, ok }.` };
    }
    const name = shortText(step.name, `${at}.name`, false);
    if (!name.ok) return name;
    if (typeof step.ok !== "boolean") return { ok: false, reason: `${at}.ok is true or false.` };
    steps.push({ name: name.value as string, ok: step.ok });
  }
  if (!isCount(value.findings)) return { ok: false, reason: `${field}.findings is a whole number, 0 or more.` };
  if (!isCount(value.warnings)) return { ok: false, reason: `${field}.warnings is a whole number, 0 or more.` };
  return { ok: true, value: { ok: value.ok, steps, findings: value.findings, warnings: value.warnings } };
}

function checkCritic(value: unknown, field: string): Check<JobRunCritic | null> {
  if (value === null) return { ok: true, value: null };
  if (!isPlainObject(value)) return { ok: false, reason: `${field} is null or an object.` };
  const known = ["model", "costUsd", "scores", "defects", "notes"] as const;
  const stray = strayKeys(value, known);
  if (stray.length > 0) return { ok: false, reason: `${field} has unknown fields: ${stray.join(", ")}.` };
  const missing = known.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) return { ok: false, reason: `${field} is missing: ${missing.join(", ")}.` };
  const model = shortText(value.model, `${field}.model`, true);
  if (!model.ok) return model;
  if (value.costUsd !== null && !isAmount(value.costUsd)) {
    return { ok: false, reason: `${field}.costUsd is null or a number, 0 or more.` };
  }
  const scores = value.scores;
  if (!isPlainObject(scores)) {
    return { ok: false, reason: `${field}.scores is an object with a score for each of ${CRITIC_DIMENSIONS.join(", ")}.` };
  }
  const strayScores = strayKeys(scores, CRITIC_DIMENSIONS);
  if (strayScores.length > 0) {
    return { ok: false, reason: `${field}.scores has unknown fields: ${strayScores.join(", ")}.` };
  }
  const checkedScores = {} as Record<CriticDimension, number>;
  for (const dimension of CRITIC_DIMENSIONS) {
    const score = scores[dimension];
    if (!Number.isInteger(score) || (score as number) < CRITIC_SCORE_RANGE.min || (score as number) > CRITIC_SCORE_RANGE.max) {
      return {
        ok: false,
        reason: `${field}.scores.${dimension} is a whole number from ${CRITIC_SCORE_RANGE.min} to ${CRITIC_SCORE_RANGE.max}.`,
      };
    }
    checkedScores[dimension] = score as number;
  }
  if (!isCount(value.defects)) return { ok: false, reason: `${field}.defects is a whole number, 0 or more.` };
  if (!isCount(value.notes)) return { ok: false, reason: `${field}.notes is a whole number, 0 or more.` };
  return {
    ok: true,
    value: {
      model: model.value,
      costUsd: value.costUsd as number | null,
      scores: checkedScores,
      defects: value.defects,
      notes: value.notes,
    },
  };
}

function checkAttempt(value: unknown, field: string): Check<JobRunAttempt> {
  if (!isPlainObject(value)) return { ok: false, reason: `${field} is an object.` };
  const stray = strayKeys(value, ["n", "startedAt", "endedAt", "turns", "costUsd", "gate", "critic"]);
  if (stray.length > 0) return { ok: false, reason: `${field} has unknown fields: ${stray.join(", ")}.` };
  if (!Number.isInteger(value.n) || (value.n as number) < 1) {
    return { ok: false, reason: `${field}.n is a whole number, 1 or more.` };
  }
  const instants: Record<"startedAt" | "endedAt", string | null> = { startedAt: null, endedAt: null };
  for (const key of ["startedAt", "endedAt"] as const) {
    if (value[key] === null) continue;
    const instant = normaliseInstant(value[key]);
    if (instant === null) {
      return { ok: false, reason: `${field}.${key} is null or an ISO 8601 instant with a zone (Z or +hh:mm).` };
    }
    instants[key] = instant;
  }
  if (value.turns !== null && !isCount(value.turns)) {
    return { ok: false, reason: `${field}.turns is null or a whole number, 0 or more.` };
  }
  if (value.costUsd !== null && !isAmount(value.costUsd)) {
    return { ok: false, reason: `${field}.costUsd is null or a number, 0 or more.` };
  }
  const gate = checkGate(value.gate, `${field}.gate`);
  if (!gate.ok) return gate;
  const attempt: JobRunAttempt = {
    n: value.n as number,
    startedAt: instants.startedAt,
    endedAt: instants.endedAt,
    turns: value.turns as number | null,
    costUsd: value.costUsd as number | null,
    gate: gate.value,
  };
  // The one optional key: carried only when the input had it, so a record
  // written before critics existed comes back exactly as it went in.
  if (Object.hasOwn(value, "critic")) {
    const critic = checkCritic(value.critic, `${field}.critic`);
    if (!critic.ok) return critic;
    attempt.critic = critic.value;
  }
  return { ok: true, value: attempt };
}

const JOB_RUN_KEYS = [
  "harness",
  "model",
  "effort",
  "manualHash",
  "auth",
  "attempts",
  "calls",
  "renderSeconds",
  "transcriptPath",
  "manualVersion",
] as const;

/** The keys of a run record that a record written before they existed may leave out. */
const JOB_RUN_OPTIONAL_KEYS: readonly string[] = ["manualVersion"];

/**
 * A `JobRun` checked field by field, the way `catalog job finish --run-file`
 * stores it: every field present (null where the shape allows it), no field
 * the shape does not name, and `transcriptPath` relative to `STUDIO_HOME`.
 * The value comes back rebuilt from the checked fields, never the input
 * object itself.
 */
export function checkJobRun(input: unknown): { ok: true; run: JobRun } | { ok: false; reason: string } {
  if (!isPlainObject(input)) return { ok: false, reason: "A run record is a JSON object." };
  const stray = strayKeys(input, JOB_RUN_KEYS);
  if (stray.length > 0) return { ok: false, reason: `The run record has unknown fields: ${stray.join(", ")}.` };
  const missing = JOB_RUN_KEYS.filter((key) => !JOB_RUN_OPTIONAL_KEYS.includes(key) && !Object.hasOwn(input, key));
  if (missing.length > 0) return { ok: false, reason: `The run record is missing: ${missing.join(", ")}.` };

  const harness = input.harness;
  if (!isPlainObject(harness) || strayKeys(harness, ["name", "version"]).length > 0) {
    return { ok: false, reason: "harness is { name, version }." };
  }
  const harnessName = shortText(harness.name, "harness.name", false);
  if (!harnessName.ok) return harnessName;
  const harnessVersion = shortText(harness.version, "harness.version", true);
  if (!harnessVersion.ok) return harnessVersion;

  const model = input.model;
  if (!isPlainObject(model) || strayKeys(model, ["passed", "resolved"]).length > 0) {
    return { ok: false, reason: "model is { passed, resolved }." };
  }
  const passed = shortText(model.passed, "model.passed", true);
  if (!passed.ok) return passed;
  const resolved = shortText(model.resolved, "model.resolved", true);
  if (!resolved.ok) return resolved;

  const texts: Record<"effort" | "manualHash" | "auth", string | null> = { effort: null, manualHash: null, auth: null };
  for (const key of ["effort", "manualHash", "auth"] as const) {
    const checked = shortText(input[key], key, true);
    if (!checked.ok) return checked;
    texts[key] = checked.value;
  }

  // Carried only when the input had it, so an older record comes back as it went in.
  let manualVersion: string | null | undefined;
  if (Object.hasOwn(input, "manualVersion")) {
    const checked = shortText(input.manualVersion, "manualVersion", true);
    if (!checked.ok) return checked;
    manualVersion = checked.value;
  }

  if (!Array.isArray(input.attempts) || input.attempts.length > JOB_RUN_LIMITS.maxAttempts) {
    return { ok: false, reason: `attempts is a list of at most ${JOB_RUN_LIMITS.maxAttempts}.` };
  }
  const attempts: JobRunAttempt[] = [];
  for (const [index, attempt] of input.attempts.entries()) {
    const checked = checkAttempt(attempt, `attempts[${index}]`);
    if (!checked.ok) return checked;
    attempts.push(checked.value);
  }

  if (!isPlainObject(input.calls)) return { ok: false, reason: "calls is an object of name to count." };
  const entries = Object.entries(input.calls);
  if (entries.length > JOB_RUN_LIMITS.maxCalls) {
    return { ok: false, reason: `calls names at most ${JOB_RUN_LIMITS.maxCalls} tools; this names ${entries.length}.` };
  }
  const calls: Record<string, number> = {};
  for (const [name, count] of entries) {
    if (name === "" || name.length > JOB_RUN_LIMITS.maxChars) {
      return { ok: false, reason: `calls has a name of ${name.length} characters; a name is 1 to ${JOB_RUN_LIMITS.maxChars}.` };
    }
    if (!isCount(count)) return { ok: false, reason: `calls["${name}"] is a whole number, 0 or more.` };
    calls[name] = count;
  }

  if (input.renderSeconds !== null && !isAmount(input.renderSeconds)) {
    return { ok: false, reason: "renderSeconds is null or a number, 0 or more." };
  }
  const transcriptPath = input.transcriptPath;
  if (transcriptPath !== null && (typeof transcriptPath !== "string" || !isStudioRelativePath(transcriptPath))) {
    return {
      ok: false,
      reason: `transcriptPath ${JSON.stringify(transcriptPath)} is not relative to the runner's STUDIO_HOME. Pass a path such as jobs/<id>/transcript.ndjson, or null.`,
    };
  }

  return {
    ok: true,
    run: {
      harness: { name: harnessName.value as string, version: harnessVersion.value },
      model: { passed: passed.value, resolved: resolved.value },
      effort: texts.effort,
      manualHash: texts.manualHash,
      ...(manualVersion === undefined ? {} : { manualVersion }),
      auth: texts.auth,
      attempts,
      calls,
      renderSeconds: input.renderSeconds as number | null,
      transcriptPath: transcriptPath as string | null,
    },
  };
}

/**
 * A `JobReview` checked: a verdict from `JOB_VERDICTS`, tags from
 * `RATING_TAGS_DOWN` (each once), a note cleaned as a rating's is, and `at`
 * an ISO 8601 instant with a zone, stored in UTC (`normaliseInstant`).
 */
export function checkJobReview(input: unknown): { ok: true; review: JobReview } | { ok: false; reason: string } {
  if (!isPlainObject(input)) return { ok: false, reason: "A review is a JSON object." };
  const stray = strayKeys(input, ["verdict", "tags", "note", "at"]);
  if (stray.length > 0) return { ok: false, reason: `The review has unknown fields: ${stray.join(", ")}.` };
  const verdict = input.verdict;
  if (typeof verdict !== "string" || !(JOB_VERDICTS as readonly string[]).includes(verdict)) {
    return { ok: false, reason: `A verdict is one of ${JOB_VERDICTS.join(", ")}.` };
  }
  const tags = cleanTags(input.tags, RATING_TAGS_DOWN, "a review");
  if (!tags.ok) return tags;
  const note = cleanNote(input.note);
  if (!note.ok) return note;
  const at = normaliseInstant(input.at);
  if (at === null) return { ok: false, reason: "at is an ISO 8601 instant with a zone (Z or +hh:mm)." };
  return {
    ok: true,
    review: { verdict: verdict as JobVerdict, tags: tags.tags as RatingTagDown[], note: note.note, at },
  };
}

/**
 * What the app renders before anything is known: a fresh learner, and also the
 * honest answer when the database is unreachable. Nothing distinguishes the
 * two in the state itself; `LearnerProvider` carries the reachability flag
 * beside it, because a page that quietly shows zero progress and one that says
 * it could not reach the database are very different things to a learner.
 */
export const emptyLearnerState = (): LearnerState => ({
  theme: "light",
  completed: {},
  notes: {},
  userResources: {},
  knowledge: {},
  epoch: 0,
  inactiveCourses: [],
});

/**
 * The localStorage document as it was written up to bundle 5, accepted by
 * `/api/learner/import` exactly once per browser. Every field is optional and
 * unknown-typed: this is data written by an older build, so it is parsed
 * defensively rather than trusted.
 */
export const LEGACY_STORAGE_KEY = "self-learn:v1";

/* -------------------------------------------------------------------------- */
/* The studio: sessions and jobs                                              */
/* -------------------------------------------------------------------------- */

/**
 * The two kinds of session that share one id space.
 *
 * `tutor` is what `learn session start` opens; `studio` is what a generation
 * runner opens. One table with a discriminator rather than two, because
 * `event.session_id` needs exactly one foreign key target and a polymorphic
 * column is the shape this schema rejects everywhere else.
 */
export const SESSION_KINDS = ["tutor", "studio"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

/**
 * `interrupted` is never written by the process itself — it is what a
 * reconcile pass concludes about a process that stopped writing heartbeats.
 * That is why it is distinct from `failed`: "it died" and "it exited non-zero"
 * are different facts and the row should not conflate them.
 */
export const SESSION_STATES = [
  "running",
  "closed",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/**
 * What a generation job produces: a tldraw diagram, or a manimkc video made
 * through the studio's chat (docs/STUDIO-VIDEOS.md). A video job's
 * `target_path` is `videos/<slug>.mp4`, a logical name like a diagram's.
 */
export const JOB_KINDS = ["diagram", "video"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATES = [
  "queued",
  "running",
  "awaiting_review",
  "accepted",
  "discarded",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type JobState = (typeof JOB_STATES)[number];

/**
 * Where a job's `cost_usd` came from.
 *
 * `result` is the agent's own `total_cost_usd`, which only exists when the
 * session exited cleanly. `stream` is the runner's accumulation from the
 * intermediate per-message `usage` events, which is what a cancelled, timed-out
 * or interrupted attempt leaves behind — and which under-reports, because the
 * `output_tokens` on those events is the value before the message finished
 * generating. `services/studio/src/cost.ts` carries the measurements.
 *
 * Both are recorded, because a cap that counted only the clean finishes would
 * be a cap anybody could walk past by pressing Cancel. They are told apart,
 * because a reader who cannot do that cannot tell a bill from a guess.
 */
export const COST_SOURCES = ["result", "stream"] as const;
export type CostSource = (typeof COST_SOURCES)[number];

/**
 * The states that hold the lease on a committed path.
 *
 * A job in any of these owns `target_path` and no second job may take it: an
 * unaccepted candidate still holds it, because the next brief would be written
 * against a file the first job has not landed yet. Enforced by the partial
 * unique index `job_active_target_key`, so the refusal is a unique-constraint
 * failure (the catalog's `sqlstate` reads it as `23505`) naming the holder
 * rather than a race nobody sees.
 */
export const JOB_ACTIVE_STATES = ["queued", "running", "awaiting_review"] as const;
export type JobActiveState = (typeof JOB_ACTIVE_STATES)[number];

/**
 * Every transition either lifecycle allows, as `from -> to`. Anything absent
 * is refused, and the four (five for a job) terminal states are terminal:
 * their entries are empty.
 *
 * These are data rather than a switch statement because three places need the
 * same answer — the CLI's conditional updates, the runner's reconcile pass and
 * the UI's button states — and a second copy of a state machine is a second
 * state machine.
 */
export const SESSION_TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> = {
  running: ["closed", "failed", "cancelled", "interrupted"],
  closed: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

/**
 * `queued -> interrupted` is deliberately absent: a queued job survives a
 * restart, because nothing was in flight to lose. `awaiting_review ->
 * interrupted` is present, because the candidate outlives the process that
 * wrote it and a restart has to decide whether it is still trustworthy.
 */
export const JOB_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  queued: ["running", "cancelled"],
  running: ["awaiting_review", "failed", "cancelled", "interrupted"],
  awaiting_review: ["accepted", "discarded", "interrupted"],
  accepted: [],
  discarded: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

/**
 * What a studio draft's briefs produce (D42 of docs/STUDIO-CHAT-FIRST.md):
 * a diagram or a video. A draft's `kind` is its newest brief's, for display
 * (D62 of docs/STUDIO-MENTIONS.md, which superseded D51's kind fixed after
 * the first paid turn).
 */
export const DRAFT_KINDS = ["diagram", "video"] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

/**
 * A draft is one conversation with the studio's planner.
 *
 * `open` has no valid brief in force; `briefed` has one and Draw is live;
 * `drawing` follows its newest job while that job is in flight or waiting for
 * review; `done` is a drawing accepted or discarded; `abandoned` is closed for
 * good, by a person or by the turn cap.
 */
export const DRAFT_STATES = ["open", "briefed", "drawing", "done", "abandoned"] as const;
export type DraftState = (typeof DRAFT_STATES)[number];

/** The last failure a draft records: a refused first request, a brief refused twice, a turn cut off. */
export const DRAFT_ERROR_KINDS = ["agent", "brief-invalid", "timeout", "interrupted"] as const;
export type DraftErrorKind = (typeof DRAFT_ERROR_KINDS)[number];

/**
 * The draft's lifecycle (the state diagram in docs/STUDIO-CHAT-FIRST.md), as
 * data for the reason the job's is. A newer brief on a `briefed` draft, or
 * another question on an `open` one, is a write to the row and not a
 * transition, so neither state lists itself.
 */
export const DRAFT_TRANSITIONS: Readonly<Record<DraftState, readonly DraftState[]>> = {
  // `open -> drawing` and `done -> drawing` are a Resume or a Revise from the
  // job panel, which carry the job's draft: the conversation follows the new
  // job whatever it was doing when the button was pressed.
  open: ["briefed", "drawing", "abandoned"],
  briefed: ["open", "drawing", "abandoned"],
  drawing: ["briefed", "done"],
  done: ["open", "drawing"],
  abandoned: [],
};

/** Is `to` reachable from `from`? The one place either state machine is read. */
export function canTransition(
  transitions: Readonly<Record<string, readonly string[]>>,
  from: string,
  to: string,
): boolean {
  return (transitions[from] ?? []).includes(to);
}

/** A value JSON can hold. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * A value in canonical form: keys sorted at every depth, instants as ISO
 * strings, `undefined` keys dropped. The one definition of "the same content"
 * that a revision's `snapshot_hash`, a diagram's `document_hash` and the
 * studio's check of a checked-out `.tldr` all hash, so the three cannot drift.
 * Here because the studio reaches the catalog through its CLI only and takes
 * nothing else from it.
 */
export function canonical(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as object).sort()) {
      const inner = (value as Record<string, unknown>)[key];
      if (inner !== undefined) out[key] = canonical(inner);
    }
    return out;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  throw new Error(`cannot put a ${typeof value} in canonical JSON`);
}

/** The canonical serialisation. `JSON.stringify` of a canonical value is already stable. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

/**
 * A studio video's narration timing, shared by the web app's brief card and
 * the studio runner's validator and gate so the two cannot predict different
 * lengths for the same script. The speech rate itself is gnosia-audio's,
 * which each side reads at run time (the runner from `home --json`, the card
 * from the runner's `/api/health`), so it is a parameter here.
 */

/** The voice value for a video with no narration. */
export const SILENT_VOICE = "none";

/** The finished video over the speech: 1.03 to 1.15 measured, 1.08 taken. */
export const VIDEO_OVER_SPEECH = 1.08;

/**
 * Seconds of video the given narration lines predict at `charsPerSecond`.
 * NaN when there is no usable rate, which a caller shows as unknown rather
 * than guess.
 */
export function narrationSeconds(lines: readonly string[], charsPerSecond: number | undefined): number {
  // Infinity is no rate either: it would predict every script as 0 seconds.
  if (charsPerSecond === undefined || !Number.isFinite(charsPerSecond) || charsPerSecond <= 0) return Number.NaN;
  const characters = lines.reduce((sum, line) => sum + line.length, 0);
  return (characters / charsPerSecond) * VIDEO_OVER_SPEECH;
}

/** Whether a brief's `voice` narrates the video: anything but `SILENT_VOICE`. */
export function isNarratedVoice(voice: string): boolean {
  return voice !== SILENT_VOICE;
}

/** A silent video's predicted seconds: every beat's `seconds`, a beat with none counting 0. */
export function silentSeconds(scenes: ReadonlyArray<{ beats: ReadonlyArray<{ seconds?: number }> }>): number {
  return scenes.reduce((sum, scene) => sum + scene.beats.reduce((s, beat) => s + (beat.seconds ?? 0), 0), 0);
}

/* -------------------------------------------------------------------------- */
/* The shot plan (docs/STUDIO-VIDEOS.md, "The shot plan")                     */
/* -------------------------------------------------------------------------- */

/**
 * The kinds of picture a scene can be built as. The art director picks one
 * per scene, the card shows it, and the video agent builds the scene to it.
 */
export const SHOT_TYPES = [
  "title",
  "build-up-diagram",
  "code-walk",
  "data-chart",
  "comparison",
  "timeline",
  "array-or-memory",
  "tree-or-graph",
  "equation",
  "object-3d",
  "metaphor",
  "recap-map",
] as const;
export type ShotType = (typeof SHOT_TYPES)[number];

/** Each shot type as the card names it, in sentence case. */
export const SHOT_TYPE_LABELS: Readonly<Record<ShotType, string>> = {
  title: "Title",
  "build-up-diagram": "Build-up diagram",
  "code-walk": "Code walk",
  "data-chart": "Data chart",
  comparison: "Comparison",
  timeline: "Timeline",
  "array-or-memory": "Array or memory view",
  "tree-or-graph": "Tree or graph",
  equation: "Equation",
  "object-3d": "3D object",
  metaphor: "Metaphor",
  "recap-map": "Recap map",
};

/**
 * When each shot type is the right picture, one line each. These lines go
 * into the art director's prompt and into each video tool's manual, so a
 * change here changes both.
 */
export const SHOT_TYPE_USE: Readonly<Record<ShotType, string>> = {
  title: "the opening only: the video's question or claim in large type, with one small picture that hints at the answer",
  "build-up-diagram": "a mechanism with parts: boxes and arrows added one piece per beat until the whole system is on screen",
  "code-walk": "real code read line by line: a code panel with the current line highlighted and its effect shown beside it",
  "data-chart": "numbers compared or changing: a line, bar or share chart drawn from real values",
  comparison: "two or three options side by side: matching columns or panels, with the difference marked on each",
  timeline: "events or steps in order over time: an axis that fills from left to right as the voice moves on",
  "array-or-memory": "how data sits in memory: cells in a row or grid, with indices, pointers and values that move or change",
  "tree-or-graph": "nodes and edges: a hierarchy, a network or a search, with the current node or path lit",
  equation: "a formula derived or explained: its terms built up and changed in place, each part tied to what it means",
  "object-3d": "a physical thing or a shape in space: one object turned or cut open in depth, with light and shadow",
  metaphor: "an abstract idea shown as a familiar picture (a queue at a counter, water in a pipe), then mapped back to the real terms",
  "recap-map": "the closing only: every earlier idea as one small labelled map, each lit in turn as the voice names it",
};

/** One scene's picture plan, approved by a person on the card. */
export interface VideoShot {
  type: ShotType;
  /** Where things sit in the frame, in frame terms: left third, centre, top band. */
  layout: string;
  /** The one motion idea that carries the scene. */
  motion: string;
  /** What the eye must land on, and how it is marked. */
  emphasis: string;
}

/** The longest each shot field may be, in characters. */
export const SHOT_TEXT_LIMITS: Readonly<Record<"layout" | "motion" | "emphasis", number>> = {
  layout: 200,
  motion: 200,
  emphasis: 160,
};

export function isShotType(value: unknown): value is ShotType {
  return typeof value === "string" && (SHOT_TYPES as readonly string[]).includes(value);
}
