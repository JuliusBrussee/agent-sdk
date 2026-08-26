#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { CODING_AGENT_HELP, parseCodingAgentCLIArgs } from "./cli-args.js";

export { CODING_AGENT_HELP, parseCodingAgentCLIArgs } from "./cli-args.js";

export async function main(
  argv = process.argv.slice(2),
  io = { stdout: process.stdout, stderr: process.stderr },
  runtime,
) {
  const options = parseCodingAgentCLIArgs(argv);
  if (options.help) {
    io.stdout.write(`${CODING_AGENT_HELP}\n`);
    return undefined;
  }
  const sdk = runtime ?? await import("@caveman-ai/agent/code");
  const agent = sdk.createCodingAgent({
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    ...(options.model === undefined ? {} : { model: options.model }),
  });
  return sdk.runCodingSession({
    agent,
    ...(options.cave === undefined ? {} : { cave: options.cave }),
    ...(options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd }),
    ...(options.ensureRuntime === undefined ? {} : { ensureRuntime: options.ensureRuntime }),
    output: io.stdout,
    notice: io.stderr,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
