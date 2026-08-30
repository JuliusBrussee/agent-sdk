import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createTriageAnalyzer } from "./agent.js";
import { validateAsset } from "./domain.js";
import { createSecurityServer, parseCredentials } from "./server.js";
import { FileSecurityStore } from "./store.js";

const credentials = process.env.SECURITY_API_KEYS_JSON;
if (!credentials) throw new Error("SECURITY_API_KEYS_JSON is required");
const assets = (JSON.parse(await readFile(new URL("../data/assets.json", import.meta.url), "utf8")) as unknown[]).map(validateAsset);
const store = new FileSecurityStore(resolve(process.env.SECURITY_DATA_FILE ?? ".data/security-state.json"));
await store.initialize(assets);
const server = createSecurityServer({ store, analyzer: createTriageAnalyzer({ rootDir: process.cwd() }), credentials: parseCredentials(credentials) });
const host = process.env.SECURITY_HOST?.trim() || "127.0.0.1";
const port = portNumber(process.env.SECURITY_PORT ?? "8790");
await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(port, host, done); });
process.stdout.write(`${JSON.stringify({ event: "server_listening", host, port })}\n`);
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  if (closing) return; closing = true; server.close((error) => { if (error) process.exitCode = 1; });
});
function portNumber(value: string) { const number = Number(value); if (!Number.isSafeInteger(number) || number < 1 || number > 65535) throw new Error("SECURITY_PORT invalid"); return number; }
