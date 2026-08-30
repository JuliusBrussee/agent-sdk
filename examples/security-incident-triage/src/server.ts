import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import {
  DomainError,
  idempotencyKey,
  identifier,
  validateAlertInput,
  type Principal,
  type TriageAnalyzer,
} from "./domain.js";
import { FileSecurityStore } from "./store.js";

export function createSecurityServer(options: {
  store: FileSecurityStore;
  analyzer: TriageAnalyzer;
  credentials: ReadonlyMap<string, Principal>;
  logger?: (event: Record<string, unknown>) => void;
}) {
  const logger = options.logger ?? ((event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`));
  return createServer(async (request, response) => {
    const started = performance.now();
    let statusCode = 500;
    let errorCode: string | undefined;
    try {
      statusCode = await route(request, response, options);
    } catch (error) {
      const failure = error instanceof DomainError ? error : new DomainError("internal_error", 500);
      statusCode = failure.statusCode;
      errorCode = failure.code;
      send(response, statusCode, { error: { code: failure.code } });
    } finally {
      logger({ event: "request_complete", method: request.method, path: safePath(request.url), statusCode, durationMs: Math.round(performance.now() - started), ...(errorCode ? { errorCode } : {}) });
    }
  });
}

async function route(request: IncomingMessage, response: ServerResponse, options: {
  store: FileSecurityStore;
  analyzer: TriageAnalyzer;
  credentials: ReadonlyMap<string, Principal>;
}) {
  const url = new URL(request.url ?? "/", "http://security.local");
  if (request.method === "GET" && url.pathname === "/healthz") { send(response, 200, { status: "ok" }); return 200; }
  if (request.method === "GET" && url.pathname === "/readyz") { send(response, 200, await options.store.readiness()); return 200; }
  const principal = authenticate(request, options.credentials);
  if (request.method === "POST" && url.pathname === "/v1/incidents") {
    const result = await options.store.createIncident(principal, idempotencyKey(request.headers["idempotency-key"]), validateAlertInput(await json(request)));
    response.setHeader("idempotency-replayed", String(result.replayed));
    send(response, result.statusCode, result.body); return result.statusCode;
  }
  const incidentMatch = /^\/v1\/incidents\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && incidentMatch) {
    send(response, 200, await options.store.getIncident(principal.tenantId, identifier(decode(incidentMatch[1]!)))); return 200;
  }
  const triageMatch = /^\/v1\/incidents\/([^/]+)\/triage$/.exec(url.pathname);
  if (request.method === "POST" && triageMatch) {
    await emptyObject(request);
    const id = identifier(decode(triageMatch[1]!));
    const key = idempotencyKey(request.headers["idempotency-key"]);
    const reserved = await options.store.reserveTriage(principal, key, id);
    if (reserved.replayed) {
      response.setHeader("idempotency-replayed", "true");
      const replayStatus = reserved.statusCode ?? 200;
      send(response, replayStatus, reserved.body); return replayStatus;
    }
    try {
      const result = await options.analyzer({ runId: reserved.runId!, incident: reserved.incident!, asset: reserved.asset! });
      const completed = await options.store.completeTriage(principal, key, id, result);
      response.setHeader("idempotency-replayed", "false");
      send(response, completed.statusCode, completed.body); return completed.statusCode;
    } catch (error) {
      const code = error instanceof DomainError ? error.code : "triage_failed";
      await options.store.failTriage(principal, key, id, code);
      throw new DomainError(code, error instanceof DomainError ? error.statusCode : 502);
    }
  }
  if (request.method === "GET" && url.pathname === "/v1/audit") {
    send(response, 200, { events: await options.store.auditEvents(principal.tenantId) }); return 200;
  }
  throw new DomainError("route_not_found", 404);
}

function authenticate(request: IncomingMessage, credentials: ReadonlyMap<string, Principal>) {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) throw new DomainError("unauthorized", 401);
  const token = header.slice(7);
  for (const [candidate, principal] of credentials) {
    const left = Buffer.from(token); const right = Buffer.from(candidate);
    if (left.length === right.length && timingSafeEqual(left, right)) return principal;
  }
  throw new DomainError("unauthorized", 401);
}
async function json(request: IncomingMessage) {
  if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) throw new DomainError("content_type_invalid", 415);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length;
    if (size > 64 * 1024) throw new DomainError("request_body_too_large", 413);
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; } catch { throw new DomainError("request_json_invalid", 400); }
}
async function emptyObject(request: IncomingMessage) {
  const body = await json(request);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) throw new DomainError("triage_input_invalid", 400);
}
function send(response: ServerResponse, statusCode: number, body: unknown) {
  if (response.headersSent) return;
  const bytes = Buffer.from(JSON.stringify(body)); response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8"); response.setHeader("content-length", bytes.length);
  response.setHeader("cache-control", "no-store"); response.setHeader("x-content-type-options", "nosniff"); response.end(bytes);
}
function decode(value: string) { try { return decodeURIComponent(value); } catch { throw new DomainError("identifier_invalid", 400); } }
function safePath(value?: string) { try { return new URL(value ?? "/", "http://security.local").pathname; } catch { return "invalid"; } }

export function parseCredentials(value: string): ReadonlyMap<string, Principal> {
  let parsed: unknown; try { parsed = JSON.parse(value); } catch { throw new Error("security_credentials_invalid"); }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("security_credentials_invalid");
  const result = new Map<string, Principal>();
  for (const value of parsed) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("security_credential_invalid");
    const row = value as Record<string, unknown>;
    if (Object.keys(row).sort().join(",") !== "actorId,tenantId,token" ||
        typeof row.token !== "string" || row.token.length < 24 || result.has(row.token)) {
      throw new Error("security_credential_invalid");
    }
    result.set(row.token, { tenantId: identifier(row.tenantId), actorId: identifier(row.actorId) });
  }
  return result;
}
