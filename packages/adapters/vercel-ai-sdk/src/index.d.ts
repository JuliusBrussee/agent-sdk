import type { AdapterManifest, AdapterPackage } from "@caveman-ai/adapter-kit";
import type {
  HarnessAdapter,
  HarnessAdapterIdentity,
  VercelToolLoopAgentBinding,
} from "@caveman-ai/agent/adapters";

export const manifest: AdapterManifest;
export function createAdapter(
  identity: HarnessAdapterIdentity,
  agent: VercelToolLoopAgentBinding,
): HarnessAdapter;
export { createAdapter as createVercelAISDKAdapter };
declare const adapterPackage: AdapterPackage<typeof createAdapter>;
export default adapterPackage;
