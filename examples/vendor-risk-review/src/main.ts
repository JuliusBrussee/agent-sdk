import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createVendorAnalyzer } from "./agent.js";
import { validateVendor } from "./domain.js";
import { createVendorServer, parseCredentials } from "./server.js";
import { FileVendorStore } from "./store.js";
const credentialJSON = process.env.VENDOR_API_KEYS_JSON; if (!credentialJSON) throw new Error("VENDOR_API_KEYS_JSON is required");
const vendors = (JSON.parse(await readFile(new URL("../data/vendors.json", import.meta.url), "utf8")) as unknown[]).map(validateVendor);
const store = new FileVendorStore(resolve(process.env.VENDOR_DATA_FILE ?? ".data/vendor-state.json")); await store.initialize(vendors);
const server = createVendorServer({ store, analyzer: createVendorAnalyzer({ rootDir: process.cwd() }), credentials: parseCredentials(credentialJSON) });
const host = process.env.VENDOR_HOST?.trim() || "127.0.0.1"; const port = numberPort(process.env.VENDOR_PORT ?? "8791");
await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(port, host, done); }); process.stdout.write(`${JSON.stringify({ event: "server_listening", host, port })}\n`);
let closing = false; for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { if (closing) return; closing = true; server.close((error) => { if (error) process.exitCode = 1; }); });
function numberPort(value: string) { const port = Number(value); if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("VENDOR_PORT invalid"); return port; }
