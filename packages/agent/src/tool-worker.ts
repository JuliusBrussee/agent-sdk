import { writeSync } from "node:fs";
import { createHmac } from "node:crypto";
import { stdin } from "node:process";
import {
  agentDefinitionSHA256,
  toolDefinitionSHA256,
} from "./build.js";
import { validateAgentGraph } from "./definition-graph.js";
import type { AgentDefinition } from "./index.js";
import type { ToolExecutionContext } from "./primitives.js";
import { installNetworkDeny } from "./sandbox-network.js";
import { executeRawTool, settleToolOutput } from "./tool-internal.js";

// The result travels on a DEDICATED fd 3, length-prefixed — never stdout
// Any console.log in the tool's own import graph writes to stdout
// (fd 1) and the parent ignores it, so it can no longer collide with the result
// JSON and corrupt it into cave_sandbox_invalid_output.
let resultWritten = false;
const INTRINSIC_JSON_STRINGIFY = JSON.stringify;
const RESULT_WRITE_SYNC = writeSync;
const ENCODE_UTF8 = TextEncoder.prototype.encode.bind(new TextEncoder());
let authenticateResult: ((body: string) => Uint8Array) | undefined;

function installResultAuthentication(key: string): void {
  const hmac = createHmac("sha256", key);
  const update = hmac.update.bind(hmac);
  const digest = hmac.digest.bind(hmac);
  authenticateResult = (body: string) => {
    update(body, "utf8");
    return digest();
  };
}

function writeResult(payload: {
  ok: boolean;
  value?: unknown;
  text?: string;
  settled?: true;
  code?: string;
}): void {
  if (resultWritten) return;
  let encoded: string;
  try {
    encoded = Reflect.apply(INTRINSIC_JSON_STRINGIFY, JSON, [payload]);
  } catch {
    if (payload.ok) {
      writeResult({ ok: false, code: "cave_sandbox_result_not_serializable" });
      return;
    }
    throw new Error("cave_sandbox_failure_not_serializable");
  }
  // Mark terminal only after serialization succeeds. Otherwise a BigInt or
  // circular tool value suppresses the failure frame and becomes an opaque
  // cave_sandbox_invalid_output at the parent.
  resultWritten = true;
  if (authenticateResult === undefined) {
    throw new Error("cave_sandbox_result_authentication_missing");
  }
  const body = ENCODE_UTF8(encoded);
  const tag = authenticateResult(encoded);
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, body.byteLength, false);
  for (const bytes of [header, tag, body]) {
    let offset = 0;
    while (offset < bytes.byteLength) {
      offset += RESULT_WRITE_SYNC(3, bytes, offset, bytes.byteLength - offset);
    }
  }
}

function failureCode(error: unknown): string {
  if (error instanceof Error && error.message.startsWith("cave_tool_result_not_json_safe:")) {
    return "cave_sandbox_result_not_serializable";
  }
  return error instanceof Error
    ? [
      error.message.split("\n", 1)[0],
      "resource" in error && typeof error.resource === "string" ? error.resource : "",
    ].filter(Boolean).join(":")
    : "cave_sandbox_failed";
}

// A floating rejection or throw AFTER the result was already written must not
// turn a successful tool into a failure; before it, it becomes an honest
// failure result rather than a silent nonzero exit the parent can only read as
// a redacted stderr blob.
process.on("uncaughtException", (error) => {
  if (resultWritten) return;
  writeResult({ ok: false, code: `cave_sandbox_uncaught:${failureCode(error)}` });
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  if (resultWritten) return;
  writeResult({ ok: false, code: `cave_sandbox_unhandled_rejection:${failureCode(reason)}` });
  process.exit(1);
});

async function readRequest(): Promise<{
  entry: string;
  agentPath: string[];
  rootDefinitionSha256: string;
  toolDefinitionSha256: string;
  tool: string;
  params: unknown;
  invocation: {
    toolCallId: string;
    durable?: {
      idempotencyKey: string;
      resumed: boolean;
    };
  };
  allowSideEffects: boolean;
  allowNetwork: boolean;
  resultAuthenticationKey: string;
}> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 1_048_576) throw new Error("cave_sandbox_input_limit");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

try {
  const request = await readRequest();
  if (typeof request.resultAuthenticationKey !== "string" ||
      !/^[a-f0-9]{64}$/.test(request.resultAuthenticationKey)) {
    throw new Error("cave_sandbox_result_authentication_invalid");
  }
  installResultAuthentication(request.resultAuthenticationKey);
  if (typeof request.entry !== "string" || !Array.isArray(request.agentPath) ||
      request.agentPath.length > 8 ||
      request.agentPath.some((item) => typeof item !== "string" ||
        !/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(item)) ||
      typeof request.rootDefinitionSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(request.rootDefinitionSha256) ||
      typeof request.toolDefinitionSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(request.toolDefinitionSha256) ||
      typeof request.tool !== "string" ||
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(request.tool) ||
      !validInvocation(request.invocation) ||
      typeof request.allowSideEffects !== "boolean" ||
      typeof request.allowNetwork !== "boolean") {
    throw new Error("cave_sandbox_request_invalid");
  }
  if (request.allowNetwork !== true) installNetworkDeny();
  const imported = await import(request.entry) as { default?: AgentDefinition; agent?: AgentDefinition };
  let definition = imported.default ?? imported.agent;
  if (!definition || definition.kind !== "agent") throw new Error("cave_sandbox_agent_export_missing");
  validateAgentGraph(definition);
  if (agentDefinitionSHA256(definition) !== request.rootDefinitionSha256) {
    throw new Error("cave_sandbox_definition_mismatch");
  }
  const visited = new Set<AgentDefinition>([definition]);
  for (const name of request.agentPath) {
    const delegated = definition.tools.filter((item) =>
      item.name === name && item.runtime?.kind === "subagent"
    );
    if (delegated.length !== 1) throw new Error("cave_sandbox_unknown_subagent");
    const delegatedRuntime = delegated[0]!.runtime;
    if (delegatedRuntime?.kind !== "subagent") throw new Error("cave_sandbox_unknown_subagent");
    const child = delegatedRuntime.definition as AgentDefinition;
    if (!child || child.kind !== "agent") {
      throw new Error("cave_sandbox_subagent_definition_invalid");
    }
    if (visited.has(child)) throw new Error("cave_sandbox_subagent_cycle");
    visited.add(child);
    definition = child;
  }
  const selectedTools = definition.tools.filter((item) => item.name === request.tool);
  if (selectedTools.length !== 1 || selectedTools[0]!.runtime !== undefined) {
    throw new Error("cave_sandbox_unknown_tool");
  }
  const selected = selectedTools[0]!;
  if (toolDefinitionSHA256(selected) !== request.toolDefinitionSha256) {
    throw new Error("cave_sandbox_tool_definition_mismatch");
  }
  if (selected.effect !== "read" && request.allowSideEffects !== true) {
    throw new Error("cave_sandbox_side_effect_denied");
  }
  const context: ToolExecutionContext = Object.freeze({
    toolCallId: request.invocation.toolCallId,
    parentToolCallId: request.invocation.toolCallId,
    ...(request.invocation.durable === undefined
      ? {}
      : { durable: Object.freeze({ ...request.invocation.durable }) }),
    dispatch() {
      return Promise.reject(new Error("cave_nested_tool_dispatch_unavailable"));
    },
  });
  const rawValue = await executeRawTool(
    selected,
    request.params as never,
    AbortSignal.timeout(selected.timeoutMs),
    context,
  );
  // Standard Schema transforms need the original runtime value (Date, class,
  // etc.). Settle inside worker before JSON transport erases that identity;
  // parent rehydrates this trusted frame without validating twice.
  const settled = await settleToolOutput(selected, rawValue);
  writeResult({
    ok: true,
    value: settled.value,
    text: settled.text,
    settled: true,
  });
} catch (error) {
  writeResult({ ok: false, code: failureCode(error) });
}

function validInvocation(value: unknown): value is {
  toolCallId: string;
  durable?: { idempotencyKey: string; resumed: boolean };
} {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== "toolCallId" && key !== "durable") ||
      !Object.hasOwn(record, "toolCallId") || typeof record.toolCallId !== "string" ||
      record.toolCallId.length === 0 ||
      new TextEncoder().encode(record.toolCallId).byteLength > 1024 ||
      /[\u0000-\u001f\u007f]/u.test(record.toolCallId)) return false;
  if (record.durable === undefined) return true;
  if (record.durable === null || typeof record.durable !== "object" ||
      Array.isArray(record.durable) || Object.getPrototypeOf(record.durable) !== Object.prototype) {
    return false;
  }
  const durable = record.durable as Record<string, unknown>;
  return Object.keys(durable).sort().join(",") === "idempotencyKey,resumed" &&
    typeof durable.idempotencyKey === "string" &&
    /^cave-[0-9a-f]{64}$/.test(durable.idempotencyKey) &&
    typeof durable.resumed === "boolean";
}
