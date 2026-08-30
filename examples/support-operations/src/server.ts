import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import {
  DomainError,
  idempotencyKey,
  identifier,
  validateCaseInput,
  type Principal,
  type SupportAnalyzer,
} from "./domain.js";
import { FileSupportStore } from "./store.js";

const MAX_BODY_BYTES = 64 * 1024;

export interface SupportServerOptions {
  store: FileSupportStore;
  analyzer: SupportAnalyzer;
  credentials: ReadonlyMap<string, Principal>;
  logger?: (event: Readonly<Record<string, unknown>>) => void;
}

export function createSupportServer(options: SupportServerOptions): Server {
  const logger = options.logger ?? ((event) => process.stdout.write(`${JSON.stringify(event)}\n`));
  return createServer(async (request, response) => {
    const startedAt = performance.now();
    const requestId = request.headers["x-request-id"]?.toString().slice(0, 96) ?? "unassigned";
    let statusCode = 500;
    let errorCode: string | undefined;
    try {
      statusCode = await route(request, response, options);
    } catch (error) {
      const failure = toHTTPError(error);
      statusCode = failure.statusCode;
      errorCode = failure.code;
      sendJSON(response, statusCode, { error: { code: failure.code, requestId } });
    } finally {
      logger({
        event: "request_complete",
        requestId,
        method: request.method,
        path: safePath(request.url),
        statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...(errorCode === undefined ? {} : { errorCode }),
      });
    }
  });
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  options: SupportServerOptions,
): Promise<number> {
  const url = new URL(request.url ?? "/", "http://support.local");
  if (request.method === "GET" && url.pathname === "/healthz") {
    sendJSON(response, 200, { status: "ok" });
    return 200;
  }
  if (request.method === "GET" && url.pathname === "/readyz") {
    const readiness = await options.store.readiness();
    sendJSON(response, 200, readiness);
    return 200;
  }
  const principal = authenticate(request, options.credentials);
  if (request.method === "POST" && url.pathname === "/v1/cases") {
    const key = idempotencyKey(request.headers["idempotency-key"]);
    const result = await options.store.createCase(principal, key, validateCaseInput(await readJSON(request)));
    response.setHeader("idempotency-replayed", String(result.replayed));
    sendJSON(response, result.statusCode, result.body);
    return result.statusCode;
  }
  const caseMatch = /^\/v1\/cases\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && caseMatch) {
    const supportCase = await options.store.getCase(principal.tenantId, safeResourceID(caseMatch[1]!));
    sendJSON(response, 200, supportCase);
    return 200;
  }
  const analysisMatch = /^\/v1\/cases\/([^/]+)\/analyses$/.exec(url.pathname);
  if (request.method === "POST" && analysisMatch) {
    const caseId = safeResourceID(analysisMatch[1]!);
    const key = idempotencyKey(request.headers["idempotency-key"]);
    await requireEmptyObject(request);
    const reserved = await options.store.reserveAnalysis(principal, key, caseId);
    if (reserved.replayed) {
      response.setHeader("idempotency-replayed", "true");
      sendJSON(response, reserved.statusCode ?? 200, reserved.body);
      return reserved.statusCode ?? 200;
    }
    try {
      const analysis = await options.analyzer({
        runId: reserved.runId!,
        supportCase: reserved.supportCase!,
        order: reserved.order!,
      });
      const completed = await options.store.completeAnalysis(principal, key, caseId, analysis);
      response.setHeader("idempotency-replayed", "false");
      sendJSON(response, completed.statusCode, completed.body);
      return completed.statusCode;
    } catch (error) {
      const code = error instanceof DomainError ? error.code : "agent_analysis_failed";
      await options.store.failAnalysis(principal, key, caseId, code);
      throw new DomainError(code, error instanceof DomainError ? error.statusCode : 502);
    }
  }
  if (request.method === "GET" && url.pathname === "/v1/audit") {
    const caseId = url.searchParams.get("caseId") ?? undefined;
    const events = await options.store.auditEvents(
      principal.tenantId,
      caseId === undefined ? undefined : safeResourceID(caseId),
    );
    sendJSON(response, 200, { events });
    return 200;
  }
  throw new DomainError("route_not_found", 404);
}

function authenticate(request: IncomingMessage, credentials: ReadonlyMap<string, Principal>): Principal {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    throw new DomainError("unauthorized", 401);
  }
  const token = authorization.slice(7);
  if (token.length < 16 || token.length > 512) throw new DomainError("unauthorized", 401);
  for (const [candidate, principal] of credentials) {
    if (constantTimeEqual(token, candidate)) return principal;
  }
  throw new DomainError("unauthorized", 401);
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

async function readJSON(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
    throw new DomainError("content_type_invalid", 415);
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_BODY_BYTES) throw new DomainError("request_body_too_large", 413);
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DomainError("request_json_invalid", 400);
  }
}

async function requireEmptyObject(request: IncomingMessage): Promise<void> {
  const body = await readJSON(request);
  if (body === null || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
    throw new DomainError("analysis_input_invalid", 400);
  }
}

function sendJSON(response: ServerResponse, statusCode: number, body: unknown): void {
  if (response.headersSent) return;
  const payload = Buffer.from(JSON.stringify(body));
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", payload.length);
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(payload);
}

function toHTTPError(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  return new DomainError("internal_error", 500);
}

function safeResourceID(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new DomainError("resource_id_invalid", 400);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(decoded)) {
    throw new DomainError("resource_id_invalid", 400);
  }
  return decoded;
}

function safePath(raw: string | undefined): string {
  try {
    return new URL(raw ?? "/", "http://support.local").pathname;
  } catch {
    return "invalid";
  }
}

export function parseCredentials(value: string): ReadonlyMap<string, Principal> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("support_credentials_json_invalid");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("support_credentials_empty");
  }
  const result = new Map<string, Principal>();
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("support_credential_invalid");
    }
    const row = entry as Record<string, unknown>;
    if (Object.keys(row).sort().join(",") !== "actorId,tenantId,token" ||
        typeof row.token !== "string" || row.token.length < 24 || result.has(row.token)) {
      throw new Error("support_credential_invalid");
    }
    result.set(row.token, {
      tenantId: identifier(row.tenantId, "support_credential_tenant_invalid"),
      actorId: identifier(row.actorId, "support_credential_actor_invalid"),
    });
  }
  return result;
}
