import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createVendorAnalyzer, createVendorRiskAgent } from "../src/agent.js";
import { validateVendor, type Principal, type RiskProposal, type Vendor } from "../src/domain.js";
import { createVendorServer } from "../src/server.js";
import { FileVendorStore } from "../src/store.js";

const REVIEWER = "vendor-reviewer-token-00000001";
const OTHER = "vendor-other-token-00000000001";
const proposal: RiskProposal = {
  riskTier: "medium",
  riskDisposition: "conditions_required",
  summary: "Core controls have tested evidence; subprocessor location remains missing.",
  controls: [
    { controlId: "IAM-1", status: "met", evidenceRefs: ["soc2-2026"], rationale: "SOC 2 tested IAM without exception." },
    { controlId: "ENC-1", status: "met", evidenceRefs: ["soc2-2026"], rationale: "SOC 2 tested encryption without exception." },
    { controlId: "IR-1", status: "met", evidenceRefs: ["ir-exercise-2026"], rationale: "Dated exercise record supports operation." },
    { controlId: "SUB-1", status: "partial", evidenceRefs: ["subprocessor-list"], rationale: "Registry omits processing locations." },
  ],
  conditions: ["Provide processing location for every listed subprocessor before onboarding."],
};

test("vendor workflow records tenant-isolated evidence-only risk handoff", async (t) => {
  const root = await sampleRoot("cave-vendor-example-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, "state.json");
  const store = new FileVendorStore(statePath); await store.initialize(vendors());
  const faux = fauxProvider({ provider: "anthropic" }); faux.setResponses([fauxAssistantMessage(JSON.stringify(proposal))]);
  let calls = 0;
  const analyzer = createVendorAnalyzer({ definition: createVendorRiskAgent("fixture"), rootDir: root, memoryRoot: join(root, "memory"), runOptions: { ensureRuntime: false, model: faux.getModel(), streamFn(model, context, options) { calls += 1; return faux.provider.streamSimple(model, context, options); } } });
  const server = createVendorServer({ store, analyzer, credentials: credentials(), logger() {} });
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address(); assert(address && typeof address === "object"); const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/healthz`)).status, 200); assert.equal((await fetch(`${base}/readyz`)).status, 200);
  const input = { externalId: "procurement-442", vendorId: "acme-analytics", questionnaire: { IAM_MFA: "Required for workforce and privileged access.", IR_NOTICE: "Contract says 24 hours.", SUBPROCESSORS: "See registry." } };
  const created = await request(base, REVIEWER, "POST", "/v1/reviews", input, "vendor-create-001"); assert.equal(created.response.status, 201); const review = created.body as { id: string };
  const replay = await request(base, REVIEWER, "POST", "/v1/reviews", input, "vendor-create-001"); assert.equal(replay.response.headers.get("idempotency-replayed"), "true");
  const cross = await request(base, OTHER, "GET", `/v1/reviews/${review.id}`); assert.equal(cross.response.status, 404);
  const analyzed = await request(base, REVIEWER, "POST", `/v1/reviews/${review.id}/analysis`, {}, "vendor-analyze-001"); assert.equal(analyzed.response.status, 200);
  const body = analyzed.body as { review: { status: string; proposal: RiskProposal; receipt: { claimBasis: string } } };
  assert.equal(body.review.status, "proposal_ready"); assert.equal(body.review.receipt.claimBasis, "inferred"); assert.equal(body.review.proposal.conditions.length, 1); assert.equal(calls, 1);
  const analysisReplay = await request(base, REVIEWER, "POST", `/v1/reviews/${review.id}/analysis`, {}, "vendor-analyze-001"); assert.equal(analysisReplay.response.headers.get("idempotency-replayed"), "true"); assert.equal(calls, 1);
  const execution = await request(base, REVIEWER, "POST", `/v1/reviews/${review.id}/execute`, {}, "vendor-execute-001"); assert.equal(execution.response.status, 404);
  const unchanged = await request(base, REVIEWER, "GET", `/v1/reviews/${review.id}`); assert.equal((unchanged.body as { status: string }).status, "proposal_ready");
  const audit = await request(base, REVIEWER, "GET", "/v1/audit"); assert.deepEqual((audit.body as { events: Array<{ action: string }> }).events.map((item) => item.action), ["review.created", "review.analysis_started", "review.proposal_recorded"]);
  const persisted = JSON.parse(await readFile(statePath, "utf8")) as { schemaVersion: number; reviews: Array<Record<string, unknown>> } & Record<string, unknown>;
  assert.equal(persisted.schemaVersion, 2);
  assert.deepEqual(Object.keys(persisted).sort(), ["audit", "idempotency", "reviews", "schemaVersion", "sequence", "vendors"]);
  assert.deepEqual(Object.keys(persisted.reviews[0]!).sort(), ["createdAt", "externalId", "id", "proposal", "questionnaire", "receipt", "status", "tenantId", "updatedAt", "vendorId"]);
});

test("same vendor agent memory stays isolated by tenant", async () => {
  const root = await sampleRoot("cave-vendor-memory-");
  const definition = createVendorRiskAgent("fixture"); const vendor = vendors()[0]!;
  const review = { id: "review-memory", tenantId: "northwind", externalId: "memory-a", vendorId: vendor.id, questionnaire: { IAM_MFA: "yes" }, status: "reviewing" as const, proposal: null, receipt: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
  const first = fauxProvider({ provider: "anthropic" }); first.setResponses([fauxAssistantMessage(fauxToolCall("cave_memory_remember", { text: "northwind exception expires 2026-12-01" }, { id: "remember" })), fauxAssistantMessage(JSON.stringify(proposal))]);
  await createVendorAnalyzer({ definition, rootDir: root, memoryRoot: join(root, "memory"), runOptions: { ensureRuntime: false, model: first.getModel(), streamFn: first.provider.streamSimple.bind(first.provider) } })({ runId: "vendor-memory-a", review, vendor });
  let observed = "";
  const second = fauxProvider({ provider: "anthropic" }); second.setResponses([fauxAssistantMessage(fauxToolCall("cave_memory_search", { query: "northwind exception" }, { id: "search" })), (context) => { observed = JSON.stringify(context.messages); return fauxAssistantMessage(JSON.stringify(proposal)); }]);
  await createVendorAnalyzer({ definition, rootDir: root, memoryRoot: join(root, "memory"), runOptions: { ensureRuntime: false, model: second.getModel(), streamFn: second.provider.streamSimple.bind(second.provider) } })({ runId: "vendor-memory-b", review: { ...review, tenantId: "contoso", externalId: "memory-b" }, vendor: { ...vendor, tenantId: "contoso" } });
  assert.doesNotMatch(observed, /expires 2026-12-01/);
  await rm(root, { recursive: true, force: true });
});

async function sampleRoot(prefix: string) { const root = await mkdtemp(join(tmpdir(), prefix)); await mkdir(join(root, "data"), { recursive: true }); await writeFile(join(root, "data/control-framework.md"), await readFile(join(process.cwd(), "data/control-framework.md"), "utf8")); return root; }
function vendors(): Vendor[] { return [validateVendor({ tenantId: "northwind", id: "acme-analytics", name: "Acme Analytics", evidence: [{ id: "soc2-2026", kind: "audit_report", summary: "SOC 2 IAM and encryption tested." }, { id: "ir-exercise-2026", kind: "exercise_record", summary: "Dated tabletop." }, { id: "subprocessor-list", kind: "registry", summary: "Locations missing." }] }), validateVendor({ tenantId: "contoso", id: "beta-payroll", name: "Beta Payroll", evidence: [{ id: "security-policy", kind: "policy", summary: "Undated policy." }] })]; }
function credentials(): ReadonlyMap<string, Principal> { return new Map([[REVIEWER, { tenantId: "northwind", actorId: "reviewer-1" }], [OTHER, { tenantId: "contoso", actorId: "reviewer-2" }]]); }
async function request(base: string, token: string, method: string, path: string, body?: unknown, key?: string) { const response = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...(key ? { "idempotency-key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { response, body: await response.json() as unknown }; }
