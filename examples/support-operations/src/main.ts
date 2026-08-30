import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createSupportAnalyzer, type SupportOptimizationMode } from "./agent.js";
import { loadCurrentSupportBuild } from "./build-lock.js";
import { validateOrder, type Order } from "./domain.js";
import { createSupportServer, parseCredentials } from "./server.js";
import { FileSupportStore } from "./store.js";

const host = process.env.SUPPORT_HOST?.trim() || "127.0.0.1";
const port = parsePort(process.env.SUPPORT_PORT ?? "8789");
const dataFile = resolve(process.env.SUPPORT_DATA_FILE ?? ".data/support-state.json");
const credentialJSON = process.env.SUPPORT_API_KEYS_JSON;
if (!credentialJSON) throw new Error("SUPPORT_API_KEYS_JSON is required");
const optimizationMode = parseOptimizationMode(process.env.SUPPORT_OPTIMIZATION_MODE ?? "on");
const build = optimizationMode === "on"
  ? await loadCurrentSupportBuild(process.cwd())
  : undefined;

const seedPath = new URL("../data/orders.json", import.meta.url);
const seedOrders = (JSON.parse(await readFile(seedPath, "utf8")) as unknown[]).map(validateOrder);
const store = new FileSupportStore(dataFile);
await store.initialize(seedOrders);

const server = createSupportServer({
  store,
  analyzer: createSupportAnalyzer({
    rootDir: process.cwd(),
    mode: optimizationMode,
    ...(build === undefined ? {} : { build }),
  }),
  credentials: parseCredentials(credentialJSON),
});

await new Promise<void>((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(port, host, () => resolveListen());
});
process.stdout.write(`${JSON.stringify({ event: "server_listening", host, port })}\n`);

let closing = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (closing) return;
  closing = true;
  process.stdout.write(`${JSON.stringify({ event: "server_stopping", signal })}\n`);
  server.close((error) => {
    if (error) {
      process.stderr.write(`${JSON.stringify({ event: "server_stop_failed", code: "close_failed" })}\n`);
      process.exitCode = 1;
    }
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("SUPPORT_PORT must be an integer from 1 through 65535");
  }
  return parsed;
}

function parseOptimizationMode(value: string): SupportOptimizationMode {
  if (value !== "off" && value !== "on") {
    throw new Error("SUPPORT_OPTIMIZATION_MODE must be off or on");
  }
  return value;
}
