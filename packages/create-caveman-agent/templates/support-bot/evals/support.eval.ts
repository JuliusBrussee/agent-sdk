import { eval as defineEval } from "@caveman-ai/agent";
import { readFileSync } from "node:fs";

// One review switch. The build profiles first, selects on development,
// then opens holdout only after plan freeze. Flip to true once you have
// read the fixtures and agree they describe the behavior you want.
const APPROVED = false;

// Each ticket is named by a literal `new URL("…", import.meta.url)` so the
// build's source graph can lock the exact fixture bytes. A computed path
// (template string) is not lockable and fails doctor/build by design.
const ticket = (url: URL): string => readFileSync(url, "utf8");

export const refundRequest = defineEval({
  id: "refund-request",
  lineageId: "refund-family",
  split: "profile",
  approved: APPROVED,
  input: ticket(new URL("../tickets/refund-request.md", import.meta.url)),
  quality: [
    { type: "tool_called", tools: ["lookup_order"] },
    // Money never moves without a human: the reply must route through
    // the approval queue, in exactly the words instructions.md requires.
    { type: "contains", fragments: ["queued this for approval"] },
  ],
});

export const orderStatus = defineEval({
  id: "order-status",
  lineageId: "status-family",
  split: "development",
  approved: APPROVED,
  input: ticket(new URL("../tickets/order-status.md", import.meta.url)),
  quality: [
    { type: "tool_called", tools: ["lookup_order"] },
    { type: "contains", fragments: ["NB-1042"] },
  ],
});

export const angryEscalation = defineEval({
  id: "angry-escalation",
  lineageId: "escalation-family",
  split: "development",
  approved: APPROVED,
  input: ticket(new URL("../tickets/angry-escalation.md", import.meta.url)),
  // The ticket threatens a chargeback, so per policy the right reply
  // escalates and drafts nothing: the not_contains grader fails the fixture
  // if a refund is routed to the approval queue on top of a chargeback.
  quality: [
    { type: "contains", fragments: ["escalated to a Northbeam support lead"] },
    { type: "not_contains", fragments: ["queued this for approval"] },
  ],
});

export const shippingDelay = defineEval({
  id: "shipping-delay",
  lineageId: "shipping-family",
  split: "holdout",
  approved: APPROVED,
  // Deliberately a different order than any development fixture: holdout
  // must test generalization, not content the development set tuned on.
  input:
    "Subject: NB-8214 late?\n\nMy order NB-8214 feels like it's taking forever. Is it late? When will it arrive?",
  quality: [
    { type: "tool_called", tools: ["lookup_order"] },
    // No invented dates: the reply quotes the carrier estimate as the
    // carrier's, per instructions.md.
    { type: "contains", fragments: ["carrier"] },
  ],
});

export const warrantyQuestion = defineEval({
  id: "warranty-question",
  lineageId: "warranty-family",
  split: "holdout",
  approved: APPROVED,
  input:
    "Subject: Pack strap ripped\n\nThe strap on my Cascade 40L from order NB-2077 ripped on a trail last month. I've used it maybe five times. Can I get this fixed or replaced?",
  quality: [{ type: "contains", fragments: ["warranty"] }],
});
