import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createSecurityAgent, createTriageAnalyzer } from "../src/agent.js";
import { validateAsset, type Principal, type TriageProposal } from "../src/domain.js";
import { createSecurityServer } from "../src/server.js";
import { FileSecurityStore } from "../src/store.js";

const RESPONDER = "security-responder-token-000001";
const OTHER = "security-other-token-00000000001";
const proposal: TriageProposal = {
  severity: "P1",
  summary: "Critical payment API shows credential abuse and suspicious egress.",
  evidence: ["indicator:203.0.113.9", "asset:asset-payments-api", "control:edr-isolation"],
  containmentActions: ["isolate endpoint through EDR", "revoke suspected credentials and active sessions"],
  notificationRequired: true,
  escalationReason: "Critical payment system may have active credential compromise.",
};

test("incident workflow records evidence-only containment handoff and audit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cave-security-example-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileSecurityStore(join(root, "state.json"));
  await store.initialize(assets());
  const faux = fauxProvider({ provider: "anthropic" });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("lookup_control", { controlId: "edr-isolation" }, { id: "control-1" })),
    fauxAssistantMessage(fauxToolCall("review_blast_radius", { task: "Review payment API compromise evidence." }, { id: "blast-1" })),
    fauxAssistantMessage("Potential credential spread; identity telemetry is missing."),
    fauxAssistantMessage(JSON.stringify(proposal)),
  ]);
  let calls = 0;
  const source = withReasoning(faux.provider.streamSimple.bind(faux.provider));
  const analyzer = createTriageAnalyzer({
    definition: createSecurityAgent("fixture"),
    rootDir: root,
    runOptions: {
      ensureRuntime: false,
      model: faux.getModel(),
      streamFn(model, context, options) { calls += 1; return source(model, context, options); },
    },
  });
  const server = createSecurityServer({ store, analyzer, credentials: credentials(), logger() {} });
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address(); assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/readyz`)).status, 200);

  const alert = { externalId: "siem-8821", assetId: "asset-payments-api", title: "Suspicious egress", detail: "Credential use followed by egress to 203.0.113.9.", indicators: ["203.0.113.9"] };
  const created = await request(base, RESPONDER, "POST", "/v1/incidents", alert, "incident-create-001");
  assert.equal(created.response.status, 201);
  const incident = created.body as { id: string };
  const replay = await request(base, RESPONDER, "POST", "/v1/incidents", alert, "incident-create-001");
  assert.equal(replay.response.headers.get("idempotency-replayed"), "true");
  const crossTenant = await request(base, OTHER, "GET", `/v1/incidents/${incident.id}`);
  assert.equal(crossTenant.response.status, 404);

  const triaged = await request(base, RESPONDER, "POST", `/v1/incidents/${incident.id}/triage`, {}, "incident-triage-001");
  assert.equal(triaged.response.status, 200);
  const body = triaged.body as { incident: { status: string; proposal: TriageProposal; receipt: { claimBasis: string; tools: Array<{ name: string }>; subagents: unknown[]; streamEventTypes: string[] } } };
  assert.equal(body.incident.status, "proposal_ready");
  assert.deepEqual(body.incident.proposal.containmentActions, proposal.containmentActions);
  assert.equal(body.incident.receipt.claimBasis, "inferred");
  assert.deepEqual(body.incident.receipt.tools.map((item) => item.name), ["lookup_control", "review_blast_radius"]);
  assert.equal(body.incident.receipt.subagents.length, 1);
  assert.ok(body.incident.receipt.streamEventTypes.includes("run_end"));
  assert.equal(calls, 4);

  const triageReplay = await request(base, RESPONDER, "POST", `/v1/incidents/${incident.id}/triage`, {}, "incident-triage-001");
  assert.equal(triageReplay.response.headers.get("idempotency-replayed"), "true");
  assert.equal(calls, 4);

  const execution = await request(base, RESPONDER, "POST", `/v1/incidents/${incident.id}/execute`, {}, "containment-execute-001");
  assert.equal(execution.response.status, 404);
  const unchanged = await request(base, RESPONDER, "GET", `/v1/incidents/${incident.id}`);
  assert.equal((unchanged.body as { status: string }).status, "proposal_ready");
  const audit = await request(base, RESPONDER, "GET", "/v1/audit");
  assert.deepEqual((audit.body as { events: Array<{ action: string }> }).events.map((event) => event.action), [
    "incident.created", "incident.triage_started", "incident.proposal_recorded",
  ]);
  const persisted = JSON.parse(await readFile(join(root, "state.json"), "utf8")) as {
    schemaVersion: number;
    incidents: Array<Record<string, unknown>>;
  } & Record<string, unknown>;
  assert.equal(persisted.schemaVersion, 2);
  assert.deepEqual(Object.keys(persisted).sort(), ["assets", "audit", "idempotency", "incidents", "schemaVersion", "sequence"]);
  assert.deepEqual(Object.keys(persisted.incidents[0]!).sort(), [
    "assetId", "createdAt", "detail", "externalId", "id", "indicators", "proposal",
    "receipt", "status", "tenantId", "title", "updatedAt",
  ]);
});

test("pre-aborted triage reaches no provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "cave-security-abort-"));
  const faux = fauxProvider({ provider: "anthropic" });
  let calls = 0;
  const controller = new AbortController(); controller.abort(new Error("operator cancelled"));
  const analyzer = createTriageAnalyzer({
    definition: createSecurityAgent("fixture"), rootDir: root,
    runOptions: { ensureRuntime: false, model: faux.getModel(), streamFn() { calls += 1; throw new Error("must not call"); } },
  });
  const asset = assets()[0]!;
  await assert.rejects(analyzer({
    runId: "security-aborted-run", signal: controller.signal, asset,
    incident: { id: "incident-abort", tenantId: asset.tenantId, externalId: "abort", assetId: asset.id, title: "abort", detail: "abort", indicators: [], status: "triaging", proposal: null, receipt: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
  }));
  assert.equal(calls, 0);
  await rm(root, { recursive: true, force: true });
});

function assets() { return [validateAsset({ tenantId: "northwind", id: "asset-payments-api", criticality: "critical", owner: "payments-platform", controls: ["edr-isolation", "credential-revoke"] }), validateAsset({ tenantId: "contoso", id: "asset-erp-web", criticality: "high", owner: "erp", controls: ["edr-isolation"] })]; }
function credentials(): ReadonlyMap<string, Principal> { return new Map([[RESPONDER, { tenantId: "northwind", actorId: "responder-1" }], [OTHER, { tenantId: "contoso", actorId: "responder-2" }]]); }
async function request(base: string, token: string, method: string, path: string, body?: unknown, key?: string) { const response = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...(key ? { "idempotency-key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { response, body: await response.json() as unknown }; }
function withReasoning(source: (...args: any[]) => any) { return (...args: any[]) => { const input = source(...args); const output = createAssistantMessageEventStream(); queueMicrotask(async () => { for await (const event of input) { const partial = event.partial === undefined ? {} : { partial: reported(event.partial) }; if (event.type === "done") output.push({ ...event, ...partial, message: reported(event.message) }); else if (event.type === "error") output.push({ ...event, ...partial, error: reported(event.error) }); else output.push({ ...event, ...partial }); } }); return output; }; }
function reported(message: AssistantMessage): AssistantMessage { return { ...message, usage: { ...message.usage, reasoning: 0 } }; }
