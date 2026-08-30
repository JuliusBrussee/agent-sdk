#!/usr/bin/env node
// Generates caveman-docs/reference/api/*.md from built .d.ts entrypoints.
// Source of truth is the type surface, not prose: run after `npm run build`.
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "caveman-docs/reference/api");

/** Packages whose published entrypoints get a reference page. */
const PACKAGES = [
  "packages/agent",
  "packages/adapter-kit",
  "packages/adapter-conformance",
  "packages/coding-agent",
  "packages/evals",
  "packages/pebble-protocol",
  ...["claude-agent-sdk", "cloudflare-agents", "eve", "langgraph", "mastra",
      "openai-agents", "pi", "strands-agents", "vercel-ai-sdk"]
    .map((n) => `packages/adapters/${n}`),
];

const KIND_PLURAL = {
  Class: "Classes",
  Interface: "Interfaces",
  "Type alias": "Type aliases",
  Enum: "Enums",
  Function: "Functions",
  Variable: "Variables & constants",
  Namespace: "Namespaces",
  Other: "Other exports",
};
const KIND_ORDER = Object.keys(KIND_PLURAL);

function kindOf(decl) {
  if (ts.isClassDeclaration(decl)) return "Class";
  if (ts.isInterfaceDeclaration(decl)) return "Interface";
  if (ts.isTypeAliasDeclaration(decl)) return "Type alias";
  if (ts.isEnumDeclaration(decl)) return "Enum";
  if (ts.isFunctionDeclaration(decl)) return "Function";
  if (ts.isVariableDeclaration(decl)) return "Variable";
  if (ts.isModuleDeclaration(decl)) return "Namespace";
  return "Other";
}

function declText(decl) {
  const sf = decl.getSourceFile();
  const node = ts.isVariableDeclaration(decl) ? (decl.parent.parent ?? decl) : decl;
  return sf.text.slice(node.getStart(sf, false), node.getEnd()).trim();
}

function docText(decl) {
  const parts = ts.getJSDocCommentsAndTags(decl)
    .map((n) => (typeof n.comment === "string" ? n.comment : ts.getTextOfJSDocComment(n.comment) ?? ""))
    .filter(Boolean);
  return parts.join("\n\n").trim();
}

function entrypoints(pkgDir) {
  const pkg = JSON.parse(readFileSync(resolve(root, pkgDir, "package.json"), "utf8"));
  const out = [];
  const exportsField = pkg.exports ?? { ".": pkg.types ?? pkg.main };
  for (const [subpath, value] of Object.entries(exportsField)) {
    const types = typeof value === "string"
      ? value.replace(/\.js$/, ".d.ts")
      : value?.types ?? value?.import?.replace?.(/\.js$/, ".d.ts");
    if (!types) continue;
    const file = resolve(root, pkgDir, types);
    out.push({ subpath, specifier: subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`, file });
  }
  if (pkg.bin) for (const [cmd, path] of Object.entries(pkg.bin)) out.bin = [...(out.bin ?? []), { cmd, path }];
  return { pkg, entries: out };
}

function surfaceFor(files) {
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    allowJs: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const byFile = new Map();
  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) { byFile.set(file, null); continue; }
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    const exports = moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : [];
    const items = [];
    for (const sym of exports) {
      const resolved = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
      const decls = resolved.declarations ?? sym.declarations ?? [];
      const decl = decls.find((d) => !ts.isExportSpecifier(d)) ?? decls[0];
      if (!decl) continue;
      items.push({
        name: sym.getName(),
        kind: kindOf(decl),
        doc: docText(decl),
        text: declText(decl),
        origin: relative(root, decl.getSourceFile().fileName),
      });
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    byFile.set(file, items);
  }
  return byFile;
}

function slug(pkgDir) {
  return pkgDir.replace(/^packages\//, "").replace(/\//g, "-");
}

function header(pkg, title) {
  return [
    `# ${title}`,
    "",
    "> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.",
    `> Do not edit by hand. Version at generation time: \`${pkg.version}\`.`,
    "",
  ];
}

function entryFileName(entry) {
  return entry.subpath === "." ? "index.md" : `${entry.subpath.slice(2).replace(/\//g, "-")}.md`;
}

function renderEntry(pkg, entry, items) {
  const lines = header(pkg, `\`${entry.specifier}\``);
  lines.push(...renderBody([entry], new Map([[entry.file, items]]), false));
  return lines.join("\n");
}

function renderBody(entries, byFile, withHeadings = true) {
  const lines = [];
  for (const e of entries) {
    const items = byFile.get(e.file);
    if (withHeadings) lines.push(`## \`${e.specifier}\``, "");
    lines.push(`Declaration file: \`${relative(root, e.file)}\`.`, "");
    if (!items) {
      lines.push("_Declarations not built. Run `npm run build` and regenerate._", "");
      continue;
    }
    if (items.length === 0) { lines.push("_No exported symbols._", ""); continue; }
    const groups = new Map();
    for (const item of items) {
      if (!groups.has(item.kind)) groups.set(item.kind, []);
      groups.get(item.kind).push(item);
    }
    lines.push("<details><summary>Symbol index</summary>", "");
    for (const kind of KIND_ORDER) {
      const group = groups.get(kind);
      if (!group) continue;
      lines.push(`- **${kind}**: ${group.map((i) => `\`${i.name}\``).join(", ")}`);
    }
    lines.push("", "</details>", "");
    for (const kind of KIND_ORDER) {
      const group = groups.get(kind);
      if (!group) continue;
      lines.push(`${withHeadings ? "###" : "##"} ${KIND_PLURAL[kind]}`, "");
      for (const item of group) {
        lines.push(`${withHeadings ? "####" : "###"} \`${item.name}\``, "");
        if (item.doc) lines.push(item.doc, "");
        lines.push("```ts", item.text, "```", "");
        lines.push(`Declared in \`${item.origin}\`.`, "");
      }
    }
  }
  return lines;
}

function render(pkg, entries, byFile) {
  const lines = header(pkg, `\`${pkg.name}\` API reference`);
  if (pkg.description) lines.push(pkg.description, "");
  lines.push("## Entrypoints", "");
  lines.push("| Import specifier | Declarations | Exported symbols |", "| --- | --- | --- |");
  for (const e of entries) {
    const items = byFile.get(e.file);
    lines.push(`| \`${e.specifier}\` | \`${relative(root, e.file)}\` | ${items ? items.length : "unbuilt"} |`);
  }
  lines.push("");
  lines.push(...renderBody(entries, byFile, true));
  return lines.join("\n");
}

function renderSplit(pkg, entries, byFile, dir) {
  mkdirSync(dir, { recursive: true });
  const lines = header(pkg, `\`${pkg.name}\` API reference`);
  if (pkg.description) lines.push(pkg.description, "");
  lines.push("Each entrypoint has its own page.", "");
  lines.push("| Import specifier | Declarations | Exported symbols | Reference |", "| --- | --- | --- | --- |");
  for (const e of entries) {
    const items = byFile.get(e.file);
    const file = entryFileName(e);
    if (items) writeFileSync(resolve(dir, file), renderEntry(pkg, e, items) + "\n");
    lines.push(
      `| \`${e.specifier}\` | \`${relative(root, e.file)}\` | ${items ? items.length : "unbuilt"} | ${items ? `[${file}](${file})` : "unbuilt"} |`,
    );
  }
  writeFileSync(resolve(dir, "README.md"), lines.join("\n") + "\n");
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const index = [
  "# API reference index",
  "",
  "> Generated by `node scripts/generate-docs-api.mjs`. Do not edit by hand.",
  "",
  "| Package | Version | Reference |",
  "| --- | --- | --- |",
];
for (const pkgDir of PACKAGES) {
  const { pkg, entries } = entrypoints(pkgDir);
  const byFile = surfaceFor(entries.map((e) => e.file));
  let name;
  if (entries.length > 4) {
    name = `${slug(pkgDir)}/README.md`;
    renderSplit(pkg, entries, byFile, resolve(outDir, slug(pkgDir)));
  } else {
    name = `${slug(pkgDir)}.md`;
    writeFileSync(resolve(outDir, name), render(pkg, entries, byFile) + "\n");
  }
  index.push(`| \`${pkg.name}\` | ${pkg.version} | [${name}](${name}) |`);
  const total = entries.reduce((n, e) => n + (byFile.get(e.file)?.length ?? 0), 0);
  console.log(`${pkg.name}: ${entries.length} entrypoint(s), ${total} exported symbols -> ${name}`);
}
writeFileSync(resolve(outDir, "README.md"), index.join("\n") + "\n");

// ---------------------------------------------------------------------------
// Reserved `cave_` identifier index (failure codes, tool names, stop reasons).
// ---------------------------------------------------------------------------
const GROUPS = [
  ["cave_sandbox_", "Sandbox and containment"],
  ["cave_memory_", "Memory"],
  ["cave_connect_", "Caveman Connect"],
  ["cave_durable_", "Durable runs and journal"],
  ["cave_budget_", "Budget and spend"],
  ["cave_run_", "Run lifecycle"],
  ["cave_tool_", "Tools"],
  ["cave_subagent_", "Subagents"],
  ["cave_model_", "Model boundary and routing"],
  ["cave_context_", "Context and Context IR"],
  ["cave_compaction_", "Compaction"],
  ["cave_cache_", "Prompt cache"],
  ["cave_adapter_", "Adapter kit and conformance"],
  ["cave_harness_", "Compiler harness"],
  ["cave_compiler_", "Compiler"],
  ["cave_candidate_", "Compiler candidates"],
  ["cave_profile_", "Workload profile"],
  ["cave_trajectory_", "Trajectory IR"],
  ["cave_agent_", "Agent definition, packages, plugins"],
  ["cave_program_", "Programmatic tools"],
  ["cave_eve_", "Eve adapter"],
  ["cave_vercel_", "Vercel AI SDK adapter"],
  ["cave_mastra_", "Mastra adapter"],
  ["cave_openai_agents_", "OpenAI Agents adapter"],
  ["cave_strands_", "Strands adapter"],
  ["cave_langgraph_", "LangGraph adapter"],
  ["cave_claude_", "Claude Agent SDK adapter"],
  ["cave_pi_", "Pi adapter"],
];

function identifierIndex() {
  const sh = (script) =>
    execFileSync("bash", ["-lc", script], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const ids = sh("grep -rhoE '\\bcave_[a-z0-9_]+' packages/*/src packages/adapters/*/src 2>/dev/null | sort -u")
    .split("\n").map((line) => line.trim()).filter(Boolean);
  // One pass over the tree instead of one grep per identifier.
  const hits = sh("grep -rnoE '\\bcave_[a-z0-9_]+' packages/*/src packages/adapters/*/src 2>/dev/null");
  const where = new Map();
  for (const line of hits.split("\n")) {
    const match = /^(.*?):\d+:\d*:?(cave_[a-z0-9_]+)$/.exec(line) ?? /^(.*?):\d+:(cave_[a-z0-9_]+)$/.exec(line);
    if (!match) continue;
    if (!where.has(match[2])) where.set(match[2], match[1]);
  }
  const used = new Set();
  const lines = [
    "# Reserved `cave_` identifiers",
    "",
    "> Generated by `node scripts/generate-docs-api.mjs`. Do not edit by hand.",
    "",
    "Every identifier the runtime, adapters, and tooling can emit under the reserved",
    "`cave_` namespace: failure codes, stop reasons, framework-owned tool names, and",
    "refusal reasons. The namespace is reserved; user tools may not declare names in it.",
    "",
    `Total: **${ids.length}** identifiers.`,
    "",
  ];
  const table = (group) => {
    lines.push("| Identifier | Declared in |", "| --- | --- |");
    for (const id of group) lines.push(`| \`${id}\` | ${where.get(id) ? `\`${where.get(id)}\`` : "—"} |`);
    lines.push("");
  };
  for (const [prefix, title] of GROUPS) {
    const group = ids.filter((id) => id.startsWith(prefix) && !used.has(id));
    if (group.length === 0) continue;
    for (const id of group) used.add(id);
    lines.push(`## ${title}`, "");
    table(group);
  }
  const rest = ids.filter((id) => !used.has(id));
  if (rest.length > 0) {
    lines.push("## Other", "");
    table(rest);
  }
  return lines.join("\n") + "\n";
}

writeFileSync(resolve(root, "caveman-docs/reference/identifiers.md"), identifierIndex());
console.log("reserved cave_ identifiers -> caveman-docs/reference/identifiers.md");
