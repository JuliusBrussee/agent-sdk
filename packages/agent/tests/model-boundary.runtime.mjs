import assert from "node:assert/strict";
import test from "node:test";

import {
  MODEL_BOUNDARY_MAX_MIDDLEWARE,
  captureModelBoundary,
  createModelBoundary,
} from "../dist/model-boundary.js";

function context(signal = new AbortController().signal) {
  return {
    identity: {
      runId: "run-1",
      stepId: "step-1",
      modelCallId: "call-1",
      attempt: 1,
      replay: false,
      nativeIds: {},
    },
    role: "working",
    provider: "openai",
    model: "openai/gpt-test",
    signal,
  };
}

test("model boundary prepares forward, settles backward, and exposes no provider continuation", async () => {
  const order = [];
  const controller = new AbortController();
  const seenSignals = [];
  const first = {
    id: "first",
    prepare(input) {
      order.push("first.prepare");
      seenSignals.push(input.context.signal);
      assert.equal(Object.isFrozen(input), true);
      assert.equal(Object.isFrozen(input.context), true);
      assert.deepEqual(Object.keys(input).sort(), ["context", "request"]);
      return { value: input.request.value + 1 };
    },
    settled(input) {
      order.push("first.settled");
      seenSignals.push(input.context.signal);
      assert.equal(Object.isFrozen(input), true);
    },
  };
  const second = {
    id: "second",
    prepare(input) {
      order.push("second.prepare");
      return { value: input.request.value * 2 };
    },
    settled() {
      order.push("second.settled");
    },
  };
  const boundary = createModelBoundary([first, second]);
  first.prepare = () => ({ value: 999 });

  const boundaryContext = context(controller.signal);
  const call = await boundary.prepare({ value: 1 }, boundaryContext);
  boundaryContext.identity.modelCallId = "mutated";
  assert.deepEqual(call.request, { value: 4 });
  assert.equal(call.context.identity.modelCallId, "call-1");
  assert.equal(Object.isFrozen(call.context.identity), true);
  assert.equal(call.context.signal, controller.signal);
  assert.equal(Object.isFrozen(call), true);
  assert.deepEqual(boundary.middlewareIds, ["first", "second"]);
  assert.equal(Object.isFrozen(boundary.middlewareIds), true);
  const response = { text: "done" };
  assert.equal(await call.settled(response), response);
  assert.deepEqual(order, [
    "first.prepare",
    "second.prepare",
    "second.settled",
    "first.settled",
  ]);
  assert.deepEqual(seenSignals, [controller.signal, controller.signal]);
  await assert.rejects(call.failed(new Error("late")), /cave_model_boundary_terminal_reused/);
});

test("model boundary failure observers unwind in reverse and rethrow original failure", async () => {
  const order = [];
  const failure = new Error("provider failed");
  const boundary = createModelBoundary([
    {
      id: "first",
      prepare: (input) => ({ ...input.request, first: true }),
      failed(input) {
        order.push("first.failed");
        assert.equal(input.error, failure);
        assert.equal(input.request.second, true);
      },
    },
    {
      id: "second",
      prepare: (input) => ({ ...input.request, second: true }),
      failed(input) {
        order.push("second.failed");
        assert.equal(input.error, failure);
      },
    },
  ]);
  const call = await boundary.prepare({}, context());
  await assert.rejects(call.failed(failure), (error) => error === failure);
  assert.deepEqual(order, ["second.failed", "first.failed"]);
});

test("prepare failures unwind only entered middleware and preserve the exact failure", async () => {
  const order = [];
  const prepareFailure = new Error("prepare failed");
  const cleanupFailure = new Error("cleanup failed");
  const boundary = createModelBoundary([
    {
      id: "first",
      failed() {
        order.push("first.failed");
      },
    },
    {
      id: "second",
      prepare() {
        order.push("second.prepare");
        throw prepareFailure;
      },
      failed() {
        order.push("second.failed");
        throw cleanupFailure;
      },
    },
    {
      id: "never-entered",
      failed() {
        order.push("never.failed");
      },
    },
  ]);
  await assert.rejects(
    boundary.prepare({}, context()),
    (error) => error === prepareFailure,
  );
  assert.deepEqual(order, ["second.prepare", "second.failed", "first.failed"]);
});

test("settlement observers are best-effort and cannot replace native success", async () => {
  const order = [];
  const response = { text: "native response" };
  const boundary = createModelBoundary([
    { id: "one", settled() { order.push("one"); throw new Error("one"); } },
    { id: "two", async settled() { order.push("two"); throw new Error("two"); } },
  ]);
  const call = await boundary.prepare("request", context());
  assert.equal(await call.settled(response), response);
  assert.deepEqual(order, ["two", "one"]);
});

test("failure observers are best-effort and cannot replace native failure", async () => {
  const order = [];
  const nativeFailure = new Error("native model failure");
  const boundary = createModelBoundary([
    { id: "one", failed() { order.push("one"); throw new Error("observer one"); } },
    { id: "two", async failed() { order.push("two"); throw new Error("observer two"); } },
  ]);
  const call = await boundary.prepare("request", context());
  await assert.rejects(call.failed(nativeFailure), (error) => error === nativeFailure);
  assert.deepEqual(order, ["two", "one"]);
});

test("terminal observer cancellation cannot replace native outcomes", async () => {
  const successAbort = new AbortController();
  const successAbortReason = new Error("observer canceled");
  const response = { text: "native response" };
  const successBoundary = createModelBoundary([{
    id: "hung-success-observer",
    settled() {
      successAbort.abort(successAbortReason);
      return new Promise(() => {});
    },
  }]);
  const successCall = await successBoundary.prepare("request", context(successAbort.signal));
  assert.equal(await successCall.settled(response), response);

  const failureAbort = new AbortController();
  const nativeFailure = new Error("native model failure");
  let failureObserverCalled = false;
  const failureBoundary = createModelBoundary([{
    id: "canceled-failure-observer",
    failed() {
      failureObserverCalled = true;
      return new Promise(() => {});
    },
  }]);
  const failureCall = await failureBoundary.prepare("request", context(failureAbort.signal));
  failureAbort.abort(new Error("caller canceled"));
  await assert.rejects(failureCall.failed(nativeFailure), (error) => error === nativeFailure);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failureObserverCalled, true);
});

test("never-settling terminal observers cannot delay native outcomes", async () => {
  const order = [];
  const never = () => new Promise(() => {});
  const boundary = createModelBoundary([
    {
      id: "first",
      settled() { order.push("first.settled"); return never(); },
      failed() { order.push("first.failed"); return never(); },
    },
    {
      id: "second",
      settled() { order.push("second.settled"); return never(); },
      failed() { order.push("second.failed"); return never(); },
    },
  ]);
  const successCall = await boundary.prepare("request", context());
  const response = { text: "native response" };
  const pendingSentinel = Symbol("pending");
  const successOutcome = await Promise.race([
    successCall.settled(response),
    new Promise((resolve) => setImmediate(() => resolve(pendingSentinel))),
  ]);
  assert.equal(successOutcome, response);
  assert.deepEqual(order, ["second.settled", "first.settled"]);

  order.length = 0;
  const failureCall = await boundary.prepare("request", context());
  const failure = new Error("native failure");
  const failureOutcome = await Promise.race([
    failureCall.failed(failure).then(
      () => new Error("unexpected native success"),
      (error) => error,
    ),
    new Promise((resolve) => setImmediate(() => resolve(pendingSentinel))),
  ]);
  assert.equal(failureOutcome, failure);
  assert.deepEqual(order, ["second.failed", "first.failed"]);
});

test("abort during prepare unwinds entered middleware with same signal", async () => {
  const controller = new AbortController();
  const reason = new Error("stop");
  let failedSignal;
  const boundary = createModelBoundary([
    {
      id: "aborter",
      prepare(input) {
        assert.equal(input.context.signal, controller.signal);
        controller.abort(reason);
      },
      failed(input) {
        failedSignal = input.context.signal;
      },
    },
    { id: "never" },
  ]);
  await assert.rejects(boundary.prepare({}, context(controller.signal)), (error) => error === reason);
  assert.equal(failedSignal, controller.signal);
});

test("pending prepare returns on abort even when middleware ignores signal", async () => {
  const controller = new AbortController();
  const reason = new Error("cancel pending prepare");
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const boundary = createModelBoundary([{
    id: "hung",
    prepare() {
      entered();
      return new Promise(() => {});
    },
  }]);
  const pending = boundary.prepare({}, context(controller.signal));
  await started;
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
});

test("model boundary rejects duplicate, unbounded, accessor, excess, and unknown middleware", () => {
  assert.throws(
    () => createModelBoundary([{ id: "same" }, { id: "same" }]),
    /cave_model_boundary_middleware_duplicate:same/,
  );
  assert.throws(() => createModelBoundary([{ id: "bad id" }]), /middleware_id_invalid/);
  assert.throws(
    () => createModelBoundary([{ id: "valid", permission: "ask" }]),
    /middleware_invalid/,
  );
  const accessor = {};
  Object.defineProperty(accessor, "id", { enumerable: true, get: () => "getter" });
  assert.throws(() => createModelBoundary([accessor]), /middleware_invalid/);
  assert.throws(
    () => createModelBoundary(Array.from(
      { length: MODEL_BOUNDARY_MAX_MIDDLEWARE + 1 },
      (_, index) => ({ id: `m-${index}` }),
    )),
    /middleware_array_invalid/,
  );
  assert.throws(
    () => createModelBoundary(new Array(1)),
    /middleware_array_invalid/,
  );
  const overridden = [{ id: "valid" }];
  overridden.map = () => [{ id: "bypass", prepare: "not-a-function" }];
  assert.throws(() => createModelBoundary(overridden), /middleware_array_invalid/);
});

test("middleware fields must be own data properties despite prototype pollution", async () => {
  const previousId = Object.getOwnPropertyDescriptor(Object.prototype, "id");
  const previousPrepare = Object.getOwnPropertyDescriptor(Object.prototype, "prepare");
  Object.defineProperty(Object.prototype, "id", {
    configurable: true,
    enumerable: false,
    value: "polluted",
  });
  Object.defineProperty(Object.prototype, "prepare", {
    configurable: true,
    enumerable: false,
    value: () => { throw new Error("inherited prepare executed"); },
  });
  try {
    assert.throws(() => createModelBoundary([{}]), /middleware_invalid/);
    const call = await createModelBoundary([{ id: "own" }]).prepare({}, context());
    assert.deepEqual(call.request, {});
  } finally {
    if (previousId === undefined) delete Object.prototype.id;
    else Object.defineProperty(Object.prototype, "id", previousId);
    if (previousPrepare === undefined) delete Object.prototype.prepare;
    else Object.defineProperty(Object.prototype, "prepare", previousPrepare);
  }
});

test("model boundary context is closed and bounded", async () => {
  const boundary = createModelBoundary([]);
  await assert.rejects(
    boundary.prepare({}, { ...context(), permission: "ask" }),
    /cave_model_boundary_context_invalid/,
  );
  await assert.rejects(
    boundary.prepare({}, { ...context(), callId: "parallel-call-id" }),
    /cave_model_boundary_context_invalid/,
  );
  await assert.rejects(
    boundary.prepare({}, { ...context(), signal: {} }),
    /cave_model_boundary_context_invalid/,
  );
  await assert.rejects(
    boundary.prepare({}, {
      ...context(),
      identity: { ...context().identity, modelCallId: undefined },
    }),
    /cave_model_boundary_context_invalid/,
  );
  await assert.rejects(
    boundary.prepare({}, {
      ...context(),
      identity: { ...context().identity, runId: "bad run id" },
    }),
    /cave_model_boundary_context_invalid/,
  );
});

test("captured boundary preserves receivers and observes exactly one terminal outcome", async () => {
  const responses = [];
  const failures = [];
  const preparedRequest = { transformed: true };
  const prepared = {
    marker: "prepared-receiver",
    request: preparedRequest,
    settled(response) {
      assert.equal(this.marker, "prepared-receiver");
      responses.push(response);
      return Promise.reject(new Error("diagnostic settlement failure"));
    },
    failed(error) {
      assert.equal(this.marker, "prepared-receiver");
      failures.push(error);
    },
  };
  const boundary = {
    marker: "boundary-receiver",
    prepare(request, boundaryContext) {
      assert.equal(this.marker, "boundary-receiver");
      assert.equal(request.original, true);
      assert.equal(boundaryContext.identity.modelCallId, "call-1");
      return prepared;
    },
  };
  const captured = captureModelBoundary(boundary);
  const call = await captured.prepare({ original: true }, context());
  prepared.request = { mutated: true };
  prepared.settled = () => { throw new Error("late mutation executed"); };
  assert.equal(call.request, preparedRequest);

  const response = { native: true };
  call.settled(response);
  call.failed(new Error("late failure"));
  call.settled({ duplicate: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(responses, [response]);
  assert.deepEqual(failures, []);

  const failedCall = await captured.prepare({ original: true }, context());
  const failure = new Error("native failure");
  failedCall.failed(failure);
  failedCall.failed(new Error("duplicate"));
  failedCall.settled(response);
  assert.deepEqual(failures, [failure]);
});

test("captured boundary accepts only own data methods without executing getters", async () => {
  let getterCalls = 0;
  const inherited = Object.create({ prepare() {} });
  assert.throws(
    () => captureModelBoundary(inherited),
    /cave_model_boundary_consumer_invalid/,
  );
  const accessorBoundary = {};
  Object.defineProperty(accessorBoundary, "prepare", {
    get() {
      getterCalls += 1;
      return () => undefined;
    },
  });
  assert.throws(
    () => captureModelBoundary(accessorBoundary),
    /cave_model_boundary_consumer_invalid/,
  );

  for (const key of ["request", "settled", "failed"]) {
    const prepared = {
      request: {},
      settled() {},
      failed() {},
    };
    Object.defineProperty(prepared, key, {
      configurable: true,
      get() {
        getterCalls += 1;
        return key === "request" ? {} : () => undefined;
      },
    });
    const captured = captureModelBoundary({ prepare: () => prepared });
    await assert.rejects(
      captured.prepare({}, context()),
      /cave_model_boundary_consumer_call_invalid/,
    );
  }
  assert.equal(getterCalls, 0);
});
