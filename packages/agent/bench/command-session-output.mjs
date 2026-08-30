#!/usr/bin/env node

import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createCommandSessionRuntime } from "@caveman-ai/agent/command-session";

const MIB = 1024 * 1024;
const MEMORY_BYTES = 4 * MIB;
const SPILL_BYTES = 12 * MIB;
const PAYLOAD_BYTES = MEMORY_BYTES + SPILL_BYTES;
const PAGE_BYTES = MIB;
const CHILD_CHUNK_BYTES = 64 * 1024;
const WARMUP_ITERATIONS = 1;
const DEFAULT_ITERATIONS = 2;
const MAX_ITERATIONS = 50;
const PROCESS_TIMEOUT_MS = 10 * 60_000;
const READ_WAIT_MS = 30_000;

const CHILD_SOURCE = String.raw`
const readline = require("node:readline");
const output = process.stdout;
let active = false;

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (active) process.exit(71);
  const match = /^(\d+):(\d+)$/.exec(line);
  if (match === null) process.exit(72);
  const seed = Number(match[1]);
  let remaining = Number(match[2]);
  if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(remaining) || remaining <= 0) {
    process.exit(73);
  }

  const chunk = Buffer.allocUnsafe(Math.min(${CHILD_CHUNK_BYTES}, remaining));
  for (let index = 0; index < chunk.byteLength; index++) {
    chunk[index] = 32 + ((index + seed * 17) % 95);
  }
  active = true;
  const pump = () => {
    while (remaining > 0) {
      const page = remaining >= chunk.byteLength ? chunk : chunk.subarray(0, remaining);
      remaining -= page.byteLength;
      if (!output.write(page)) {
        output.once("drain", pump);
        return;
      }
    }
    active = false;
  };
  pump();
});
`;

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

function invariant(condition, code, detail) {
  if (!condition) fail(code, detail);
}

function parseArguments(argv) {
  let check = false;
  let iterations = DEFAULT_ITERATIONS;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--check") {
      check = true;
      continue;
    }
    if (argument === "--iterations") {
      iterations = Number(argv[++index]);
      continue;
    }
    if (argument.startsWith("--iterations=")) {
      iterations = Number(argument.slice("--iterations=".length));
      continue;
    }
    if (argument === "--help") {
      console.log("Usage: node bench/command-session-output.mjs [--check] [--iterations N]");
      process.exit(0);
    }
    fail("command_session_bench_argument_invalid", argument);
  }
  invariant(
    Number.isSafeInteger(iterations) && iterations > 0 && iterations <= MAX_ITERATIONS,
    "command_session_bench_iterations_invalid",
    `iterations must be 1..${MAX_ITERATIONS}`,
  );
  return Object.freeze({ check, iterations });
}

function patternChunk(seed) {
  const chunk = Buffer.allocUnsafe(CHILD_CHUNK_BYTES);
  for (let index = 0; index < chunk.byteLength; index++) {
    chunk[index] = 32 + ((index + seed * 17) % 95);
  }
  return chunk;
}

function expectedSHA256(seed, start, length) {
  const pattern = patternChunk(seed);
  const hash = createHash("sha256");
  let cursor = start;
  let remaining = length;
  while (remaining > 0) {
    const offset = cursor % pattern.byteLength;
    const bytes = Math.min(remaining, pattern.byteLength - offset);
    hash.update(pattern.subarray(offset, offset + bytes));
    cursor += bytes;
    remaining -= bytes;
  }
  return hash.digest("hex");
}

function elapsedMs(start) {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

async function waitForCapture(runtime, sessionId, start, seed) {
  const target = start + PAYLOAD_BYTES;
  const began = process.hrtime.bigint();
  const write = await runtime.write({
    sessionId,
    input: `${seed}:${PAYLOAD_BYTES}\n`,
  });
  invariant(
    write.accepted && write.bytes > 0,
    "command_session_bench_input_rejected",
    `seed=${seed} state=${write.state}`,
  );

  let cursor = start;
  while (true) {
    const observed = await runtime.read({
      sessionId,
      cursor,
      limit: 1,
      waitMs: READ_WAIT_MS,
    });
    invariant(
      observed.availableTo <= target,
      "command_session_bench_output_overrun",
      `seed=${seed} availableTo=${observed.availableTo} target=${target}`,
    );
    if (observed.availableTo === target) {
      return Object.freeze({ captureMs: elapsedMs(began), target });
    }
    invariant(
      observed.state === "running",
      "command_session_bench_child_stopped",
      `seed=${seed} state=${observed.state} bytes=${observed.availableTo - start}`,
    );
    cursor = observed.availableTo;
  }
}

function decodePage(page) {
  return Buffer.from(page.output, page.outputEncoding === "base64" ? "base64" : "utf8");
}

async function recoverAndVerify(runtime, sessionId, iterationStart, iterationEnd, seed, cap) {
  const summary = runtime.list().find((candidate) => candidate.sessionId === sessionId);
  invariant(summary !== undefined, "command_session_bench_session_missing", sessionId);
  invariant(
    summary.availableTo === iterationEnd,
    "command_session_bench_capture_incomplete",
    `seed=${seed} availableTo=${summary.availableTo} expected=${iterationEnd}`,
  );
  const retainedBytes = summary.availableTo - summary.availableFrom;
  invariant(
    retainedBytes >= 0 && retainedBytes <= cap,
    "command_session_bench_retention_bound_exceeded",
    `seed=${seed} retained=${retainedBytes} cap=${cap}`,
  );

  const recoveryStart = Math.max(iterationStart, summary.availableFrom);
  const expectedBytes = iterationEnd - recoveryStart;
  const expected = expectedSHA256(seed, recoveryStart - iterationStart, expectedBytes);
  const began = process.hrtime.bigint();
  const hash = createHash("sha256");
  let cursor = recoveryStart;
  while (cursor < iterationEnd) {
    const page = await runtime.read({
      sessionId,
      cursor,
      limit: Math.min(PAGE_BYTES, iterationEnd - cursor),
    });
    invariant(
      page.outputStart === cursor,
      "command_session_bench_recovery_gap",
      `seed=${seed} cursor=${cursor} outputStart=${page.outputStart}`,
    );
    const bytes = decodePage(page);
    invariant(
      bytes.byteLength > 0 && page.nextCursor === cursor + bytes.byteLength,
      "command_session_bench_recovery_cursor_invalid",
      `seed=${seed} cursor=${cursor} next=${page.nextCursor} bytes=${bytes.byteLength}`,
    );
    hash.update(bytes);
    cursor = page.nextCursor;
  }
  const actualSHA256 = hash.digest("hex");
  invariant(
    actualSHA256 === expected,
    "command_session_bench_sha_mismatch",
    `seed=${seed} actual=${actualSHA256} expected=${expected}`,
  );
  return Object.freeze({
    recoveryMs: elapsedMs(began),
    retainedBytes,
    recoveryStart,
    recoveredBytes: expectedBytes,
    actualSHA256,
    expectedSHA256: expected,
    exactSHA256: true,
  });
}

async function visibleSpillBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory)) total += (await stat(join(directory, entry))).size;
  return total;
}

function percentile(values, probability) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * probability) - 1)];
}

function timingSummary(samples, field) {
  const values = samples.map((sample) => sample[field]);
  return Object.freeze({
    p50_ms: Number(percentile(values, 0.5).toFixed(3)),
    p95_ms: Number(percentile(values, 0.95).toFixed(3)),
    min_ms: Number(Math.min(...values).toFixed(3)),
    max_ms: Number(Math.max(...values).toFixed(3)),
  });
}

async function runArm({ name, directory, spillBytes, iterations }) {
  const spillDirectory = join(directory, "spill");
  await mkdir(spillDirectory);
  const retentionCap = MEMORY_BYTES + spillBytes;
  const runtime = createCommandSessionRuntime({
    maxSessions: 1,
    maxOutputBytes: MEMORY_BYTES,
    ...(spillBytes === 0 ? {} : {
      spill: { directory: spillDirectory, maxBytes: spillBytes },
    }),
    maxReadBytes: PAGE_BYTES,
    maxInputBytes: 1024,
    maxTimeoutMs: PROCESS_TIMEOUT_MS,
    maxWaitMs: READ_WAIT_MS,
  });
  const samples = [];
  let visibleSpillPeakBytes = 0;
  let started;
  try {
    started = await runtime.start({
      command: process.execPath,
      args: ["-e", CHILD_SOURCE],
      cwd: directory,
      env: {},
      stdin: "pipe",
      timeoutMs: PROCESS_TIMEOUT_MS,
    });

    for (let run = 0; run < WARMUP_ITERATIONS + iterations; run++) {
      const iterationStart = run * PAYLOAD_BYTES;
      const capture = await waitForCapture(runtime, started.sessionId, iterationStart, run);
      const recovered = await recoverAndVerify(
        runtime,
        started.sessionId,
        iterationStart,
        capture.target,
        run,
        retentionCap,
      );
      visibleSpillPeakBytes = Math.max(
        visibleSpillPeakBytes,
        await visibleSpillBytes(spillDirectory),
      );
      invariant(
        visibleSpillPeakBytes <= spillBytes,
        "command_session_bench_visible_spill_bound_exceeded",
        `arm=${name} visible=${visibleSpillPeakBytes} cap=${spillBytes}`,
      );
      if (run >= WARMUP_ITERATIONS) {
        samples.push(Object.freeze({
          iteration: run,
          capture_ms: Number(capture.captureMs.toFixed(3)),
          recovery_ms: Number(recovered.recoveryMs.toFixed(3)),
          retained_bytes: recovered.retainedBytes,
          recovered_bytes: recovered.recoveredBytes,
          expected_sha256: recovered.expectedSHA256,
          actual_sha256: recovered.actualSHA256,
          exact_sha256: recovered.exactSHA256,
        }));
      }
    }
  } finally {
    await runtime.close();
  }

  const filesAfterClose = await readdir(spillDirectory);
  invariant(
    filesAfterClose.length === 0,
    "command_session_bench_cleanup_failed",
    `arm=${name} files=${filesAfterClose.join(",")}`,
  );
  invariant(samples.length === iterations, "command_session_bench_sample_count", name);
  const expectedRecoveredBytes = spillBytes === 0 ? MEMORY_BYTES : PAYLOAD_BYTES;
  invariant(
    samples.every((sample) => sample.recovered_bytes === expectedRecoveredBytes),
    "command_session_bench_recovery_size_invalid",
    `arm=${name} expected=${expectedRecoveredBytes}`,
  );
  return Object.freeze({
    name,
    spill: Object.freeze({ enabled: spillBytes > 0, max_bytes: spillBytes }),
    memory_bytes: MEMORY_BYTES,
    retained_cap_bytes: retentionCap,
    expected_recovered_bytes_per_iteration: expectedRecoveredBytes,
    sha_scope: spillBytes === 0 ? "exact_retained_suffix" : "exact_full_payload",
    persistent_child: true,
    warmup_iterations: WARMUP_ITERATIONS,
    cleanup_succeeded: true,
    visible_spill_peak_bytes: visibleSpillPeakBytes,
    capture_timing: timingSummary(samples, "capture_ms"),
    recovery_timing: timingSummary(samples, "recovery_ms"),
    samples,
  });
}

export async function runCommandSessionOutputBenchmark({ iterations = DEFAULT_ITERATIONS } = {}) {
  invariant(
    Number.isSafeInteger(iterations) && iterations > 0 && iterations <= MAX_ITERATIONS,
    "command_session_bench_iterations_invalid",
    `iterations must be 1..${MAX_ITERATIONS}`,
  );
  const temporaryRoot = await mkdtemp(join(tmpdir(), "caveman-command-session-bench-"));
  let arms;
  try {
    const memoryDirectory = join(temporaryRoot, "memory-only");
    const spillDirectory = join(temporaryRoot, "spill-enabled");
    await Promise.all([mkdir(memoryDirectory), mkdir(spillDirectory)]);
    arms = [
      await runArm({
        name: "memory_only",
        directory: memoryDirectory,
        spillBytes: 0,
        iterations,
      }),
      await runArm({
        name: "memory_plus_local_temp_spill",
        directory: spillDirectory,
        spillBytes: SPILL_BYTES,
        iterations,
      }),
    ];
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  let rootRemoved = false;
  try {
    await access(temporaryRoot);
  } catch (error) {
    rootRemoved = error?.code === "ENOENT";
  }
  invariant(rootRemoved, "command_session_bench_temp_root_cleanup_failed", temporaryRoot);
  return Object.freeze({
    schema: "cavebench.command-session-output.v1",
    provider_calls: 0,
    environment: Object.freeze({
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    }),
    payload_bytes_per_iteration: PAYLOAD_BYTES,
    iterations,
    gate: Object.freeze({
      deterministic_correctness_and_bounds_only: true,
      speed_thresholds: false,
      passed: true,
    }),
    timings: "informational_only",
    process_model: "one_persistent_child_per_arm_after_one_warmup_iteration",
    exact_sha256_verified: arms.every((arm) =>
      arm.samples.every((sample) => sample.exact_sha256)),
    retained_bounds_verified: arms.every((arm) =>
      arm.samples.every((sample) => sample.retained_bytes <= arm.retained_cap_bytes)),
    cleanup_succeeded: rootRemoved && arms.every((arm) => arm.cleanup_succeeded),
    arms,
  });
}

const isMain = process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const options = parseArguments(process.argv.slice(2));
  try {
    const report = await runCommandSessionOutputBenchmark({ iterations: options.iterations });
    console.log(JSON.stringify({ ...report, check: options.check }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
