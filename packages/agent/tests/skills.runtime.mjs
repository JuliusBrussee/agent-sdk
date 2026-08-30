// The Phase-3 dissolving fixture (issue #219): skills are descriptions in the
// frozen prefix, bodies on demand through the framework cave_skill tool. The
// prefix-hash problem is dissolved BY CONSTRUCTION — a skill body arrives as
// an ordinary tool result in the live zone — and this file verifies that with
// a fixture, not a mechanism: it hashes exactly what the provider is handed
// (system prompt + tool schemas) before and after a cave_skill load.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentDir, run, sha256, stableStringify } from "../dist/index.js";
import {
  fauxAssistantMessage as upstreamFauxAssistantMessage,
  fauxProvider as upstreamFauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const BODY_MARKER = "FULL-REFUND-PLAYBOOK-BODY";

// Same faux shims as framework.runtime.mjs: report reasoning usage as 0 so
// provider-usage validation sees a complete split.
function fauxProvider(options = {}) {
  const handle = upstreamFauxProvider(options);
  const streamSimple = handle.provider.streamSimple.bind(handle.provider);
  return {
    ...handle,
    provider: {
      ...handle.provider,
      streamSimple: (...args) => withReportedReasoning(streamSimple(...args)),
    },
  };
}

function withReportedReasoning(source) {
  const output = createAssistantMessageEventStream();
  queueMicrotask(async () => {
    for await (const event of source) {
      const partial = event.partial === undefined
        ? {}
        : { partial: reportZeroReasoning(event.partial) };
      if (event.type === "done") {
        output.push({ ...event, ...partial, message: reportZeroReasoning(event.message) });
      } else if (event.type === "error") {
        output.push({ ...event, ...partial, error: reportZeroReasoning(event.error) });
      } else {
        output.push({ ...event, ...partial });
      }
    }
  });
  return output;
}

function reportZeroReasoning(message) {
  return { ...message, usage: { ...message.usage, reasoning: 0 } };
}

function fauxAssistantMessage(...args) {
  const message = upstreamFauxAssistantMessage(...args);
  return {
    ...message,
    usage: { ...message.usage, reasoning: message.usage.reasoning ?? 0 },
  };
}

// A minimal skills-bearing convention directory, with the package symlinked
// into node_modules so the generated entry's static imports resolve when the
// run stages its sandbox source graph.
async function skillsDir({ withSkills = true } = {}) {
  const base = await mkdtemp(join(tmpdir(), "cave-skills-run-"));
  const root = join(base, "skills-bot");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "instructions.md"), "You are a refund helper.\n");
  await writeFile(
    join(root, "agent.ts"),
    'export default { model: "anthropic/claude-haiku-4-5" };\n',
  );
  if (withSkills) {
    await mkdir(join(root, "skills"));
    await writeFile(join(root, "skills", "refund.md"), [
      "---",
      "name: refund",
      "description: Refund windows and eligibility rules.",
      "---",
      "",
      `${BODY_MARKER}: full refund within 30 days, store credit to 90.`,
      "",
    ].join("\n"));
    await writeFile(join(root, "skills", "shipping.md"), [
      "---",
      "name: shipping",
      "description: Late and lost shipment handling.",
      "---",
      "",
      "Carrier claim windows and replacement rules.",
      "",
    ].join("\n"));
  }
  await mkdir(join(root, "node_modules", "@caveman-ai"), { recursive: true });
  await symlink(
    packageRoot,
    join(root, "node_modules", "@caveman-ai", "agent"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return { base, root };
}

function capturingStreamFn(faux, captured) {
  return (selected, context, options) => {
    captured.push({
      system: context.systemPrompt,
      // Exactly what the provider is handed as the static request prefix.
      prefixHash: sha256(stableStringify({
        system: context.systemPrompt,
        tools: context.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      })),
      toolNames: context.tools.map((tool) => tool.name),
      messages: JSON.stringify(context.messages),
    });
    return faux.provider.streamSimple(selected, context, options);
  };
}

test("dissolving fixture: loading a skill body never moves the frozen prefix", async () => {
  const { base, root } = await skillsDir();
  try {
    const definition = await loadAgentDir(root);
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("cave_skill", { name: "refund" }, { id: "skill-1" })),
      fauxAssistantMessage("answered from the loaded skill"),
    ]);
    const captured = [];
    const result = await run(definition, "Can I return worn boots?", {
      ensureRuntime: false,
      model: faux.getModel(),
      printReceipt: false,
      streamFn: capturingStreamFn(faux, captured),
    });
    assert.equal(result.text, "answered from the loaded skill");
    assert.equal(captured.length, 2);

    // The prefix the model sees: descriptions, sorted, plus the cave_skill
    // tool — and never a body.
    assert.match(captured[0].system, /- refund: Refund windows and eligibility rules\./);
    assert.match(captured[0].system, /- shipping: Late and lost shipment handling\./);
    assert.equal(captured[0].system.includes(BODY_MARKER), false);
    assert.equal(captured[0].toolNames.includes("cave_skill"), true);

    // The fixture itself: prefix hash before the body load == after. The body
    // arrived as an ordinary tool result in the live zone.
    assert.equal(captured[0].prefixHash, captured[1].prefixHash);
    assert.equal(captured[1].system.includes(BODY_MARKER), false);
    assert.equal(captured[0].messages.includes(BODY_MARKER), false);
    assert.equal(captured[1].messages.includes(BODY_MARKER), true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("cave_skill answers an unknown name with honest absence, not a throw", async () => {
  const { base, root } = await skillsDir();
  try {
    const definition = await loadAgentDir(root);
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("cave_skill", { name: "nope" }, { id: "skill-miss" })),
      fauxAssistantMessage("recovered"),
    ]);
    const captured = [];
    const result = await run(definition, "load something that is not there", {
      ensureRuntime: false,
      model: faux.getModel(),
      printReceipt: false,
      streamFn: capturingStreamFn(faux, captured),
    });
    assert.equal(result.text, "recovered");
    // The not-found result names the miss and lists what exists.
    assert.match(captured[1].messages, /Unknown skill \\"nope\\"/);
    assert.match(captured[1].messages, /refund, shipping/);
    // And the prefix still never moved.
    assert.equal(captured[0].prefixHash, captured[1].prefixHash);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a skill-less directory agent gets no skills segment and no cave_skill tool", async () => {
  const { base, root } = await skillsDir({ withSkills: false });
  try {
    const definition = await loadAgentDir(root);
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("plain answer")]);
    const captured = [];
    const result = await run(definition, "hello", {
      ensureRuntime: false,
      model: faux.getModel(),
      printReceipt: false,
      streamFn: capturingStreamFn(faux, captured),
    });
    assert.equal(result.text, "plain answer");
    assert.equal(captured[0].toolNames.includes("cave_skill"), false);
    assert.equal(captured[0].system.includes("cave_skill"), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
