# Northbeam support bot

A support agent with a cost per ticket. This scaffold is the flagship
tutorial: a production-shaped bot — real instructions, real policy
skills, a sandboxed order-lookup tool, and evals that gate the build.

## The two-minute proof

```bash
npm install
npm run doctor          # checks your provider key; tells you the one-line fix if missing
npm run ticket -- tickets/refund-request.md
```

The run ends with a receipt. On this first run everything is read cold.
On providers with explicit caching (Anthropic), the first run also pays
a small premium to *write* your static prefix into the provider cache —
when that happens, the receipt says so in place. Providers with
automatic caching (OpenAI, Google) charge no write premium; their first
run is simply the cold baseline. Either way, the cache expires after
idle minutes, so a cold morning run re-pays the setup cost the receipt
shows.

Now run a second ticket:

```bash
npm run ticket -- tickets/order-status.md
```

Same receipt shape, different economics: the instructions, the skills
index, and the tool schemas — everything static about this agent — were
read warm from the provider cache, and the receipt's `input` line says
so from provider-reported numbers. The cost line lands below the
`cold estimate` line, and that gap compounds with every ticket. That is
the point of building support bots on this runtime: tens of thousands
of runs of the same frozen prefix with only the ticket varying.

Every figure is an estimated public-catalog list-price subtotal, never
an invoice. The cold estimate is labeled `inferred` — a counterfactual,
not a measurement.

## What's in the box

- `instructions.md` — the standing policy. Static on purpose: it IS
  the cacheable prefix.
- `skills/` — refund + shipping playbooks. One-line descriptions live
  in the prefix; bodies load only when a ticket needs them.
- `tools/lookup_order.ts` — read-effect only. The bot looks up and
  recommends; refunds are drafts a human approves. That is the correct
  architecture, not a limitation.
- `tickets/` — three sample tickets to run.
- `evals/support.eval.ts` — the build gate. Flip `APPROVED` to `true`
  after reading the fixtures, then `npm run build` locks the cheapest
  plan that passes all of them.

## Try breaking it

Add a computed date to `agent.ts`:

```ts
context: {
  today: () => `Today is ${new Date().toDateString()}`,
},
```

and run `npm run build`. The build fails and explains why: a
build-stable segment whose bytes change between runs silently destroys
provider-cache economics, so here it is a build failure instead. (This
check is static and runs before the eval gate, so it fires even while
your evals are unapproved.) Serve the date from a tool instead and the
build passes again.

## For your coding agent

`AGENTS.md` teaches Claude Code / Codex / etc. how to add tools,
skills, and evals in-convention. Point your agent at it.
