import { defineAdapterPackage } from "@caveman-ai/adapter-kit";
import { createPiAdapter as createCoreAdapter } from "@caveman-ai/agent/adapters";
import { adapterManifest } from "./manifest.js";

const adapterPackage = defineAdapterPackage({
  manifest: adapterManifest,
  createAdapter: createCoreAdapter,
});

export const manifest = adapterPackage.manifest;
export const createAdapter = adapterPackage.createAdapter;
export { createAdapter as createPiAdapter };
export {
  compileProfiledNativePi,
  nativePiCompilerTarget,
} from "@caveman-ai/agent/compiler";
export default adapterPackage;
