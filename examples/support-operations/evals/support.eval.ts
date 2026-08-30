import { eval as defineEval } from "@caveman-ai/agent";
import { supportPrompt } from "../src/agent.js";
import type { Order, SupportCase } from "../src/domain.js";

const now = "2026-08-28T00:00:00.000Z";

function prompt(
  id: string,
  body: string,
  order: Partial<Order> = {},
): string {
  const resolvedOrder: Order = {
    tenantId: "northwind",
    id: `ORDER-${id}`,
    customerId: `customer-${id}`,
    region: "EU",
    status: "delivered",
    totalUsd: 89,
    deliveredOn: "2026-08-20",
    ...order,
  };
  const supportCase: SupportCase = {
    id: `case-${id}`,
    tenantId: resolvedOrder.tenantId,
    externalId: `fixture-${id}`,
    orderId: resolvedOrder.id,
    subject: id,
    body,
    status: "analyzing",
    proposal: null,
    receipt: null,
    createdAt: now,
    updatedAt: now,
  };
  return supportPrompt({ supportCase, order: resolvedOrder });
}

// These fixtures are checked-in compiler evidence, not production data.
export const damagedRefundProfile = defineEval({
  id: "support-damaged-refund-profile",
  lineageId: "refund-family",
  split: "profile",
  input: prompt("damaged-refund", "Strap arrived torn. Please review a full refund."),
  quality: [
    { type: "contains", fragments: ["refund_review", "refund-eu-v3"] },
    { type: "not_contains", fragments: ["refund issued", "refund completed"] },
  ],
});

export const statusDevelopment = defineEval({
  id: "support-status-development",
  lineageId: "status-family",
  split: "development",
  input: prompt("status", "Where is this order?", { status: "in_transit", deliveredOn: null }),
  quality: [
    { type: "contains", fragments: ["respond"] },
    { type: "not_contains", fragments: ["refund_review"] },
  ],
});

export const chargebackDevelopment = defineEval({
  id: "support-chargeback-development",
  lineageId: "escalation-family",
  split: "development",
  input: prompt("chargeback", "Refund me now or I will file a chargeback."),
  quality: [
    { type: "contains", fragments: ["escalate", "chargeback"] },
    { type: "not_contains", fragments: ["refund_review"] },
  ],
});

export const missingDateHoldout = defineEval({
  id: "support-missing-date-holdout",
  lineageId: "missing-evidence-family",
  split: "holdout",
  input: prompt("missing-date", "I want a refund for a damaged delivery.", { deliveredOn: null }),
  quality: [{ type: "contains", fragments: ["escalate"] }],
});

export const usRefundHoldout = defineEval({
  id: "support-us-refund-holdout",
  lineageId: "refund-us-family",
  split: "holdout",
  input: prompt("us-refund", "Item arrived damaged. Please review refund.", { region: "US", totalUsd: 64 }),
  quality: [
    { type: "contains", fragments: ["refund_review", "refund-us-v5"] },
    { type: "not_contains", fragments: ["refund issued", "refund completed"] },
  ],
});
