import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AGENT_DIR_ENTRY } from "../dist/index.js";
import {
  conventionEntryPath,
  generateAgentDirEntry,
  hasAgentDirConvention,
} from "../dist/dir-loader.js";
import { projectSourceFiles, sourceGraphSHA256 } from "../dist/source-graph.js";
import { writeRunReceipt } from "../dist/receipt-print.js";

const fixtureSource = fileURLToPath(new URL("./fixtures/agent-dir", import.meta.url));

test("conventionEntryPath maps convention directories and passes files through", async () => {
  const base = await mkdtemp(join(tmpdir(), "cave-entry-"));
  try {
    const dir = join(base, "agent-dir");
    await cp(fixtureSource, dir, { recursive: true });
    // defineBuild({ entry: "." }) / bare dev resolution: a directory carrying
    // instructions.md means the convention, whose module entry is generated.
    assert.equal(await hasAgentDirConvention(dir), true);
    assert.equal(await conventionEntryPath(dir), resolve(dir, AGENT_DIR_ENTRY));
    // A file entry (`caveman-agent dev src/agent.ts`) passes through.
    const file = join(dir, "agent.ts");
    assert.equal(await conventionEntryPath(file), file);
    // A directory without instructions.md is not the convention.
    const plain = join(base, "plain");
    await mkdir(plain);
    assert.equal(await hasAgentDirConvention(plain), false);
    assert.equal(await conventionEntryPath(plain), plain);
    // A missing entry passes through for the importer's own clear error.
    const missing = join(base, "missing.ts");
    assert.equal(await conventionEntryPath(missing), missing);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("generateAgentDirEntry is a pure scan — user modules are never imported", async () => {
  const base = await mkdtemp(join(tmpdir(), "cave-entry-"));
  try {
    const dir = join(base, "scan-only");
    await cp(fixtureSource, dir, { recursive: true });
    // A tool module that throws on import proves the dev watch path never
    // evaluates user code: only the staged/sandbox world imports it.
    await writeFile(
      join(dir, "tools", "echo_word.ts"),
      "throw new Error(\"tool module was imported on the watch path\");\n",
    );
    await generateAgentDirEntry(dir);
    const entry = await readFile(join(dir, AGENT_DIR_ENTRY), "utf8");
    assert.match(entry, /import tool_0_0 from "\.\.\/tools\/echo_word\.ts"/);
    assert.match(entry, /id: "scan-only"/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("markdown joins the watched project inputs and moves the source hash", async () => {
  const base = await mkdtemp(join(tmpdir(), "cave-md-"));
  try {
    const root = join(base, "project");
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "skills"), { recursive: true });
    await mkdir(join(root, "node_modules", "dep"), { recursive: true });
    await writeFile(join(root, "src", "agent.ts"), "export default 1;\n");
    await writeFile(join(root, "instructions.md"), "Be brief.\n");
    await writeFile(join(root, "skills", "notes.md"), "# notes\n");
    await writeFile(join(root, "node_modules", "dep", "README.md"), "# dep\n");
    const files = await projectSourceFiles(root);
    assert.equal(files.includes(join(root, "instructions.md")), true);
    assert.equal(files.includes(join(root, "skills", "notes.md")), true);
    assert.equal(files.includes(join(root, "src", "agent.ts")), true);
    assert.equal(files.some((path) => path.includes("node_modules")), false);
    // An md edit lands in the sourceGraphSHA256 input set, so it invalidates
    // the lock exactly like a source change.
    const before = await sourceGraphSHA256(root, files);
    await writeFile(join(root, "instructions.md"), "Be brief. And kind.\n");
    const after = await sourceGraphSHA256(root, await projectSourceFiles(root));
    assert.notEqual(before, after);
    // A skill edit moves it too (Phase 3: the description is frozen-prefix
    // content, so the build/dev snapshot must invalidate on it) — and an
    // unchanged tree stays stable, so the volatile-prefix two-pass check
    // cannot false-positive on file-byte-derived skill content.
    await writeFile(join(root, "skills", "notes.md"), "# notes, reworded\n");
    const afterSkillEdit = await sourceGraphSHA256(root, await projectSourceFiles(root));
    assert.notEqual(after, afterSkillEdit);
    assert.equal(
      await sourceGraphSHA256(root, await projectSourceFiles(root)),
      afterSkillEdit,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("writeRunReceipt shapes the path, writes the wire receipt, and never overwrites", async () => {
  const base = await mkdtemp(join(tmpdir(), "cave-receipt-"));
  try {
    const receipt = {
      schema: "caveman.agent.run-receipt.v1",
      stopReason: "complete",
      denomination: "none",
      totalEstimatedUsd: 0,
      unpriced: false,
      calls: [],
      subagents: [],
    };
    const first = await writeRunReceipt(base, receipt, {
      mode: "observe-only",
      durationMs: 300,
    });
    assert.match(
      first.receiptPath,
      /^\.caveman\/runs\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d+)?\/receipt\.json$/,
    );
    assert.deepEqual(
      JSON.parse(await readFile(resolve(base, first.receiptPath), "utf8")),
      receipt,
      "the written file is the unmodified wire receipt",
    );
    assert.equal(first.rendered.includes(first.receiptPath), true);
    // A second run in the same second gets its own directory.
    const second = await writeRunReceipt(base, receipt, {
      mode: "observe-only",
      durationMs: 300,
    });
    assert.notEqual(second.receiptPath, first.receiptPath);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
