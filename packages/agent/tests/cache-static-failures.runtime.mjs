import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  findVolatileFrozenSegment,
  frozenPrefixTokens,
  providerPrefixMinimum,
  renderBelowMinimumAdvisory,
  renderStaticPlanFailure,
  withPerturbedClock,
} from "../dist/cache-planner/static-checks.js";
import { lowerContext } from "../dist/context-ir.js";
import { loadAgentDir } from "../dist/dir-loader.js";

// F2 failure voice: the goldens are the spec (goldens/README.md). Each pinned
// diagnostic fixture must render byte-exact to its golden — no normalizer.
// Fields the live pipeline cannot know (the agent.ts line number, the exact
// value-function text) are pinned here by the fixture; the live checks fill
// what they actually know.

const CASES = [
  {
    golden: "volatile-prefix",
    diagnostic: {
      code: "cave_frozen_prefix_volatile_segment",
      location: "agent.ts:8",
      segmentId: "today",
      stability: "build",
      sourcePreview: "() => `Today is ${new Date().toDateString()}`",
      fixToolPath: "tools/get_date.ts",
    },
  },
  {
    golden: "prefix-shrink",
    diagnostic: {
      code: "cave_prefix_shrink_regression",
      lockedTokens: 11940,
      currentTokens: 8610,
    },
  },
  {
    golden: "prefix-below-minimum",
    diagnostic: {
      code: "cave_frozen_prefix_below_provider_minimum",
      prefixTokens: 612,
      minimumTokens: 1024,
      model: "claude-sonnet-5",
    },
  },
];

async function golden(name) {
  return readFile(new URL(`../goldens/failures/${name}.txt`, import.meta.url), "utf8");
}

for (const { golden: name, diagnostic } of CASES) {
  test(`renderStaticPlanFailure reproduces ${name} golden byte-exact`, async () => {
    assert.equal(renderStaticPlanFailure(diagnostic), await golden(name));
  });
}

test("wire codes appear only under --verbose", async () => {
  for (const { diagnostic } of CASES) {
    const plain = renderStaticPlanFailure(diagnostic);
    assert.equal(plain.includes(diagnostic.code), false, "default output must carry no wire code");
    const verbose = renderStaticPlanFailure(diagnostic, { verbose: true });
    assert.ok(verbose.startsWith(plain));
    assert.ok(verbose.includes(diagnostic.code));
  }
});

test("goldens contain no wire codes", async () => {
  for (const { golden: name, diagnostic } of CASES) {
    assert.equal((await golden(name)).includes(diagnostic.code), false);
  }
});

test("provider minimum comes from the catalog cache profiles, with cache mode", () => {
  const sonnet = providerPrefixMinimum("anthropic/claude-sonnet-5");
  assert.deepEqual(sonnet, { minimumTokens: 1024, model: "claude-sonnet-5", mode: "explicit" });
  // Affinity/implicit models are advisory-only below the minimum
  // (goldens/README.md severity scoping) — the mode is what scopes it.
  assert.equal(providerPrefixMinimum("openai/gpt-5.4-mini")?.mode, "affinity");
  assert.equal(providerPrefixMinimum("google/gemini-2.5-flash")?.mode, "implicit");
  // Unknown models honestly resolve no minimum — the check cannot fire.
  assert.equal(providerPrefixMinimum("acme/imaginary-model"), undefined);
  assert.equal(providerPrefixMinimum("no-slash-model"), undefined);
});

test("the below-minimum advisory reads cold, loudly, without failing", () => {
  assert.equal(
    renderBelowMinimumAdvisory({ prefixTokens: 612, minimumTokens: 2048, model: "gpt-5.4-mini" }),
    "prefix ≈612 tokens is below gpt-5.4-mini's automatic-cache minimum (2,048) " +
      "— runs will read cold; receipts will show 0 warm\n",
  );
});

// The #224 fixture: an ACTUALLY-volatile context value function (the existing
// digest round-trip test uses a constant). Two independent composition passes
// of the same directory must disagree on the frozen prefix, and the check must
// name the offending segment; a stable directory must pass.
test("two composition passes catch an actually-volatile agent.ts context fn", async (t) => {
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "cave-volatile-dir-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "volatile-agent"));
  const dir = join(root, "volatile-agent");
  await writeFile(join(dir, "instructions.md"), "You are a test agent.\n");
  await writeFile(join(dir, "agent.ts"), [
    "export default {",
    '  model: "anthropic/claude-haiku-4-5",',
    "  context: {",
    "    today: () => `stamp ${Math.random()}`,",
    '    policy: "returns accepted within 30 days",',
    "  },",
    "};",
    "",
  ].join("\n"));

  const lower = async () => {
    const definition = await loadAgentDir(dir);
    return lowerContext({
      rootDir: dir,
      instructions: definition.instructions,
      tools: definition.tools,
      contexts: definition.contexts,
    });
  };
  const first = await lower();
  const second = await lower();
  const volatile = findVolatileFrozenSegment(first.ir, second.ir);
  assert.deepEqual(volatile, { id: "today", stability: "build" });
  assert.ok(frozenPrefixTokens(first.ir) > 0);

  // Same directory with the volatile entry moved to the live zone: frozen
  // prefixes agree between passes.
  await writeFile(join(dir, "agent.ts"), [
    "export default {",
    '  model: "anthropic/claude-haiku-4-5",',
    "  context: {",
    '    today: { value: () => `stamp ${Math.random()}`, stability: "turn" },',
    '    policy: "returns accepted within 30 days",',
    "  },",
    "};",
    "",
  ].join("\n"));
  const third = await lower();
  const fourth = await lower();
  assert.equal(findVolatileFrozenSegment(third.ir, fourth.ir), undefined);
});

// B2: the README's exact documented sabotage — a day-stable value. Two plain
// passes on the same day agree, so the second pass runs under a +26h clock
// (the build pipeline does the same); a genuinely stable fn still passes.
test("perturbed-clock second pass catches toDateString, the documented sabotage", async (t) => {
  const { mkdtemp, rm, writeFile, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "cave-daystable-dir-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "daystable-agent");
  await mkdir(dir);
  await writeFile(join(dir, "instructions.md"), "You are a test agent.\n");
  await writeFile(join(dir, "agent.ts"), [
    "export default {",
    '  model: "anthropic/claude-haiku-4-5",',
    "  context: {",
    "    today: () => `Today is ${new Date().toDateString()}`,",
    '    policy: "returns accepted within 30 days",',
    "  },",
    "};",
    "",
  ].join("\n"));

  const lower = async () => {
    const definition = await loadAgentDir(dir);
    return lowerContext({
      rootDir: dir,
      instructions: definition.instructions,
      tools: definition.tools,
      contexts: definition.contexts,
    });
  };
  const first = await lower();
  const samePlain = await lower();
  // Two plain passes on the same day agree — this is why the clock perturbs.
  assert.equal(findVolatileFrozenSegment(first.ir, samePlain.ir), undefined);
  const perturbed = await withPerturbedClock(() => lower());
  assert.deepEqual(
    findVolatileFrozenSegment(first.ir, perturbed.ir),
    { id: "today", stability: "build" },
  );

  // A genuinely stable fn passes even against a perturbed second pass.
  await writeFile(join(dir, "agent.ts"), [
    "export default {",
    '  model: "anthropic/claude-haiku-4-5",',
    "  context: {",
    '    policy: () => "returns accepted within 30 days",',
    "  },",
    "};",
    "",
  ].join("\n"));
  const stableFirst = await lower();
  const stablePerturbed = await withPerturbedClock(() => lower());
  assert.equal(findVolatileFrozenSegment(stableFirst.ir, stablePerturbed.ir), undefined);

  // A skills index is build-stable BY CONSTRUCTION (file bytes), so the
  // perturbed-clock second pass agrees on it with no special-case exemption.
  await mkdir(join(dir, "skills"));
  await writeFile(join(dir, "skills", "refunds.md"), [
    "---",
    "name: refunds",
    "description: Refund windows and eligibility rules.",
    "---",
    "",
    "Body loaded on demand.",
    "",
  ].join("\n"));
  const skillsFirst = await lower();
  const skillsPerturbed = await withPerturbedClock(() => lower());
  assert.equal(findVolatileFrozenSegment(skillsFirst.ir, skillsPerturbed.ir), undefined);
  assert.equal(
    skillsFirst.ir.segments.some((segment) =>
      segment.kind === "skill" && segment.cacheRegion === "frozen_prefix"),
    true,
  );
});
