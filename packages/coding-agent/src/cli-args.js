export const CODING_AGENT_HELP = `Usage: caveman-code [options]

Options:
  --workspace <path>    workspace root (default: current directory)
  --model <id>          provider/model override
  --observe-only        disable Cave runtime transforms
  --max-cost-usd <usd>  best-effort per-turn public-catalog spend cap
  --no-start-runtime    probe runtime without trying to start it
  -h, --help            show help`;

export function parseCodingAgentCLIArgs(argv) {
  const options = { help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") {
      options.help = true;
    } else if (argument === "--observe-only") {
      options.cave = "off";
    } else if (argument === "--no-start-runtime") {
      options.ensureRuntime = false;
    } else if (argument === "--workspace" || argument === "--model" ||
        argument === "--max-cost-usd") {
      const value = argv[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw new Error(`caveman-code: missing value for ${argument}`);
      }
      index += 1;
      if (argument === "--workspace") options.workspace = value;
      if (argument === "--model") options.model = value;
      if (argument === "--max-cost-usd") {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error("caveman-code: --max-cost-usd must be positive");
        }
        options.maxCostUsd = parsed;
      }
    } else {
      throw new Error(`caveman-code: unknown option ${argument}`);
    }
  }
  return Object.freeze(options);
}
