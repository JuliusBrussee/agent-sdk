import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ADAPTER_CONFORMANCE_SUITE,
  createAdapterRegistry,
  defineAdapterManifest,
  defineAdapterPackage,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const adaptersRoot = resolve(here, "../../adapters");

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "fixture",
    packageName: "@caveman-ai/adapter-fixture",
    adapterVersion: "0.1.0",
    upstream: { package: "fixture", version: "1.0.0" },
    capabilities: {
      run: "experimental",
      stream: "unsupported",
      tools: "unsupported",
      usage: "experimental",
      abort: "unsupported",
      durable: "unsupported",
      compile: "unsupported",
    },
    certifications: {},
    ...overrides,
  };
}

test("manifest validation snapshots and freezes caller data", () => {
  const source = manifest();
  const defined = defineAdapterManifest(source);
  source.capabilities.run = "certified";
  assert.equal(defined.capabilities.run, "experimental");
  assert.equal(Object.isFrozen(defined.capabilities), true);
});

test("certified capability requires conformance report digest", () => {
  assert.throws(
    () => defineAdapterManifest(manifest({
      capabilities: { ...manifest().capabilities, run: "certified" },
    })),
    /cave_adapter_certification_invalid:run/,
  );

  const defined = defineAdapterManifest(manifest({
    capabilities: { ...manifest().capabilities, run: "certified" },
    certifications: {
      run: { suite: ADAPTER_CONFORMANCE_SUITE, reportSHA256: "a".repeat(64) },
    },
  }));
  assert.equal(defined.capabilities.run, "certified");
});

test("registry exposes metadata but authorizes only certified capabilities", () => {
  const registry = createAdapterRegistry();
  const adapter = defineAdapterPackage({ manifest: manifest(), createAdapter: () => ({}) });
  registry.register(adapter);
  assert.equal(registry.get("fixture")?.manifest.id, "fixture");
  assert.throws(
    () => registry.require("fixture", "run"),
    /cave_adapter_capability_not_certified:fixture:run:experimental/,
  );
  assert.throws(() => registry.register(adapter), /cave_adapter_duplicate:fixture/);
});

test("every adapter package has a valid manifest aligned with package pins", async () => {
  const directories = (await readdir(adaptersRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(directories, ["claude-agent-sdk", "eve", "mastra", "pi", "vercel-ai-sdk"]);

  const ids = new Set();
  for (const directory of directories) {
    const packageRoot = resolve(adaptersRoot, directory);
    const packageJSON = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
    const module = await import(pathToFileURL(resolve(packageRoot, "src/manifest.js")));
    const defined = defineAdapterManifest(module.adapterManifest);
    assert.equal(Object.isFrozen(module.adapterManifest.capabilities), true);
    assert.equal(defined.packageName, packageJSON.name);
    assert.equal(defined.adapterVersion, packageJSON.version);
    assert.equal(packageJSON.peerDependencies[defined.upstream.package], defined.upstream.version);
    assert.equal(ids.has(defined.id), false, `duplicate adapter id ${defined.id}`);
    ids.add(defined.id);
  }
});
