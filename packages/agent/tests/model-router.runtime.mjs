import assert from "node:assert/strict";
import test from "node:test";

import {
  MODEL_ROUTER_STATE_MAX_BYTES,
  MODEL_ROUTER_STATE_MAX_ENTRIES,
  adaptStatelessModelCallRouter,
  asModelCallRouter,
  createModelRouter,
} from "../dist/model-router.js";

function input(overrides = {}) {
  return {
    callIndex: 0,
    role: "working",
    provider: "openai",
    currentModel: "openai/gpt-start",
    ctxTokens: 123,
    hasImages: false,
    toolErrorStreak: 0,
    ...overrides,
  };
}

function decision(overrides = {}) {
  return {
    model: "openai/gpt-next",
    reason: "test route",
    signals: ["small-context"],
    ...overrides,
  };
}

test("stateful router copies state, commits atomically, and returns immutable decisions", async () => {
  const initial = { count: 0, nested: ["initial"] };
  const controller = new AbortController();
  let emittedState;
  const router = createModelRouter({
    id: "adaptive.v1",
    initialState: initial,
    route(context) {
      assert.equal(Object.isFrozen(context), true);
      assert.equal(Object.isFrozen(context.input), true);
      assert.equal(Object.isFrozen(context.state), true);
      assert.equal(Object.isFrozen(context.state.nested), true);
      assert.equal(context.signal, controller.signal);
      emittedState = { count: context.state.count + 1, nested: ["routed"] };
      return { decision: decision(), state: emittedState };
    },
  });
  initial.count = 99;
  initial.nested[0] = "mutated";

  const selected = await router.route(input(), controller.signal);
  emittedState.count = 99;
  emittedState.nested[0] = "mutated";
  assert.deepEqual(selected, decision());
  assert.equal(Object.isFrozen(selected), true);
  assert.equal(Object.isFrozen(selected.signals), true);

  const first = router.snapshot();
  const second = router.snapshot();
  assert.notEqual(first.state, second.state);
  assert.deepEqual(first, {
    schemaVersion: 1,
    routerId: "adaptive.v1",
    revision: 1,
    state: { count: 1, nested: ["routed"] },
  });
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.state), true);
  assert.throws(() => { first.state.count = 12; }, TypeError);
});

test("router restores only exact matching finite snapshots", async () => {
  const route = ({ state }) => ({ decision: decision(), state: { count: state.count + 1 } });
  const restored = createModelRouter(
    { id: "resume.v1", initialState: { count: 0 }, route },
    { snapshot: { schemaVersion: 1, routerId: "resume.v1", revision: 7, state: { count: 7 } } },
  );
  await restored.route(input());
  assert.deepEqual(restored.snapshot(), {
    schemaVersion: 1,
    routerId: "resume.v1",
    revision: 8,
    state: { count: 8 },
  });
  assert.throws(
    () => createModelRouter(
      { id: "resume.v1", route },
      { snapshot: { schemaVersion: 1, routerId: "other", revision: 0, state: null } },
    ),
    /snapshot_invalid/,
  );
  assert.throws(
    () => createModelRouter(
      { id: "resume.v1", route },
      { snapshot: { schemaVersion: 1, routerId: "resume.v1", revision: 0, state: null, extra: true } },
    ),
    /snapshot_invalid/,
  );
});

test("router serializes transitions and refuses concurrent state races", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const router = createModelRouter({
    id: "serial.v1",
    initialState: 0,
    async route({ state }) {
      await gate;
      return { decision: decision(), state: state + 1 };
    },
  });
  const first = router.route(input());
  await assert.rejects(router.route(input()), /cave_model_router_in_use/);
  release();
  await first;
  assert.equal(router.snapshot().revision, 1);
});

test("aborted route returns promptly and never commits late state", async () => {
  const controller = new AbortController();
  const reason = new Error("cancel route");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let active = 0;
  let maxActive = 0;
  const router = createModelRouter({
    id: "abort.v1",
    initialState: { count: 0 },
    async route({ state }) {
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await gate;
        return { decision: decision(), state: { count: state.count + 1 } };
      } finally {
        active--;
      }
    },
  });
  const pending = router.route(input(), controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  await assert.rejects(router.route(input()), /cave_model_router_in_use/);
  assert.equal(maxActive, 1);
  assert.deepEqual(router.snapshot(), {
    schemaVersion: 1,
    routerId: "abort.v1",
    revision: 0,
    state: { count: 0 },
  });
  release();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    router.route(input(), AbortSignal.abort(reason)),
    (error) => error === reason,
  );
  assert.equal(router.snapshot().revision, 0);
  await router.route(input());
  assert.equal(maxActive, 1);
  assert.equal(router.snapshot().revision, 1);
});

test("stateless compatibility has stable empty state and uses legacy runtime signature", async () => {
  const calls = [];
  const legacy = async (routeInput) => {
    calls.push(routeInput);
    return decision({ signals: [] });
  };
  const router = adaptStatelessModelCallRouter("legacy.v1", legacy);
  const first = await router.route(input());
  const compatible = asModelCallRouter(router);
  const second = await compatible(input({ callIndex: 1 }));
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(calls[0]), true);
  assert.deepEqual(router.snapshot(), {
    schemaVersion: 1,
    routerId: "legacy.v1",
    revision: 0,
    state: null,
  });
  assert.throws(
    () => adaptStatelessModelCallRouter("legacy.v1", null),
    /compat_invalid/,
  );
});

test("route input, transition, and decision objects are exact and bounded", async () => {
  const router = createModelRouter({
    id: "strict.v1",
    route: () => ({ decision: decision(), state: null }),
  });
  await assert.rejects(router.route(input({ permission: "ask" })), /input_invalid/);
  await assert.rejects(router.route(input({ role: "other" })), /input_invalid/);
  await assert.rejects(router.route(input({ currentModel: "anthropic/model" })), /input_invalid/);
  await assert.rejects(router.route(input({ currentModel: "openai/" })), /input_invalid/);
  await assert.rejects(router.route(input({ ctxTokens: Number.POSITIVE_INFINITY })), /input_invalid/);
  await assert.rejects(router.route(input({ previousUsage: undefined })), /previous_usage_invalid/);
  await assert.rejects(
    router.route(input({
      previousUsage: {
        model: "openai/gpt-start",
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        secret: "no",
      },
    })),
    /previous_usage_invalid/,
  );

  const badTransition = createModelRouter({
    id: "bad-transition.v1",
    route: () => ({ decision: decision(), state: null, extra: true }),
  });
  await assert.rejects(badTransition.route(input()), /transition_invalid/);
  const crossProvider = createModelRouter({
    id: "cross-provider.v1",
    route: () => ({ decision: decision({ model: "anthropic/model" }), state: null }),
  });
  await assert.rejects(crossProvider.route(input()), /decision_invalid/);
  const emptyModel = createModelRouter({
    id: "empty-model.v1",
    route: () => ({ decision: decision({ model: "openai/" }), state: null }),
  });
  await assert.rejects(emptyModel.route(input()), /decision_invalid/);
  const duplicateSignal = createModelRouter({
    id: "signals.v1",
    route: () => ({ decision: decision({ signals: ["same", "same"] }), state: null }),
  });
  await assert.rejects(duplicateSignal.route(input()), /decision_invalid/);
});

test("router state refuses oversized, deep, dense-over-limit, cyclic, sparse, and non-JSON data", () => {
  assert.throws(
    () => createModelRouter({
      id: "bytes.v1",
      initialState: "x".repeat(MODEL_ROUTER_STATE_MAX_BYTES),
      route: () => ({ decision: decision(), state: null }),
    }),
    /finite_json_bytes_limit/,
  );

  let deep = null;
  for (let index = 0; index < 17; index++) deep = { nested: deep };
  assert.throws(
    () => createModelRouter({ id: "depth.v1", initialState: deep, route: () => ({ decision: decision(), state: null }) }),
    /finite_json_depth_limit/,
  );
  assert.throws(
    () => createModelRouter({
      id: "entries.v1",
      initialState: Array(MODEL_ROUTER_STATE_MAX_ENTRIES).fill(null),
      route: () => ({ decision: decision(), state: null }),
    }),
    /finite_json_entries_limit/,
  );
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => createModelRouter({ id: "cycle.v1", initialState: cyclic, route: () => ({ decision: decision(), state: null }) }),
    /finite_json_cycle/,
  );
  assert.throws(
    () => createModelRouter({ id: "sparse.v1", initialState: new Array(2), route: () => ({ decision: decision(), state: null }) }),
    /finite_json_non_json/,
  );
  assert.throws(
    () => createModelRouter({ id: "date.v1", initialState: new Date(), route: () => ({ decision: decision(), state: null }) }),
    /finite_json_non_json/,
  );
  const accessor = {};
  Object.defineProperty(accessor, "secret", { enumerable: true, get: () => "read" });
  assert.throws(
    () => createModelRouter({ id: "getter.v1", initialState: accessor, route: () => ({ decision: decision(), state: null }) }),
    /finite_json_non_json/,
  );
});

test("router definitions reject unknown policy-shaped fields and invalid ids", async () => {
  assert.throws(
    () => createModelRouter({
      id: "valid.v1",
      route: () => ({ decision: decision(), state: null }),
      approval: "ask",
    }),
    /definition_invalid/,
  );
  assert.throws(
    () => createModelRouter({ id: "bad id", route: () => ({ decision: decision(), state: null }) }),
    /definition_invalid/,
  );
  assert.throws(
    () => createModelRouter({
      id: "undefined-state.v1",
      initialState: undefined,
      route: () => ({ decision: decision(), state: null }),
    }),
    /finite_json_non_json/,
  );
  const exhausted = createModelRouter(
    { id: "exhausted.v1", route: () => ({ decision: decision(), state: null }) },
    { snapshot: {
      schemaVersion: 1,
      routerId: "exhausted.v1",
      revision: Number.MAX_SAFE_INTEGER,
      state: null,
    } },
  );
  await assert.rejects(exhausted.route(input()), /revision_exhausted/);
});

test("router ignores inherited definitions and optional state", () => {
  const previousInitialState = Object.getOwnPropertyDescriptor(Object.prototype, "initialState");
  const previousRoute = Object.getOwnPropertyDescriptor(Object.prototype, "route");
  const previousToJSON = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
  let toJSONCalls = 0;
  Object.defineProperty(Object.prototype, "initialState", {
    configurable: true,
    enumerable: false,
    value: { polluted: true },
  });
  Object.defineProperty(Object.prototype, "route", {
    configurable: true,
    enumerable: false,
    value: () => ({ decision: decision(), state: null }),
  });
  Object.defineProperty(Object.prototype, "toJSON", {
    configurable: true,
    enumerable: false,
    value: () => { toJSONCalls++; return null; },
  });
  try {
    const router = createModelRouter({
      id: "own-route.v1",
      route: () => ({ decision: decision(), state: null }),
    });
    assert.equal(router.snapshot().state, null);
    const stateful = createModelRouter({
      id: "safe-json.v1",
      initialState: { count: 1 },
      route: () => ({ decision: decision(), state: null }),
    });
    assert.equal(stateful.snapshot().state.count, 1);
    assert.throws(
      () => createModelRouter({
        id: "safe-json-limit.v1",
        initialState: { payload: "x".repeat(MODEL_ROUTER_STATE_MAX_BYTES - "payload".length) },
        route: () => ({ decision: decision(), state: null }),
      }),
      /cave_finite_json_bytes_limit/,
    );
    assert.equal(toJSONCalls, 0);
    assert.throws(() => createModelRouter({ id: "missing-route.v1" }), /definition_invalid/);
  } finally {
    if (previousInitialState === undefined) delete Object.prototype.initialState;
    else Object.defineProperty(Object.prototype, "initialState", previousInitialState);
    if (previousRoute === undefined) delete Object.prototype.route;
    else Object.defineProperty(Object.prototype, "route", previousRoute);
    if (previousToJSON === undefined) delete Object.prototype.toJSON;
    else Object.defineProperty(Object.prototype, "toJSON", previousToJSON);
  }
});
