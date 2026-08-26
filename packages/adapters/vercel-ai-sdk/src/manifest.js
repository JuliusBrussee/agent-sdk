export const adapterManifest = Object.freeze({
  schemaVersion: 1,
  id: "vercel-ai-sdk",
  packageName: "@caveman-ai/adapter-vercel-ai-sdk",
  adapterVersion: "0.1.0",
  upstream: Object.freeze({ package: "ai", version: "7.0.43" }),
  capabilities: Object.freeze({
    run: "experimental",
    stream: "unsupported",
    tools: "experimental",
    usage: "experimental",
    abort: "experimental",
    durable: "unsupported",
    compile: "unsupported",
  }),
  certifications: Object.freeze({}),
});
