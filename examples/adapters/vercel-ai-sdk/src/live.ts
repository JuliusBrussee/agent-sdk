import { gateway } from "ai";
import { reviewProcurementRequest } from "./workflow.ts";

if (!process.env.AI_GATEWAY_API_KEY) {
  process.stdout.write("live smoke SKIP: AI_GATEWAY_API_KEY is not configured\n");
  process.exit(0);
}

const model = gateway(
  process.env.VERCEL_ADAPTER_SAMPLE_MODEL?.trim() || "anthropic/claude-haiku-4-5",
);
const result = await reviewProcurementRequest({
  model,
  request: {
    requestId: "live-smoke-1",
    vendorName: "Example Analytics Vendor",
    annualSpendUsd: 75_000,
    dataClasses: ["customer_contact_data"],
    controlEvidence: ["SOC 2 Type II report valid through 2027-01-31"],
  },
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
