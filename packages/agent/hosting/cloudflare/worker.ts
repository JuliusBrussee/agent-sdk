/**
 * Cloudflare target for `caveman-agent serve`.
 *
 * The agent runtime shells out (host-sandbox tools, subprocess isolation), and
 * Workers has no `node:child_process`, so the agent runs in a **Container**.
 * The Worker in front of it supplies the one thing a container cannot: storage
 * that outlives the instance.
 *
 *   request ──▶ Worker ──▶ Container (caveman-agent serve)
 *                  ▲              │
 *                  └── journal ◀──┘   (HttpDurableStore → RunJournal DO)
 *
 * Why the journal lives in a Durable Object: container disk is scratch. A DO
 * gives exactly what `DurableStore` asks for — a single writer, ordered
 * appends, and a write that is durable before the response is delivered (the
 * output gate). When the container dies mid-run, the journal is untouched, and
 * the next instance's recovery sweep re-drives the run from it.
 *
 * ponytail: ONE journal DO for every run. Single writer is the whole point,
 * and it keeps `GET /runs` a local query instead of a scatter-gather. Shard by
 * `runId` prefix if journal throughput ever becomes the bottleneck — that is a
 * change to which DO id the fetch handler picks, not to the wire contract.
 */

import { Container, getContainer } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";

export interface Env {
  AGENT: DurableObjectNamespace<AgentContainer>;
  JOURNAL: DurableObjectNamespace<RunJournal>;
  /** Public origin of this Worker, so the container can reach the journal. */
  PUBLIC_URL: string;
  /** Secret. Callers present this to reach /runs. */
  CAVE_SERVE_TOKEN: string;
  /** Secret. The container presents this to reach /journal. */
  CAVE_JOURNAL_TOKEN: string;
  /** Secret. Provider credential handed to the agent process. */
  ANTHROPIC_API_KEY: string;
}

/** The agent server itself, from hosting/Dockerfile. */
export class AgentContainer extends Container<Env> {
  defaultPort = 8080;
  /**
   * Short on purpose. A durable sleep no longer needs a live container to sit
   * and watch a clock — the journal holds the wake time and `RunJournal`'s
   * alarm brings the container back exactly when a run is due. So idling costs
   * a few minutes of compute after the last request, not the length of the
   * longest wait in the system.
   */
  sleepAfter = "5m";
  /** `/healthz` is liveness and unauthenticated, which is what a probe needs. */
  pingEndpoint = "localhost:8080/healthz";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Set here rather than as a class field: the values are secrets that only
    // exist on `env`. Nothing ambient is inherited — this is the whole
    // environment the agent process gets.
    this.envVars = {
      CAVE_SERVE_TOKEN: env.CAVE_SERVE_TOKEN,
      CAVE_JOURNAL_URL: `${env.PUBLIC_URL.replace(/\/+$/, "")}/journal`,
      CAVE_JOURNAL_TOKEN: env.CAVE_JOURNAL_TOKEN,
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    };
  }
}

interface LockRow {
  runId: string;
  token: string;
  expiresAt: number;
}

/**
 * The wake time in a batch of journal lines, if it carries one. The journal DO
 * stores opaque lines and does not parse journal semantics in general — but a
 * wake time is the one thing it must understand, because once the container is
 * asleep this DO is the only component still able to act.
 */
function wakeTimeOf(data: string): number | undefined {
  let latest: number | undefined;
  for (const line of data.split("\n")) {
    if (line === "" || !line.includes('"sleep_scheduled"')) continue;
    try {
      const event: unknown = JSON.parse(line);
      if (event === null || typeof event !== "object") continue;
      const record = event as { type?: unknown; wakeAt?: unknown };
      if (record.type !== "sleep_scheduled" || typeof record.wakeAt !== "string") continue;
      const at = Date.parse(record.wakeAt);
      if (Number.isFinite(at)) latest = at;
    } catch {
      // Not this DO's business: the runtime validates journal events.
    }
  }
  return latest;
}

/** True when this batch settles the run, so its wake can be dropped. */
function isTerminal(data: string): boolean {
  return data.includes('"run_completed"') || data.includes('"run_failed"');
}

/**
 * The journal. Implements the `HttpDurableStore` wire contract.
 *
 * Durability: a Durable Object does not deliver a response until the storage
 * writes made during that request are durable. The `204` on append therefore
 * means what `DurableStore.append` requires it to mean.
 */
export class RunJournal extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS journal (
        seq   INTEGER PRIMARY KEY AUTOINCREMENT,
        runId TEXT NOT NULL,
        data  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS journal_run ON journal (runId, seq);
      CREATE TABLE IF NOT EXISTS locks (
        runId     TEXT PRIMARY KEY,
        token     TEXT NOT NULL,
        expiresAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wakes (
        runId  TEXT PRIMARY KEY,
        wakeAt INTEGER NOT NULL
      );
    `);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/runs" && request.method === "GET") {
      const rows = this.sql
        .exec<{ runId: string }>("SELECT DISTINCT runId FROM journal ORDER BY runId")
        .toArray();
      return json({ runIds: rows.map((row) => row.runId) });
    }
    const match = /^\/runs\/([^/]+)(\/journal|\/lock|\/lock\/renew)$/.exec(path);
    const rawRunId = match?.[1];
    const resource = match?.[2];
    if (rawRunId === undefined || resource === undefined) {
      return json({ error: "not_found" }, 404);
    }
    const runId = decodeURIComponent(rawRunId);
    const body = request.method === "GET" ? {} : await readJson(request);

    if (resource === "/journal" && request.method === "GET") {
      const rows = this.sql
        .exec<{ data: string }>("SELECT data FROM journal WHERE runId = ? ORDER BY seq", runId)
        .toArray();
      if (rows.length === 0) return new Response("not found", { status: 404 });
      return new Response(rows.map((row) => row.data).join(""), {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (resource === "/journal" && request.method === "POST") {
      const data = body.data;
      if (typeof data !== "string" || data === "" || !data.endsWith("\n")) {
        return json({ error: "append_must_be_newline_terminated" }, 400);
      }
      // Second line of defence behind the client's own lease: a holder that
      // lost its lease cannot append past the instance that took it over.
      const live = this.liveLock(runId);
      if (live !== undefined && body.lock !== live.token) {
        return json({ error: "lock_lost" }, 409);
      }
      this.sql.exec("INSERT INTO journal (runId, data) VALUES (?, ?)", runId, data);
      // Wake times are tracked here, not in the container: this DO is the only
      // thing still running once the container sleeps, so it owns the alarm.
      if (isTerminal(data)) {
        this.sql.exec("DELETE FROM wakes WHERE runId = ?", runId);
      } else {
        const wakeAt = wakeTimeOf(data);
        if (wakeAt !== undefined) {
          this.sql.exec(
            "INSERT OR REPLACE INTO wakes (runId, wakeAt) VALUES (?, ?)",
            runId,
            wakeAt,
          );
        }
      }
      await this.rearm();
      return new Response(null, { status: 204 });
    }

    if (resource === "/lock" && request.method === "POST") {
      const ttlMs = typeof body.ttlMs === "number" ? body.ttlMs : 30_000;
      const live = this.liveLock(runId);
      if (live !== undefined) return json({ error: "locked" }, 409);
      const token = crypto.randomUUID();
      const expiresAt = Date.now() + ttlMs;
      this.sql.exec(
        "INSERT OR REPLACE INTO locks (runId, token, expiresAt) VALUES (?, ?, ?)",
        runId,
        token,
        expiresAt,
      );
      return json({ token, expiresAt });
    }

    if (resource === "/lock/renew" && request.method === "POST") {
      const live = this.liveLock(runId);
      if (live === undefined || live.token !== body.token) {
        return json({ error: "lock_lost" }, 409);
      }
      const ttlMs = typeof body.ttlMs === "number" ? body.ttlMs : 30_000;
      this.sql.exec(
        "UPDATE locks SET expiresAt = ? WHERE runId = ?",
        Date.now() + ttlMs,
        runId,
      );
      return new Response(null, { status: 204 });
    }

    if (resource === "/lock" && request.method === "DELETE") {
      const live = this.liveLock(runId);
      // Releasing a lease someone else now holds is a no-op, never a steal.
      if (live !== undefined && live.token === body.token) {
        this.sql.exec("DELETE FROM locks WHERE runId = ?", runId);
      }
      return new Response(null, { status: 204 });
    }

    return json({ error: "not_found" }, 404);
  }

  /**
   * Point the alarm at the earliest outstanding wake. This is the scale-to-zero
   * mechanism: a run sleeping until Thursday keeps no process alive, and
   * Thursday still arrives.
   */
  private async rearm(): Promise<void> {
    const row = this.sql
      .exec<{ wakeAt: number | null }>("SELECT MIN(wakeAt) AS wakeAt FROM wakes")
      .toArray()[0];
    const next = row?.wakeAt;
    if (next === null || next === undefined) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }

  /**
   * A run came due. Touching the container is enough: any request boots it, and
   * its boot recovery sweep is what re-drives whatever is now eligible. The
   * alarm deliberately carries no run identity — the journal is the source of
   * truth for what is due, and a second answer to that question here would be
   * one more thing that can disagree.
   */
  override async alarm(): Promise<void> {
    this.sql.exec("DELETE FROM wakes WHERE wakeAt <= ?", Date.now());
    try {
      await getContainer(this.env.AGENT, "agent").fetch(new Request("http://agent/readyz"));
    } catch {
      // A failed wake must not leave the alarm unarmed for runs still sleeping;
      // the container's next boot sweeps regardless.
    }
    await this.rearm();
  }

  /** The lock on `runId`, or undefined when none is held or the lease expired. */
  private liveLock(runId: string): LockRow | undefined {
    const row = this.sql
      .exec<LockRow>("SELECT * FROM locks WHERE runId = ?", runId)
      .toArray()[0];
    if (row === undefined) return undefined;
    if (row.expiresAt > Date.now()) return row;
    // An expired lease belongs to an instance that is gone. Reap it, so the
    // next acquire succeeds instead of the run staying stranded forever.
    this.sql.exec("DELETE FROM locks WHERE runId = ?", runId);
    return undefined;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function authorized(request: Request, expected: string): boolean {
  const presented = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (presented === undefined || presented.length !== expected.length) return false;
  // Constant time over equal-length strings. The length comparison is not
  // constant time, which is fine: these tokens are random and fixed-length,
  // so their length is not the secret.
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= presented.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // The journal is the container's private back channel, not a public API.
    if (url.pathname === "/journal" || url.pathname.startsWith("/journal/")) {
      if (!authorized(request, env.CAVE_JOURNAL_TOKEN)) {
        return json({ error: "unauthorized" }, 401);
      }
      const inner = new URL(request.url);
      inner.pathname = url.pathname.slice("/journal".length) || "/";
      return env.JOURNAL.get(env.JOURNAL.idFromName("journal"))
        .fetch(new Request(inner, request));
    }

    // Everything else is the agent server. One instance: its recovery sweep
    // and the journal lock are both per-run, so more instances are safe, but
    // one keeps the sweep from being N redundant scans.
    return getContainer(env.AGENT, "agent").fetch(request);
  },
} satisfies ExportedHandler<Env>;
