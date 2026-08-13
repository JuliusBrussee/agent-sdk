#!/usr/bin/env node
// The new caveman-code, as a consumer sees it: four lines of wiring.
// Everything else — host-sandbox tools, the recoverable default plan, the
// observe-only fallback, the token bill, the recovery proof — lives in
// @caveman-ai/agent/code.
import { createCodingAgent, runCodingSession } from "@caveman-ai/agent/code";

export async function main(options = {}) {
  const agent = createCodingAgent({ workspace: options.workspace ?? process.cwd() });
  return runCodingSession({ agent, ...options });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`caveman-code: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
