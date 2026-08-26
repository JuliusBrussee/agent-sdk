import { existsSync } from "node:fs";
import * as nodeModule from "node:module";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

type NativeFindPackageJSON = (
  specifier: string | URL,
  base?: string | URL,
) => string | undefined;

const nativeFindPackageJSON = (nodeModule as {
  findPackageJSON?: NativeFindPackageJSON;
}).findPackageJSON;

function packageName(specifier: string): string | undefined {
  if (specifier === "" || specifier.startsWith(".") || specifier.startsWith("/") ||
      specifier.includes("\0")) return undefined;
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  return name === undefined || name === "" || name.includes("..") ? undefined : name;
}

/** Node 22 native resolver with Bun-compatible node_modules ascent fallback. */
export function findPackageJSONCompat(
  specifier: string,
  base: string | URL,
): string | undefined {
  if (nativeFindPackageJSON !== undefined) {
    return nativeFindPackageJSON(specifier, base);
  }
  const name = packageName(specifier);
  if (name === undefined) return undefined;
  const basePath = base instanceof URL ? fileURLToPath(base) : base;
  let directory = dirname(basePath);
  const root = parse(directory).root;
  for (;;) {
    const candidate = join(directory, "node_modules", name, "package.json");
    if (existsSync(candidate)) return candidate;
    if (directory === root) return undefined;
    directory = dirname(directory);
  }
}
