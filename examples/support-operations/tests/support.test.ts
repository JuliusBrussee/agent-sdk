import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { createSupportAgent, createSupportAnalyzer } from "../src/agent.js";
import { validateOrder, type Principal, type SupportProposal } from "../src/domain.js";
import { createSupportServer } from "../src/server.js";
import { FileSupportStore } from "../src/store.js";

const CASE_TOKEN = "case-token-northwind-0000000001";
const OTHER_TOKEN = "case-token-contoso-00000000001";

const refundProposal: SupportProposal = {
  disposition: "refund_review",
  summary: "Delivered order reported damaged within policy window.",
  replyDraft: "I found order NW-1042. A refund proposal is ready for downstream review.",
  confidence: "high",
  policyEvidence: ["refund-eu-v3"],
  refundAmountUsd: 89,
  escalationReason: null,
};

test("service records tenant-safe idempotent proposal handoff without execution", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cave-support-example-"));
  const store = new FileSupportStore(join(root, "state.json"));
  await store.initialize(seedOrders());

  const faux = fauxProvider({ provider: "anthropic" });
  faux.setResponses([fauxAssistantMessage(JSON.stringify(refundProposal))]);
  let modelCalls = 0;
  const stream = withReportedReasoning(faux.provider.streamSimple.bind(faux.provider));
  const analyzer = createSupportAnalyzer({
    definition: createSupportAgent("fixture"),
    rootDir: root,
    runOptions: {
      cave: "off",
      ensureRuntime: false,
      model: faux.getModel(),
      streamFn(model, context, options) {
        modelCalls += 1;
        return stream(model, context, options);
      },
    },
  });
  const server = createSupportServer({
    store,
    analyzer,
    credentials: credentials(),
    logger() {},
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/readyz`)).status, 200);

  const createBody = {
    externalId: "zendesk-4421",
    orderId: "NW-1042",
    subject: "Damaged delivery",
    body: "The pack arrived with a torn shoulder strap. Please refund it.",
  };
  const created = await request(base, CASE_TOKEN, "POST", "/v1/cases", createBody, "create-case-0001");
  assert.equal(created.response.status, 201);
  const supportCase = created.body as { id: string; status: string };
  assert.match(supportCase.id, /^case_/);
  assert.equal(supportCase.status, "received");

  const createReplay = await request(base, CASE_TOKEN, "POST", "/v1/cases", createBody, "create-case-0001");
  assert.equal(createReplay.response.status, 201);
  assert.equal(createReplay.response.headers.get("idempotency-replayed"), "true");
  assert.deepEqual(createReplay.body, created.body);

  const conflict = await request(base, CASE_TOKEN, "POST", "/v1/cases", {
    ...createBody,
    subject: "different request",
  }, "create-case-0001");
  assert.equal(conflict.response.status, 409);
  assert.equal((conflict.body as { error: { code: string } }).error.code, "idempotency_key_conflict");

  const crossTenant = await request(base, OTHER_TOKEN, "GET", `/v1/cases/${supportCase.id}`);
  assert.equal(crossTenant.response.status, 404);

  const analyzed = await request(
    base,
    CASE_TOKEN,
    "POST",
    `/v1/cases/${supportCase.id}/analyses`,
    {},
    "analyze-case-0001",
  );
  assert.equal(analyzed.response.status, 200);
  const analysis = analyzed.body as {
    case: {
      status: string;
      proposal: { refundAmountUsd: number };
      receipt: { claimBasis: string };
    };
  };
  assert.equal(analysis.case.status, "proposal_ready");
  assert.equal(analysis.case.proposal.refundAmountUsd, 89);
  assert.equal(analysis.case.receipt.claimBasis, "inferred");
  assert.equal(modelCalls, 1);

  const analysisReplay = await request(
    base,
    CASE_TOKEN,
    "POST",
    `/v1/cases/${supportCase.id}/analyses`,
    {},
    "analyze-case-0001",
  );
  assert.equal(analysisReplay.response.status, 200);
  assert.equal(analysisReplay.response.headers.get("idempotency-replayed"), "true");
  assert.equal(modelCalls, 1);

  const execution = await request(
    base,
    CASE_TOKEN,
    "POST",
    `/v1/cases/${supportCase.id}/execute`,
    {},
    "execute-case-0001",
  );
  assert.equal(execution.response.status, 404);

  const audit = await request(
    base,
    CASE_TOKEN,
    "GET",
    `/v1/audit?caseId=${encodeURIComponent(supportCase.id)}`,
  );
  assert.equal(audit.response.status, 200);
  const actions = (audit.body as { events: Array<{ action: string }> }).events.map((event) => event.action);
  assert.deepEqual(actions, [
    "case.created",
    "case.analysis_started",
    "case.proposal_recorded",
  ]);

  const persisted = JSON.parse(await readFile(join(root, "state.json"), "utf8")) as {
    schemaVersion: number;
    cases: Array<Record<string, unknown>>;
    audit: unknown[];
  } & Record<string, unknown>;
  assert.equal(persisted.schemaVersion, 2);
  assert.equal(persisted.cases.length, 1);
  assert.equal(persisted.audit.length, 3);
  assert.deepEqual(Object.keys(persisted).sort(), [
    "audit", "cases", "idempotency", "orders", "schemaVersion", "sequence",
  ]);
  assert.deepEqual(Object.keys(persisted.cases[0]!).sort(), [
    "body", "createdAt", "externalId", "id", "orderId", "proposal", "receipt",
    "status", "subject", "tenantId", "updatedAt",
  ]);
});

test("analyzer rejects provider JSON that violates business bounds", async () => {
  const root = await mkdtemp(join(tmpdir(), "cave-support-invalid-"));
  const faux = fauxProvider({ provider: "anthropic" });
  faux.setResponses([fauxAssistantMessage(JSON.stringify({
    ...refundProposal,
    refundAmountUsd: 9_999,
  }))]);
  const analyzer = createSupportAnalyzer({
    definition: createSupportAgent("fixture"),
    rootDir: root,
    runOptions: {
      cave: "off",
      ensureRuntime: false,
      model: faux.getModel(),
      streamFn: withReportedReasoning(faux.provider.streamSimple.bind(faux.provider)),
    },
  });
  const order = seedOrders()[0]!;
  await assert.rejects(analyzer({
    runId: "invalid-proposal-run",
    order,
    supportCase: {
      id: "case_invalid",
      tenantId: order.tenantId,
      externalId: "external-invalid",
      orderId: order.id,
      subject: "refund",
      body: "refund",
      status: "analyzing",
      proposal: null,
      receipt: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
  }), /proposal_refund_out_of_bounds/);
});

test("optimized analyzer refuses to start without a Cave Build", () => {
  assert.throws(
    () => createSupportAnalyzer({ mode: "on" }),
    /support_optimization_lock_required/,
  );
});

function credentials(): ReadonlyMap<string, Principal> {
  return new Map([
    [CASE_TOKEN, { tenantId: "northwind", actorId: "agent-1" }],
    [OTHER_TOKEN, { tenantId: "contoso", actorId: "agent-2" }],
  ]);
}

function seedOrders() {
  return [
    validateOrder({
      tenantId: "northwind",
      id: "NW-1042",
      customerId: "cus-nw-7",
      region: "EU",
      status: "delivered",
      totalUsd: 89,
      deliveredOn: "2026-08-18",
    }),
    validateOrder({
      tenantId: "contoso",
      id: "CT-9001",
      customerId: "cus-ct-2",
      region: "US",
      status: "delivered",
      totalUsd: 129,
      deliveredOn: "2026-08-11",
    }),
  ];
}

async function request(
  base: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
  key?: string,
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(key === undefined ? {} : { "idempotency-key": key }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, body: await response.json() as unknown };
}

function withReportedReasoning(stream: (...args: any[]) => any) {
  return (...args: any[]) => {
    const source = stream(...args);
    const output = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      for await (const event of source) {
        const partial = event.partial === undefined
          ? {}
          : { partial: reportZeroReasoning(event.partial) };
        if (event.type === "done") {
          output.push({ ...event, ...partial, message: reportZeroReasoning(event.message) });
        } else if (event.type === "error") {
          output.push({ ...event, ...partial, error: reportZeroReasoning(event.error) });
        } else {
          output.push({ ...event, ...partial });
        }
      }
    });
    return output;
  };
}

function reportZeroReasoning(message: AssistantMessage): AssistantMessage {
  return { ...message, usage: { ...message.usage, reasoning: 0 } };
}
