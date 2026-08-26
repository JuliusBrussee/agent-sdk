export const adapterManifest = Object.freeze({
  schemaVersion: 1,
  id: "mastra",
  packageName: "@caveman-ai/adapter-mastra",
  adapterVersion: "0.1.0",
  upstream: Object.freeze({ package: "@mastra/core", version: "1.55.0" }),
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
