/**
 * The two defaults a bare `agent()` + `run()` depends on, kept out of
 * `runtime.ts` because they are policy about what an undeclared definition
 * means, not execution semantics.
 *
 * Both announce once per process on stderr. Neither ever silently upgrades a
 * guarantee: an explicit `sandbox: "required"` still fails closed without an
 * `entryPath`, and zero provider credentials still throws.
 */

import type { AgentDefinition } from "./definition.js";

let hostExecutionAnnounced = false;

/**
 * A definition that never declared a sandbox posture, run without an
 * `entryPath`, executes on the host — and says so, once, on stderr.
 *
 * Only the root definition is downgraded. A subagent that declared
 * `sandbox: "required"` (or one that never declared it but carries its own
 * tools) still needs an `entryPath` and still fails closed with
 * `cave_tool_sandbox_entry_required`: containment is never relaxed for a
 * definition whose author asked for it.
 */
export function hostByDefault(
  definition: AgentDefinition,
  entryPath: string | undefined,
): AgentDefinition {
  if (entryPath !== undefined) return definition;
  if (definition.sandboxDeclared || definition.sandbox !== "required") return definition;
  if (!hostExecutionAnnounced) {
    hostExecutionAnnounced = true;
    process.stderr.write("cave: host execution — tools are not isolated\n");
  }
  return Object.freeze({ ...definition, sandbox: "host" as const });
}

/** Fixed precedence for `auto()`: the first credential present wins. */
const AUTO_MODELS: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  ["anthropic", "claude-haiku-4-5", ["ANTHROPIC_API_KEY"]],
  ["openai", "gpt-5.4-mini", ["OPENAI_API_KEY"]],
  ["google", "gemini-2.5-flash", ["GEMINI_API_KEY", "GOOGLE_API_KEY"]],
];

let autoAmbiguityAnnounced = false;

/**
 * Baseline provider/model for `auto()` from the credentials in this shell.
 *
 * Several credentials is an ambiguity, not an error: the fixed order picks
 * one and stderr names `CAVE_MODEL` as the way to pick another. Zero
 * credentials is genuinely unknown state and still throws.
 */
export function autoCredentialModel(): readonly [string, string] {
  const configured = AUTO_MODELS.filter(([, , names]) => names.some((name) => process.env[name]));
  const chosen = configured[0];
  if (chosen === undefined) {
    throw new Error("caveman agent: no supported provider credential found");
  }
  if (configured.length > 1 && !autoAmbiguityAnnounced) {
    autoAmbiguityAnnounced = true;
    process.stderr.write(
      `cave: multiple provider credentials found — using ${chosen[0]}/${chosen[1]}; ` +
      "set CAVE_MODEL to choose another\n",
    );
  }
  return [chosen[0], chosen[1]];
}
