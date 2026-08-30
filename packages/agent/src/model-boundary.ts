import {
  defineAdapterLifecycleIdentity,
  type AdapterLifecycleIdentity,
} from "@caveman-ai/adapter-kit";
import { snapshotDataRecord, snapshotDenseArray } from "./strict-data.js";
import { abortable } from "./async-boundary.js";

export const MODEL_BOUNDARY_MAX_MIDDLEWARE = 64;
export const MODEL_BOUNDARY_MAX_ID_LENGTH = 64;
export const MODEL_BOUNDARY_MAX_CONTEXT_STRING_LENGTH = 512;

export type ModelBoundaryRole = "working" | "compaction";

export interface ModelBoundaryContext {
  readonly identity: AdapterLifecycleIdentity & { readonly modelCallId: string };
  readonly role: ModelBoundaryRole;
  readonly provider: string;
  readonly model: string;
  readonly signal: AbortSignal;
}

export interface ModelBoundaryPrepare<Request> {
  readonly request: Request;
  readonly context: ModelBoundaryContext;
}

export interface ModelBoundarySettled<Request, Response> {
  readonly request: Request;
  readonly response: Response;
  readonly context: ModelBoundaryContext;
}

export interface ModelBoundaryFailed<Request> {
  readonly request: Request;
  readonly error: unknown;
  readonly context: ModelBoundaryContext;
}

/**
 * Model middleware transforms a request before provider I/O and observes one
 * terminal outcome. It deliberately receives no `next` callback or provider
 * function: only the owning runtime may perform model I/O.
 */
export interface ModelBoundaryMiddleware<Request, Response> {
  readonly id: string;
  readonly prepare?: (
    input: ModelBoundaryPrepare<Request>,
  ) => Request | undefined | Promise<Request | undefined>;
  readonly settled?: (
    input: ModelBoundarySettled<Request, Response>,
  ) => void | Promise<void>;
  readonly failed?: (
    input: ModelBoundaryFailed<Request>,
  ) => void | Promise<void>;
}

export interface PreparedModelBoundaryCall<Request, Response> {
  readonly request: Request;
  readonly context: ModelBoundaryContext;
  /** Best-effort observation; always returns the native response unchanged. */
  settled(response: Response): Promise<Response>;
  /** Best-effort observation; always throws the exact native failure. */
  failed(error: unknown): Promise<never>;
}

export interface ModelBoundary<Request, Response> {
  readonly middlewareIds: readonly string[];
  prepare(
    request: Request,
    context: ModelBoundaryContext,
  ): Promise<PreparedModelBoundaryCall<Request, Response>>;
}

/** Host-side, hostile-safe view of one configured model boundary. */
export interface CapturedModelBoundary<Request, Response> {
  prepare(
    request: Request,
    context: ModelBoundaryContext,
  ): Promise<CapturedModelBoundaryCall<Request, Response>>;
}

/**
 * A prepared call whose terminal observer is diagnostic-only and can fire at
 * most once. The host retains provider I/O and native result ownership.
 */
export interface CapturedModelBoundaryCall<Request, Response> {
  readonly request: Request;
  settled(response: Response): void;
  failed(error: unknown): void;
}

type FrozenMiddleware<Request, Response> = Readonly<{
  id: string;
  prepare: ModelBoundaryMiddleware<Request, Response>["prepare"] | undefined;
  settled: ModelBoundaryMiddleware<Request, Response>["settled"] | undefined;
  failed: ModelBoundaryMiddleware<Request, Response>["failed"] | undefined;
}>;

const MIDDLEWARE_KEYS = Object.freeze(["id", "prepare", "settled", "failed"]);
const MIDDLEWARE_REQUIRED_KEYS = Object.freeze(["id"]);
const CONTEXT_KEYS = Object.freeze(["identity", "role", "provider", "model", "signal"]);
const IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/;

/**
 * Capture an optional boundary once at an adapter trust boundary.
 *
 * Only own data properties are accepted, so inherited methods and accessors
 * never execute. The boundary and prepared-call receivers are preserved while
 * terminal observation stays best-effort and exactly-once.
 */
export function captureModelBoundary<Request, Response>(
  value: ModelBoundary<Request, Response> | undefined,
): CapturedModelBoundary<Request, Response> | undefined {
  if (value === undefined) return undefined;
  const prepare = ownMethod(value, "prepare", "cave_model_boundary_consumer_invalid");
  const consumer: CapturedModelBoundary<Request, Response> = {
    async prepare(request, context) {
      const prepared = await Reflect.apply(prepare, value, [request, context]);
      return capturePreparedCall<Request, Response>(prepared);
    },
  };
  return Object.freeze(consumer);
}

export function createModelBoundary<Request, Response>(
  middleware: readonly ModelBoundaryMiddleware<Request, Response>[],
): ModelBoundary<Request, Response> {
  const middlewareSnapshot = snapshotDenseArray(
    middleware,
    MODEL_BOUNDARY_MAX_MIDDLEWARE,
    () => { throw new Error("cave_model_boundary_middleware_array_invalid"); },
  );

  const seen = new Set<string>();
  const frozenMiddleware: FrozenMiddleware<Request, Response>[] = [];
  for (let index = 0; index < middlewareSnapshot.length; index++) {
    const candidate = snapshotDataRecord(
      middlewareSnapshot[index],
      MIDDLEWARE_KEYS,
      MIDDLEWARE_REQUIRED_KEYS,
      () => { throw new Error(`cave_model_boundary_middleware_invalid:${index}`); },
    );
    const id = candidate["id"];
    if (typeof id !== "string" || id.length > MODEL_BOUNDARY_MAX_ID_LENGTH || !IDENTIFIER.test(id)) {
      throw new Error(`cave_model_boundary_middleware_id_invalid:${index}`);
    }
    if (seen.has(id)) throw new Error(`cave_model_boundary_middleware_duplicate:${id}`);
    seen.add(id);

    for (const hook of ["prepare", "settled", "failed"] as const) {
      const value = Object.hasOwn(candidate, hook) ? candidate[hook] : undefined;
      if (value !== undefined && typeof value !== "function") {
        throw new Error(`cave_model_boundary_middleware_hook_invalid:${id}:${hook}`);
      }
    }

    const prepare = Object.hasOwn(candidate, "prepare")
      ? candidate["prepare"] as FrozenMiddleware<Request, Response>["prepare"]
      : undefined;
    const settled = Object.hasOwn(candidate, "settled")
      ? candidate["settled"] as FrozenMiddleware<Request, Response>["settled"]
      : undefined;
    const failed = Object.hasOwn(candidate, "failed")
      ? candidate["failed"] as FrozenMiddleware<Request, Response>["failed"]
      : undefined;
    const copy: FrozenMiddleware<Request, Response> = {
      id,
      prepare,
      settled,
      failed,
    };
    frozenMiddleware.push(Object.freeze(copy));
  }
  Object.freeze(frozenMiddleware);
  const mutableIds: string[] = [];
  for (const item of frozenMiddleware) mutableIds.push(item.id);
  const middlewareIds = Object.freeze(mutableIds);

  const boundary: ModelBoundary<Request, Response> = {
    middlewareIds,
    async prepare(request: Request, context: ModelBoundaryContext) {
      const frozenContext = normalizeContext(context);
      const active: FrozenMiddleware<Request, Response>[] = [];
      let current = request;
      try {
        throwIfAborted(frozenContext.signal);
        for (const item of frozenMiddleware) {
          active.push(item);
          if (item.prepare !== undefined) {
            const input = Object.freeze({ request: current, context: frozenContext });
            const prepared = await abortable(
              Promise.resolve().then(() => item.prepare!(input)),
              frozenContext.signal,
              () => boundaryAbortError(frozenContext.signal),
            );
            if (prepared !== undefined) current = prepared;
          }
          throwIfAborted(frozenContext.signal);
        }
      } catch (error) {
        throwAfterFailureObservers(active, current, frozenContext, error);
      }

      let terminal = false;
      const requireOpen = (): void => {
        if (terminal) throw new Error("cave_model_boundary_terminal_reused");
        terminal = true;
      };
      const preparedCall: PreparedModelBoundaryCall<Request, Response> = {
        request: current,
        context: frozenContext,
        async settled(response) {
          requireOpen();
          for (let index = active.length - 1; index >= 0; index--) {
            const hook = active[index]?.settled;
            if (hook === undefined) continue;
            const input = Object.freeze({ request: current, response, context: frozenContext });
            observeBestEffort(() => hook(input));
          }
          return response;
        },
        async failed(error) {
          requireOpen();
          throwAfterFailureObservers(active, current, frozenContext, error);
        },
      };
      return Object.freeze(preparedCall);
    },
  };
  return Object.freeze(boundary);
}

function throwAfterFailureObservers<Request, Response>(
  active: readonly FrozenMiddleware<Request, Response>[],
  request: Request,
  context: ModelBoundaryContext,
  failure: unknown,
): never {
  for (let index = active.length - 1; index >= 0; index--) {
    const hook = active[index]?.failed;
    if (hook === undefined) continue;
    const input = Object.freeze({ request, error: failure, context });
    observeBestEffort(() => hook(input));
  }
  throw failure;
}

function observeBestEffort(observe: () => void | Promise<void>): void {
  try {
    void Promise.resolve(observe()).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    // Terminal observation is diagnostic-only and cannot control host outcome.
  }
}

function capturePreparedCall<Request, Response>(
  value: unknown,
): CapturedModelBoundaryCall<Request, Response> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("cave_model_boundary_consumer_call_invalid");
  }
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new Error("cave_model_boundary_consumer_call_invalid");
  }
  const request = descriptors["request"];
  const settled = descriptors["settled"];
  const failed = descriptors["failed"];
  if (request === undefined || !("value" in request) ||
      settled === undefined || !("value" in settled) || typeof settled.value !== "function" ||
      failed === undefined || !("value" in failed) || typeof failed.value !== "function") {
    throw new Error("cave_model_boundary_consumer_call_invalid");
  }

  let terminal = false;
  const observeOnce = (method: (...args: unknown[]) => unknown, input: unknown): void => {
    if (terminal) return;
    terminal = true;
    observeBestEffort(() => Reflect.apply(method, value, [input]) as void | Promise<void>);
  };
  return Object.freeze({
    request: request.value as Request,
    settled(response: Response): void {
      observeOnce(settled.value as (...args: unknown[]) => unknown, response);
    },
    failed(error: unknown): void {
      observeOnce(failed.value as (...args: unknown[]) => unknown, error);
    },
  });
}

function ownMethod(value: unknown, key: string, code: string): (...args: unknown[]) => unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(code);
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new Error(code);
  }
  if (descriptor === undefined || !("value" in descriptor) ||
      typeof descriptor.value !== "function") {
    throw new Error(code);
  }
  return descriptor.value as (...args: unknown[]) => unknown;
}

function normalizeContext(context: ModelBoundaryContext): ModelBoundaryContext {
  const snapshot = snapshotDataRecord(
    context,
    CONTEXT_KEYS,
    CONTEXT_KEYS,
    () => { throw new Error("cave_model_boundary_context_invalid"); },
  );
  let identity: AdapterLifecycleIdentity;
  try {
    identity = defineAdapterLifecycleIdentity(
      snapshot["identity"] as AdapterLifecycleIdentity,
    );
  } catch {
    throw new Error("cave_model_boundary_context_invalid");
  }
  if (identity.modelCallId === undefined ||
      (snapshot["role"] !== "working" && snapshot["role"] !== "compaction") ||
      !isBoundedString(snapshot["provider"]) ||
      !isBoundedString(snapshot["model"]) ||
      !(snapshot["signal"] instanceof AbortSignal)) {
    throw new Error("cave_model_boundary_context_invalid");
  }
  return Object.freeze({
    identity: identity as ModelBoundaryContext["identity"],
    role: snapshot["role"],
    provider: snapshot["provider"],
    model: snapshot["model"],
    signal: snapshot["signal"],
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw boundaryAbortError(signal);
}

function boundaryAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("cave_model_boundary_aborted");
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" &&
    value.length <= MODEL_BOUNDARY_MAX_CONTEXT_STRING_LENGTH;
}
