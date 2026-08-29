#!/usr/bin/env node
import {
  createCodingAgent,
  startCodingSession,
  streamCodingTurn,
} from "./code.js";

export interface PebbleSpineArgs {
  prompt: string;
  json: boolean;
  cave: "auto" | "off";
  model?: string;
}

export function parsePebbleSpineArgs(argv: readonly string[]): PebbleSpineArgs {
  let prompt: string | undefined;
  let model: string | undefined;
  let json = false;
  let cave: "auto" | "off" = "auto";
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "-p" || arg === "--prompt") {
      prompt = argv[++index];
      if (prompt === undefined || prompt === "") throw new Error("pebble_prompt_required");
      continue;
    }
    if (arg === "--model") {
      model = argv[++index];
      if (model === undefined || model === "") throw new Error("pebble_model_required");
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--cave-off") {
      cave = "off";
      continue;
    }
    throw new Error(`pebble_unknown_argument:${arg}`);
  }
  if (prompt === undefined) throw new Error("pebble_prompt_required");
  return {
    prompt,
    json,
    cave,
    ...(model === undefined ? {} : { model }),
  };
}

function exitCode(stopReason: string): number {
  if (stopReason === "end_turn") return 0;
  if (stopReason === "error") return 1;
  return 2;
}

export async function runPebbleSpine(argv: readonly string[]): Promise<number> {
  const args = parsePebbleSpineArgs(argv);
  const agent = createCodingAgent({
    workspace: process.cwd(),
    ...(args.model === undefined ? {} : { model: args.model }),
  });
  try {
    const session = await startCodingSession(agent, { cave: args.cave });
    let code = 1;
    for await (const event of streamCodingTurn(session, args.prompt)) {
      if (args.json) process.stdout.write(`${JSON.stringify(event)}\n`);
      else if (event.kind === "delta.text") process.stdout.write(event.text);
      if (event.kind === "turn.end") code = exitCode(event.stopReason);
    }
    if (!args.json) process.stdout.write("\n");
    return code;
  } finally {
    await agent.close();
  }
}

const isMain = process.argv[1] !== undefined &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;
if (isMain) {
  runPebbleSpine(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
