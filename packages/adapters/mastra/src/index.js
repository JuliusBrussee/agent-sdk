import { defineAdapterPackage } from "@caveman-ai/adapter-kit";
import { createMastraAdapter as createCoreAdapter } from "@caveman-ai/agent/adapters";
import { adapterManifest } from "./manifest.js";

const adapterPackage = defineAdapterPackage({
  manifest: adapterManifest,
  createAdapter: createCoreAdapter,
});

export const manifest = adapterPackage.manifest;
export const createAdapter = adapterPackage.createAdapter;
export { createAdapter as createMastraAdapter };
export default adapterPackage;
