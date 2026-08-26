import type { CodingSessionRunOptions, SessionBill } from "@caveman-ai/agent/code";

export interface CodingAgentCLIOptions {
  readonly help: boolean;
  readonly workspace?: string;
  readonly model?: string;
  readonly cave?: "off";
  readonly maxCostUsd?: number;
  readonly ensureRuntime?: false;
}

export const CODING_AGENT_HELP: string;
export function parseCodingAgentCLIArgs(argv: readonly string[]): CodingAgentCLIOptions;
export function main(
  argv?: string[],
  io?: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
  runtime?: {
    createCodingAgent(options?: { workspace?: string; model?: string }): NonNullable<CodingSessionRunOptions["agent"]>;
    runCodingSession(options?: CodingSessionRunOptions): Promise<SessionBill>;
  },
): Promise<SessionBill | undefined>;
