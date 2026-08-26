import type { AdapterManifest, AdapterPackage } from "@caveman-ai/adapter-kit";
import type {
  HarnessAdapter,
  HarnessAdapterIdentity,
  HarnessInvoke,
} from "@caveman-ai/agent/adapters";

export const manifest: AdapterManifest;
export function createAdapter(
  identity: HarnessAdapterIdentity,
  invoke: HarnessInvoke,
): HarnessAdapter;
export { createAdapter as createClaudeAdapter };
export { runClaudeAgent } from "@caveman-ai/agent/claude";
export type { ClaudeRunOptions } from "@caveman-ai/agent/claude";
declare const adapterPackage: AdapterPackage<typeof createAdapter>;
export default adapterPackage;
