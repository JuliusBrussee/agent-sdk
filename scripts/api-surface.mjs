#!/usr/bin/env node
// Golden file for the published type surface of @caveman-ai/agent.
//
// The package re-exports whole modules (`export * from ...`), so an internal
// type becomes public API the moment someone adds it. That is fine as long as
// it is a decision: this check turns every added, removed, or renamed export
// into a reviewed diff of api-surface.txt instead of a silent breaking change.
//
//   node scripts/api-surface.mjs            # check (CI)
//   node scripts/api-surface.mjs --update   # re-baseline, then review the diff
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = resolve(root, "packages/agent");
const goldenPath = resolve(pkgDir, "api-surface.txt");

const exportsMap = JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf8")).exports;
const entries = Object.entries(exportsMap)
  .map(([subpath, target]) => [subpath, resolve(pkgDir, target.types)])
  .sort(([a], [b]) => a.localeCompare(b));

const missing = entries.filter(([, file]) => !existsSync(file));
if (missing.length > 0) {
  process.stderr.write("api-surface: run `npm run build:agent` first\n");
  process.exit(1);
}

const program = ts.createProgram(entries.map(([, file]) => file), {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  skipLibCheck: true,
});
const checker = program.getTypeChecker();

const lines = [];
for (const [subpath, file] of entries) {
  const symbol = checker.getSymbolAtLocation(program.getSourceFile(file));
  const names = symbol === undefined
    ? []
    : checker.getExportsOfModule(symbol).map((exported) => exported.getName()).sort();
  for (const name of names) lines.push(`${subpath}\t${name}`);
}
const surface = `${lines.join("\n")}\n`;

if (process.argv.includes("--update")) {
  writeFileSync(goldenPath, surface);
  process.stdout.write(`api-surface: recorded ${lines.length} exports across ${entries.length} entrypoints\n`);
  process.exit(0);
}
const golden = existsSync(goldenPath) ? readFileSync(goldenPath, "utf8") : "";
if (golden !== surface) {
  const before = new Set(golden.split("\n").filter(Boolean));
  const after = new Set(lines);
  for (const line of after) if (!before.has(line)) process.stderr.write(`api-surface: + ${line}\n`);
  for (const line of before) if (!after.has(line)) process.stderr.write(`api-surface: - ${line}\n`);
  process.stderr.write("api-surface: public surface changed; run `npm run api:update` and justify it in review\n");
  process.exit(1);
}
process.stdout.write(`api-surface: ok (${lines.length} exports, ${entries.length} entrypoints)\n`);
