import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentDefinition } from "./index.js";
import { expandSourceGraph } from "./source-graph.js";

export interface LoadedDevModule {
  readonly imported: unknown;
  readonly rootDir: string;
  readonly entryPath: string;
  readonly sourceFiles: readonly string[];
  includeFiles(paths: Iterable<string>): Promise<void>;
  includeOptionalFiles(paths: Iterable<string>): Promise<void>;
  includeSourceGraph(paths: Iterable<string>): Promise<void>;
  includeAgentFiles(definition: AgentDefinition): Promise<void>;
  remapError(error: unknown): unknown;
  dispose(): Promise<void>;
}

export async function loadDevModule(root: string, entryPath: string): Promise<LoadedDevModule> {
  const canonicalRoot = await realpath(root);
  const canonicalEntry = await realpath(entryPath);
  const sourceFiles = [...await expandSourceGraph(
    canonicalRoot,
    [canonicalEntry],
    false,
  )].sort();
  const staging = await mkdtemp(resolve(tmpdir(), "caveman-agent-dev-"));
  try {
    await copyOptional(resolve(canonicalRoot, "package.json"), resolve(staging, "package.json"));
    await copyOptional(
      resolve(canonicalRoot, ".caveman/provider.json"),
      resolve(staging, ".caveman/provider.json"),
    );
    for (const source of sourceFiles) {
      await copyProjectFile(canonicalRoot, staging, source, "source graph");
    }
    const nodeModules = await nearestNodeModules(canonicalRoot);
    await symlink(
      nodeModules,
      resolve(staging, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const stagedEntry = resolve(staging, relative(canonicalRoot, canonicalEntry));
    const imported = await import(`${pathToFileURL(stagedEntry).href}?cave=${crypto.randomUUID()}`);
    let disposed = false;
    return {
      imported,
      rootDir: staging,
      entryPath: stagedEntry,
      sourceFiles: Object.freeze(sourceFiles.map((source) =>
        resolve(staging, relative(canonicalRoot, source))
      )),
      async includeFiles(paths) {
        for (const path of paths) {
          await copyProjectFile(canonicalRoot, staging, resolve(canonicalRoot, path), "file source");
        }
      },
      async includeOptionalFiles(paths) {
        for (const path of paths) {
          const source = resolve(canonicalRoot, path);
          try {
            await copyProjectFile(canonicalRoot, staging, source, "file source");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      },
      async includeSourceGraph(paths) {
        const graph = await expandSourceGraph(
          canonicalRoot,
          [...paths].map((path) => resolve(canonicalRoot, path)),
          false,
        );
        for (const path of graph) {
          await copyProjectFile(canonicalRoot, staging, path, "source graph");
        }
      },
      async includeAgentFiles(definition) {
        for (const path of agentFileSourcePaths(definition)) {
          await copyProjectFile(canonicalRoot, staging, resolve(canonicalRoot, path), "file source");
        }
      },
      remapError(error) {
        return remapDevError(error, staging, canonicalRoot);
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        await rm(staging, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw remapDevError(error, staging, canonicalRoot);
  }
}

async function nearestNodeModules(start: string): Promise<string> {
  let current = start;
  for (;;) {
    try {
      return await realpath(resolve(current, "node_modules"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`caveman agent: node_modules not found from ${start}`);
    }
    current = parent;
  }
}

export function agentFileSourcePaths(definition: AgentDefinition): string[] {
  const paths = new Set<string>();
  const visited = new WeakSet<object>();
  const visit = (current: AgentDefinition): void => {
    if (visited.has(current)) return;
    visited.add(current);
    if (typeof current.instructions !== "string") paths.add(current.instructions.path);
    for (const context of current.contexts) {
      if (typeof context.source !== "string") paths.add(context.source.path);
    }
    for (const declared of current.tools) {
      for (const candidate of [declared, ...(declared.nestedTools ?? [])]) {
        if (candidate.runtime?.kind === "subagent") {
          visit(candidate.runtime.definition as AgentDefinition);
        }
      }
    }
  };
  visit(definition);
  return [...paths];
}

async function copyOptional(source: string, destination: string): Promise<void> {
  try {
    await readFile(source);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function copyProjectFile(
  root: string,
  staging: string,
  source: string,
  kind: "source graph" | "file source",
): Promise<void> {
  const name = relative(root, source);
  if (escapesRoot(name)) {
    throw new Error(`caveman agent: dev ${kind} escapes project root`);
  }
  const canonicalSource = await realpath(source);
  if (escapesRoot(relative(root, canonicalSource))) {
    throw new Error(`caveman agent: dev ${kind} symlink escapes project root`);
  }
  const destination = resolve(staging, name);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(canonicalSource, destination);
  await writeTypeScriptRuntimeAlias(root, source, destination);
}

/**
 * NodeNext TypeScript correctly authors `import "./helper.js"` while source is
 * `helper.ts`. Source graph already resolves that identity, but Node's native
 * type stripper does not remap extension. Stage a transpiled runtime alias so
 * dev/build/check execute same graph TypeScript described without mutating
 * project or silently importing stale dist output.
 */
async function writeTypeScriptRuntimeAlias(
  root: string,
  source: string,
  destination: string,
): Promise<void> {
  const suffix = source.endsWith(".mts")
    ? [".mts", ".mjs"] as const
    : source.endsWith(".cts")
      ? [".cts", ".cjs"] as const
      : source.endsWith(".ts")
        ? [".ts", ".js"] as const
        : undefined;
  if (suffix === undefined) return;
  const runtimeSource = source.slice(0, -suffix[0].length) + suffix[1];
  try {
    await realpath(runtimeSource);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (escapesRoot(relative(root, runtimeSource))) {
    throw new Error("caveman agent: dev TypeScript runtime alias escapes project root");
  }
  const runtimeDestination = destination.slice(0, -suffix[0].length) + suffix[1];
  const sourceText = await readFile(source, "utf8");
  let executable: string;
  try {
    executable = stripTypeScriptTypes(sourceText, {
      mode: "transform",
      sourceMap: false,
      sourceUrl: source,
    });
  } catch (error) {
    throw new Error(
      `caveman agent: dev TypeScript transform failed for ${relative(root, source)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  await writeFile(runtimeDestination, executable, { mode: 0o600 });
}

function remapDevError(error: unknown, staging: string, root: string): unknown {
  if (!(error instanceof Error)) return error;
  const mapped = new Error(error.message, { cause: error.cause });
  mapped.name = error.name;
  mapped.stack = (error.stack ?? `${error.name}: ${error.message}`).replaceAll(staging, root);
  return mapped;
}

function escapesRoot(path: string): boolean {
  return path === ".." || path.startsWith("../") || path.startsWith("..\\") || isAbsolute(path);
}
