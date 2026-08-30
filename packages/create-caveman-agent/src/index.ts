#!/usr/bin/env node
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

type Provider = "anthropic" | "openai" | "google";

// The scaffolded default model per provider. Each is resolvable by the
// runtime's pinned Pi registry, priced by the public catalog, and caches with
// a minimum prefix the template's frozen prefix clears (1,024 tokens for the
// Anthropic pick; 2,048 for the OpenAI and Google picks):
// - anthropic/claude-sonnet-5 — explicit cache breakpoints.
// - openai/gpt-5.4-mini — catalog cacheMode "affinity" (OpenAI's automatic
//   prompt caching); no explicit-cache OpenAI model exists in the pinned
//   registry, and this one keeps the template's $0.05/ticket budget viable.
// - google/gemini-2.5-flash — implicit provider-managed caching; Google has
//   no explicit-cache model in the catalog.
// The generator rewrites the template agent.ts model line to this value.
const MODELS: Record<Provider, string> = {
  anthropic: "anthropic/claude-sonnet-5",
  openai: "openai/gpt-5.4-mini",
  google: "google/gemini-2.5-flash",
};

// The exact model line templates/support-bot/agent.ts ships with; the
// single-point mutation below (like the package.json name field) swaps it
// for the chosen provider's model. Rewriting fails closed if the template
// line ever drifts from this constant.
const TEMPLATE_MODEL_LINE = `  model: "${MODELS.anthropic}",`;

const USAGE = "usage: npm create @caveman-ai/agent@latest <project> [--provider anthropic|openai|google] [--no-install]";

const TEMPLATE_DIR = fileURLToPath(new URL("../templates/support-bot", import.meta.url));

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const parsed = parseArgs(args);
  const targetArg = parsed.target;
  const target = resolve(targetArg);
  const name = safeName(basename(target));
  await assertAbsent(target);
  const provider = await chooseProvider(parsed.provider);
  const temporary = resolve(dirname(target), `.${basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await cp(TEMPLATE_DIR, temporary, { recursive: true });
    const manifestPath = resolve(temporary, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.name = name;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await rewriteAgentModel(resolve(temporary, "agent.ts"), provider);
    await mkdir(resolve(temporary, ".caveman"), { recursive: true });
    const generated: Record<string, string> = {
      ".caveman/provider.json": `${JSON.stringify({ provider, model: MODELS[provider] }, null, 2)}\n`,
      ".gitignore": "node_modules/\n.caveman/traces/\n.caveman/agent-dir-entry.mjs\n.caveman/workload-profile.json\n.env*\n",
    };
    for (const [path, content] of Object.entries(generated)) {
      await writeFile(resolve(temporary, path), content, { flag: "wx", mode: 0o600 });
    }
    if (parsed.install) await installDependencies(temporary);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  process.stdout.write([
    `created ${name}`,
    `provider ${provider} (${MODELS[provider]})`,
    `cd ${targetArg}`,
    ...(parsed.install ? [] : ["npm install"]),
    "npm run ticket -- tickets/refund-request.md",
    "review evals/support.eval.ts, then npm run build (all declared evals run within budget)",
    "",
  ].join("\n"));
}

function parseArgs(args: string[]): {
  target: string;
  provider?: string;
  install: boolean;
} {
  let provider: string | undefined;
  let install = true;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (value === "--provider") {
      const candidate = args[++index];
      if (!candidate || candidate.startsWith("--")) throw new Error("--provider requires a value");
      provider = candidate;
      continue;
    }
    if (value === "--no-install") {
      install = false;
      continue;
    }
    if (value.startsWith("--")) throw new Error(`unknown option ${value}`);
    positional.push(value);
  }
  if (positional.length !== 1) {
    throw new Error(
      USAGE,
    );
  }
  return {
    target: positional[0]!,
    ...(provider === undefined ? {} : { provider }),
    install,
  };
}

// Pinned string models must use the provider/model form, and a pinned model
// makes provider.json's fallback inert — so the template's model line itself
// is rewritten to the chosen provider's default.
async function rewriteAgentModel(agentTsPath: string, provider: Provider): Promise<void> {
  const source = await readFile(agentTsPath, "utf8");
  if (!source.includes(TEMPLATE_MODEL_LINE)) {
    throw new Error("template agent.ts model line drifted from the generator's expectation");
  }
  await writeFile(
    agentTsPath,
    source.replace(TEMPLATE_MODEL_LINE, `  model: "${MODELS[provider]}",`),
  );
}

async function installDependencies(directory: string): Promise<void> {
  const npmExecPath = process.env.npm_execpath;
  const windowsShell = !npmExecPath && process.platform === "win32";
  const command = npmExecPath
    ? process.execPath
    : windowsShell
      ? process.env.ComSpec ?? "cmd.exe"
      : "npm";
  const args = npmExecPath
    ? [npmExecPath, "install", "--no-audit", "--no-fund", "--ignore-scripts"]
    : windowsShell
      ? ["/d", "/s", "/c", "npm install --no-audit --no-fund --ignore-scripts"]
      : ["install", "--no-audit", "--no-fund", "--ignore-scripts"];
  await new Promise<void>((done, reject) => {
    const child = spawn(command, args, {
      cwd: directory,
      env: dependencyInstallEnv(),
      // stderr is captured (and echoed) so an ETARGET on the not-yet-published
      // SDK can be named instead of silently swallowed by the rollback.
      stdio: ["ignore", "inherit", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      process.stderr.write(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        done();
        return;
      }
      const captured = Buffer.concat(stderr).toString("utf8");
      // Pre-release honesty: the template pins the @caveman-ai/agent version
      // this scaffold ships against, which publishes at the Phase-5 release
      // gate. Until then npm reports ETARGET; say why and how to proceed.
      if (/ETARGET|No matching version found for @caveman-ai\/agent/.test(captured)) {
        reject(new Error([
          "npm could not find the pinned @caveman-ai/agent version — it is the",
          "Agent SDK v2 release target and has not been published to npm yet",
          "(pre-release scaffold). Re-run with --no-install and install the SDK",
          "from a local checkout (npm link / file:) until it publishes.",
        ].join("\n")));
        return;
      }
      reject(new Error(`npm install failed (${signal ?? code})`));
    });
  });
}

function dependencyInstallEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "ComSpec", "PATHEXT",
    "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "CI", "NO_COLOR", "FORCE_COLOR",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
    "NPM_CONFIG_CACHE", "NPM_CONFIG_REGISTRY", "NPM_CONFIG_USERCONFIG",
    "npm_config_cache", "npm_config_registry", "npm_config_userconfig",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

async function chooseProvider(flag: string | undefined): Promise<Provider> {
  if (flag !== undefined) return parseProvider(flag);
  const detected: Provider[] = [];
  if (process.env.ANTHROPIC_API_KEY) detected.push("anthropic");
  if (process.env.OPENAI_API_KEY) detected.push("openai");
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) detected.push("google");
  if (detected.length === 1) return detected[0]!;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      detected.length === 0
        ? "no provider credential detected; pass --provider"
        : "multiple provider credentials detected; pass --provider",
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Provider (anthropic/openai/google): ");
    return parseProvider(answer);
  } finally {
    rl.close();
  }
}

function parseProvider(value: string): Provider {
  const normalized = value.trim().toLowerCase();
  if (normalized === "anthropic" || normalized === "openai" || normalized === "google") return normalized;
  throw new Error(`unsupported provider ${JSON.stringify(value)}`);
}

// Mirrors the SDK's slugifyAgentDirId: the project directory name becomes the
// agent id, so both must slug the same way (lowercase, invalid chars → "-",
// repeats collapsed, trimmed, [a-z0-9] first character, 96 max).
function safeName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  if (!/^[a-z0-9][a-z0-9_-]{0,95}$/.test(normalized)) {
    throw new Error("project name must slug to a valid agent id ([a-z0-9][a-z0-9_-]*)");
  }
  return normalized;
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await stat(path);
    throw new Error(`target already exists: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`create-caveman-agent: ${message}\n`);
  process.exitCode = 1;
});
