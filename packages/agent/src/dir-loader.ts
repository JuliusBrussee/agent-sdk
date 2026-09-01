import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { agent, subagent, type AgentDefinition } from "./index.js";
import { context, type ContextDefinition, type ToolDefinition } from "./primitives.js";
import type { RunBudget } from "./budget.js";
import type { RunBreakers } from "./breakers.js";
import { applyAgentEnvironment, loadAgentEnvironment } from "./agent-environment.js";

/**
 * The agent-directory convention loader (Phase 1, issue #216).
 *
 * `loadAgentDir(rootDir)` lowers a convention directory —
 * `instructions.md` + `agent.ts` + `tools/*.ts` +
 * `subagents/<name>/` — into one ordinary `agent()` call. One module, not a
 * framework: markdown is a plain string read, tools are dynamic imports whose
 * default export must be `tool()`, and everything downstream (definition
 * graph, Context IR, build, sandbox) sees a normal `AgentDefinition`. Optional
 * project skills use canonical `.agents/skills/<name>/SKILL.md` loading from
 * `agent-environment.ts`; this loader adds only that explicit project root.
 */

const TOOL_IMPLEMENTATION_SOURCE = Symbol.for(
  "@caveman-ai/agent:tool-implementation-source",
);

/** Where `loadAgentDir` writes the generated module entry, relative to the directory. */
export const AGENT_DIR_ENTRY = ".caveman/agent-dir-entry.mjs";

export type AgentDirContextValue =
  | string
  | (() => string)
  | {
    value: string | (() => string);
    /**
     * Defaults to `"build"` — LOAD-BEARING: bare entries land in the frozen
     * prefix, which is exactly what Phase 2's volatile-prefix check inspects.
     * `"turn"` places the value in the live zone instead. Either way the
     * value is evaluated ONCE, when the directory is loaded — `"turn"` does
     * not re-evaluate a function per turn (per-turn re-evaluation is issue
     * #224, Phase 2); today it only decides which cache region the segment
     * sits in.
     */
    stability?: "build" | "turn";
  };

/** The shape `agent.ts` default-exports in an agent directory. */
export interface AgentDirConfig {
  model: AgentDefinition["model"];
  /** Run default; an explicit `RunOptions.budget` overrides it. */
  budget?: RunBudget;
  /** Run default; explicit `RunOptions.breakers` override it. */
  breakers?: RunBreakers;
  /** Extra prefix segments, lowered through the `context()` primitive. */
  context?: Record<string, AgentDirContextValue>;
}

export interface AgentDirRunDefaults {
  rootDir?: string;
  /** Relative to `rootDir`; the generated module entry the sandbox stages from. */
  entryPath?: string;
  budget?: RunBudget;
  breakers?: RunBreakers;
}

const runDefaultsRegistry = new WeakMap<AgentDefinition, AgentDirRunDefaults>();

/** Where a directory-loaded context segment came from, for build diagnostics. */
export interface AgentDirContextOrigin {
  /** Convention file that declared the segment (always `agent.ts` today). */
  file: string;
  /** Single-line source of the context value function, when it was one. */
  source?: string;
}

const contextOriginsRegistry = new WeakMap<AgentDefinition, ReadonlyMap<string, AgentDirContextOrigin>>();

/**
 * Context-segment origins for a directory-loaded definition, keyed by context
 * id. Phase 2's volatile-prefix check uses this to name the offending
 * `agent.ts` context entry instead of a bare segment id.
 */
export function agentDirContextOrigins(
  definition: AgentDefinition,
): ReadonlyMap<string, AgentDirContextOrigin> | undefined {
  return contextOriginsRegistry.get(definition);
}

/** Run defaults a directory-loaded definition carries. Explicit RunOptions win. */
export function agentDirRunDefaults(
  definition: AgentDefinition,
): AgentDirRunDefaults | undefined {
  return runDefaultsRegistry.get(definition);
}

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,95}$/;

/**
 * Directory basename → agent id: lowercase, invalid characters become `-`,
 * repeats collapse, leading/trailing `-` trimmed. A name that still cannot be
 * an agent id fails closed with both the name and the slug in the error.
 */
export function slugifyAgentDirId(name: string): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/g, "-")
    .replaceAll(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!AGENT_ID_PATTERN.test(slug)) {
    throw new Error(
      `caveman agent: directory name ${JSON.stringify(name)} slugs to ` +
        `${JSON.stringify(slug)}, which is not a valid agent id`,
    );
  }
  return slug;
}

/** True when `dir` follows the agent-directory convention (instructions.md exists). */
export async function hasAgentDirConvention(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, "instructions.md"))).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/**
 * Map a configured entry to its loadable module: a directory carrying
 * instructions.md (`defineBuild({ entry: "." })`, bare `caveman-agent dev`)
 * means the agent-directory convention, whose module entry is the generated
 * `.caveman/agent-dir-entry.mjs`. A file entry passes through unchanged.
 */
export async function conventionEntryPath(entryAbsolute: string): Promise<string> {
  try {
    if ((await stat(entryAbsolute)).isDirectory() &&
        await hasAgentDirConvention(entryAbsolute)) {
      return resolve(entryAbsolute, AGENT_DIR_ENTRY);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return entryAbsolute;
}

/** What the generated entry hands `composeAgentDir` — see `loadAgentDir`. */
export interface AgentDirModules {
  id: string;
  instructions: string;
  config: AgentDirConfig;
  /** Keyed by tool filename minus `.ts`; values must be `tool()` results. */
  tools: Record<string, unknown>;
  subagents?: Record<string, AgentDefinition>;
}

/**
 * The shared lowering: validated modules in, one `agent()` call out.
 *
 * Both `loadAgentDir` (dynamic directory scan) and the generated
 * `.caveman/agent-dir-entry.mjs` (static imports, so the sandbox source graph
 * is complete and the tool worker recomposes the identical definition) call
 * this same function.
 */
export function composeAgentDir(input: AgentDirModules): AgentDefinition {
  const config = validateAgentDirConfig(input.config);
  if (typeof input.instructions !== "string") {
    throw new Error("caveman agent: agent directory instructions must be a string");
  }
  const tools: ToolDefinition[] = [];
  for (const name of Object.keys(input.tools).sort()) {
    const definition = input.tools[name];
    if (!isToolDefinition(definition)) {
      throw new Error(
        `caveman agent: tools/${name}.ts default export must be a tool()`,
      );
    }
    if (definition.name !== name) {
      throw new Error(
        `caveman agent: tools/${name}.ts declares tool ` +
          `${JSON.stringify(definition.name)} — the filename (minus .ts) must equal the tool name`,
      );
    }
    tools.push(definition);
  }
  const children = input.subagents ?? {};
  for (const name of Object.keys(children).sort()) {
    const child = children[name]!;
    tools.push(subagent({
      name,
      description: `Delegate a task to the ${name} subagent.`,
      agent: child,
    }));
  }
  const contexts: ContextDefinition[] = [];
  const contextOrigins = new Map<string, AgentDirContextOrigin>();
  for (const [name, entry] of Object.entries(config.context ?? {})) {
    const declared = typeof entry === "object" && entry !== null && !isCallable(entry)
      ? entry
      : { value: entry as string | (() => string) };
    contextOrigins.set(name, {
      file: "agent.ts",
      ...(isCallable(declared.value)
        ? { source: String(declared.value).replace(/\s+/g, " ").trim() }
        : {}),
    });
    // Bare entries default to "build" — the frozen prefix. This default is
    // what lets Phase 2's volatile-prefix check catch a run-varying value the
    // author forgot to declare `stability: "turn"`.
    const stability = declared.stability ?? "build";
    if (stability !== "build" && stability !== "turn") {
      throw new Error(
        `caveman agent: context ${JSON.stringify(name)} has unknown stability ` +
          `${JSON.stringify(String(declared.stability))} — use "build" or "turn"`,
      );
    }
    // Evaluated once, here at composition. "turn" stability places the
    // segment in the live zone but does NOT re-evaluate the function per
    // turn — that is issue #224 (Phase 2).
    const source = isCallable(declared.value) ? declared.value() : declared.value;
    if (typeof source !== "string") {
      throw new Error(
        `caveman agent: context ${JSON.stringify(name)} must be a string or return one`,
      );
    }
    contexts.push(context({
      id: name,
      kind: "instruction",
      source,
      stability,
    }));
  }
  const definition = agent({
    id: input.id,
    instructions: input.instructions,
    model: config.model,
    tools,
    contexts,
  });
  const defaults: AgentDirRunDefaults = {
    ...(config.budget === undefined ? {} : { budget: config.budget }),
    ...(config.breakers === undefined ? {} : { breakers: config.breakers }),
  };
  runDefaultsRegistry.set(definition, defaults);
  contextOriginsRegistry.set(definition, contextOrigins);
  return definition;
}

/**
 * Load an agent directory into an `AgentDefinition`.
 *
 * The agent id is the directory basename slugified; `options.id` pins it and
 * is used by the generated entry so a staged copy (whose temp directory has a
 * different basename) recomposes the identical definition. When `options.id`
 * is absent — the ordinary public call — the generated module entry is
 * (re)written at `.caveman/agent-dir-entry.mjs` so sandboxed runs can stage a
 * complete source graph from static imports.
 */
export async function loadAgentDir(
  rootDir: string,
  options?: { id?: string },
): Promise<AgentDefinition> {
  if (typeof rootDir !== "string" || rootDir.trim() === "") {
    throw new Error("caveman agent: loadAgentDir needs a directory path");
  }
  const root = resolve(rootDir);
  const manifest = await scanDirManifest(root, options?.id, 0);
  const composed = await composeFromManifest(root, manifest);
  const environment = await loadAgentEnvironment({
    cwd: root,
    skillRoots: [join(root, ".agents", "skills")],
    includeDefaultRoots: false,
    includeWorkspacePlugin: false,
  });
  if (environment.diagnostics.length > 0) {
    throw new Error(
      `caveman agent: invalid project skills: ${environment.diagnostics
        .map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  const definition = environment.skills.length === 0
    ? composed
    : applyAgentEnvironment(composed, environment);
  if (definition !== composed) {
    const defaults = runDefaultsRegistry.get(composed);
    if (defaults !== undefined) runDefaultsRegistry.set(definition, defaults);
    const origins = contextOriginsRegistry.get(composed);
    if (origins !== undefined) contextOriginsRegistry.set(definition, origins);
  }
  if (options?.id === undefined) {
    await writeGeneratedEntry(root, manifest);
  }
  const defaults = runDefaultsRegistry.get(definition) ?? {};
  runDefaultsRegistry.set(definition, {
    ...defaults,
    rootDir: root,
    entryPath: AGENT_DIR_ENTRY,
  });
  return definition;
}

/**
 * Regenerate `.caveman/agent-dir-entry.mjs` from a pure directory scan —
 * filenames and slugs only, no import of user modules. This is the CLI dev
 * watch path: the loader's actual imports then happen inside the staged
 * snapshot like every other definition input, never against the live tree.
 */
export async function generateAgentDirEntry(rootDir: string): Promise<void> {
  const root = resolve(rootDir);
  await writeGeneratedEntry(root, await scanDirManifest(root, undefined, 0));
}

interface DirManifest {
  /** Posix-relative path from the loaded root; "" for the root itself. */
  readonly relDir: string;
  readonly id: string;
  readonly toolStems: readonly string[];
  readonly subagents: readonly DirManifest[];
}

/**
 * Pure structural scan of a convention directory: existence checks, filename
 * stems, and id slugs. No module is imported — importing is `loadDir`'s /
 * the generated entry's job — so this is safe on the dev watch path.
 */
async function scanDirManifest(
  dir: string,
  idOverride: string | undefined,
  depth: number,
  relDir = "",
): Promise<DirManifest> {
  if (depth > 8) {
    throw new Error(
      `caveman agent: subagent directories nest deeper than 8 under ${dir}`,
    );
  }
  const id = idOverride ?? slugifyAgentDirId(basename(dir));
  if (!await hasAgentDirConvention(dir)) {
    throw new Error(
      `caveman agent: ${dir} has no instructions.md — the agent directory convention requires one; create it (the agent's standing prose), or point the command at the directory that has it`,
    );
  }
  try {
    await stat(join(dir, "agent.ts"));
  } catch {
    throw new Error(
      `caveman agent: ${dir} has no agent.ts — export default an AgentDirConfig ({ model, budget?, breakers?, context? })`,
    );
  }
  const toolStems = await listToolStems(join(dir, "tools"));
  const subagentNames = await listSubagentDirs(join(dir, "subagents"));
  const subagents: DirManifest[] = [];
  const slugSources = new Map<string, string>();
  for (const name of subagentNames) {
    const child = await scanDirManifest(
      join(dir, "subagents", name),
      undefined,
      depth + 1,
      relDir === "" ? `subagents/${name}` : `${relDir}/subagents/${name}`,
    );
    const existing = slugSources.get(child.id);
    if (existing !== undefined) {
      // Two sibling directories collapsing onto one id would silently
      // overwrite a subagent. Fail closed, naming both.
      throw new Error(
        `caveman agent: subagent directories ${JSON.stringify(existing)} and ` +
          `${JSON.stringify(name)} under ${dir} both slug to id ${JSON.stringify(child.id)}`,
      );
    }
    slugSources.set(child.id, name);
    subagents.push(child);
  }
  return { relDir, id, toolStems, subagents };
}

/** Import the manifest's modules and compose the definition (recursively). */
async function composeFromManifest(
  root: string,
  manifest: DirManifest,
): Promise<AgentDefinition> {
  const dir = manifest.relDir === "" ? root : join(root, manifest.relDir);
  const instructions = await readFile(join(dir, "instructions.md"), "utf8");
  const config = (await importFresh(join(dir, "agent.ts")) as { default?: unknown }).default;
  const tools: Record<string, unknown> = {};
  for (const stem of manifest.toolStems) {
    tools[stem] = (await importFresh(join(dir, "tools", `${stem}.ts`)) as {
      default?: unknown;
    }).default;
  }
  const subagents: Record<string, AgentDefinition> = {};
  for (const child of manifest.subagents) {
    subagents[child.id] = await composeFromManifest(root, child);
  }
  return composeAgentDir({
    id: manifest.id,
    instructions,
    config: config as AgentDirConfig,
    tools,
    ...(manifest.subagents.length === 0 ? {} : { subagents }),
  });
}

async function listToolStems(toolsDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(toolsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts"))
    .map((entry) => entry.name.slice(0, -3))
    .sort();
}

async function listSubagentDirs(subagentsDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(subagentsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function validateAgentDirConfig(value: unknown): AgentDirConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "caveman agent: agent.ts must default-export an AgentDirConfig object",
    );
  }
  const allowed = new Set(["model", "budget", "breakers", "context"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new Error(
      `caveman agent: agent.ts config has unknown key ${JSON.stringify(unknown)}`,
    );
  }
  const config = value as AgentDirConfig;
  if (config.model === undefined) {
    throw new Error("caveman agent: agent.ts config needs a model");
  }
  if (config.context !== undefined &&
      (config.context === null || typeof config.context !== "object" ||
        Array.isArray(config.context))) {
    throw new Error("caveman agent: agent.ts context must be a name → value record");
  }
  return config;
}

function isToolDefinition(value: unknown): value is ToolDefinition {
  return value !== null && typeof value === "object" &&
    (value as { kind?: unknown }).kind === "tool" &&
    typeof Reflect.get(value, TOOL_IMPLEMENTATION_SOURCE) === "string";
}

function isCallable(value: unknown): value is () => string {
  return typeof value === "function";
}

function importFresh(path: string): Promise<unknown> {
  return import(
    `${pathToFileURL(path).href}?cave=${Date.now()}-${crypto.randomUUID()}`
  );
}

/**
 * Generate `.caveman/agent-dir-entry.mjs`.
 *
 * The generated module composes the same definition `loadAgentDir` builds,
 * but through STATIC imports and literal `new URL(...)` references, so the
 * source-graph scanner reaches every file the convention loads dynamically.
 * That is what lets the required-sandbox tool worker import the entry from an
 * immutable staged copy — no directory listing, no dynamic import,
 * byte-identical inputs, identical definition digest. The root id is pinned
 * because a staged copy's directory basename differs.
 *
 * Written via temp file + rename, and only when the content changed, so a
 * dev watcher never sees a half-written entry or loops on regeneration.
 */
async function writeGeneratedEntry(root: string, manifest: DirManifest): Promise<void> {
  const source = generatedEntrySource(manifest);
  const entryPath = resolve(root, AGENT_DIR_ENTRY);
  try {
    if (await readFile(entryPath, "utf8") === source) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(entryPath), { recursive: true });
  const temporary = `${entryPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, source);
    await rename(temporary, entryPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function generatedEntrySource(manifest: DirManifest): string {
  const imports: string[] = [];
  let moduleIndex = 0;
  const compose = (dir: DirManifest, indent: string): string => {
    const index = moduleIndex++;
    const prefix = dir.relDir === "" ? ".." : `../${dir.relDir}`;
    imports.push(`import config_${index} from ${JSON.stringify(`${prefix}/agent.ts`)};`);
    const toolPairs: string[] = [];
    for (const stem of dir.toolStems) {
      const variable = `tool_${index}_${toolPairs.length}`;
      imports.push(`import ${variable} from ${JSON.stringify(`${prefix}/tools/${stem}.ts`)};`);
      toolPairs.push(`${JSON.stringify(stem)}: ${variable}`);
    }
    const inner = `${indent}  `;
    const lines = [
      "composeAgentDir({",
      `${inner}id: ${JSON.stringify(dir.id)},`,
      `${inner}instructions: readFileSync(new URL(${JSON.stringify(`${prefix}/instructions.md`)}, import.meta.url), "utf8"),`,
      `${inner}config: config_${index},`,
      `${inner}tools: {${toolPairs.length === 0 ? "" : ` ${toolPairs.join(", ")} `}},`,
    ];
    if (dir.subagents.length > 0) {
      lines.push(`${inner}subagents: {`);
      for (const child of dir.subagents) {
        lines.push(`${inner}  ${JSON.stringify(child.id)}: ${compose(child, `${inner}  `)},`);
      }
      lines.push(`${inner}},`);
    }
    lines.push(`${indent}})`);
    return lines.join("\n");
  };
  const expression = compose(manifest, "");
  return [
    "// GENERATED by @caveman-ai/agent loadAgentDir — do not edit.",
    "// Static imports and literal URL references keep the staged sandbox",
    "// source graph complete; the composition below is the exact lowering",
    "// loadAgentDir performs, with the root id pinned.",
    'import { readFileSync } from "node:fs";',
    'import { fileURLToPath } from "node:url";',
    'import { composeAgentDir } from "@caveman-ai/agent";',
    'import { applyAgentEnvironment, loadAgentEnvironment } from "@caveman-ai/agent/plugins";',
    ...imports,
    `const definition = ${expression};`,
    'const root = fileURLToPath(new URL("..", import.meta.url));',
    'const environment = await loadAgentEnvironment({',
    '  cwd: root,',
    '  skillRoots: [fileURLToPath(new URL("../.agents/skills", import.meta.url))],',
    '  includeDefaultRoots: false,',
    '  includeWorkspacePlugin: false,',
    '});',
    'if (environment.diagnostics.length > 0) {',
    '  throw new Error(`caveman agent: invalid project skills: ${environment.diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("; ")}`);',
    '}',
    'export default environment.skills.length === 0',
    '  ? definition',
    '  : applyAgentEnvironment(definition, environment);',
    "",
  ].join("\n");
}
