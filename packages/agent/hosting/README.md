# Hosting a Caveman agent

`caveman-agent serve` is the deployable target. It puts one agent directory
behind four HTTP endpoints, journals every run, and re-drives whatever a
previous instance left unfinished.

```
POST   /runs          {"runId":"...","input":"..."}  → 202 accepted, 200 if already settled
GET    /runs/{runId}                                 → the run's journaled status
DELETE /runs/{runId}                                 → 202 cancel requested, 409 already settled
GET    /healthz                                      → liveness, no credential
GET    /readyz                                       → 503 until the recovery sweep finishes
```

`/runs` requires `Authorization: Bearer $CAVE_SERVE_TOKEN`. There is no
unauthenticated mode: the endpoint spends money and returns model output.

## What makes it durable

Durability is the journal's, not the server's. Every run appends to an
append-only journal before it acts — a provider-call intent lands *before* the
call, the settlement lands after — so a process that dies mid-run leaves a
record that says exactly where it stopped.

`runId` is the idempotency key, assigned by the caller:

| Resubmitting the same `runId` | What happens |
|---|---|
| Run finished | Journaled result is returned. Nothing is spent. |
| Run failed terminally | The same error is returned. Nothing is spent. |
| Run was interrupted | It resumes from its last journaled boundary. |
| Run is in flight | `202 running`. The per-run lock stops a second driver. |

**The honest ceiling:** the guarantee is at-least-once at the step boundary. A
provider call whose intent was journaled but whose settlement was not may have
been billed without this ledger seeing it. That never disappears silently — it
surfaces on the receipt as `resume.possibleDoubleCountCalls`.

Recovery runs at boot and every 60 seconds after, so a run stranded by a peer
instance's death is reclaimed rather than waiting for a redeploy. A run whose
input was multimodal is not auto-resumed: its journal holds a digest, not the
content, so only a caller still holding the original can resume it. That is
reported in the recovery report, not swallowed.

## Cancelling a run

`DELETE /runs/{runId}` appends a cancellation request to the journal and returns
what was actually true — `requested`, `already_requested`, `already_settled`, or
`missing`. It never pretends to have stopped something it did not.

Cancellation is graceful, not forceful. The request is a durable fact, and the
run still ends with a terminal event of its own, so spend already journaled
stays accounted for. Three consequences follow from putting it in the journal
rather than in process memory:

- **It reaches a run this instance is not driving.** The instance doing the work
  honours it on its next sweep; the instance you asked stops immediately if it
  happens to be the one running it.
- **It survives a restart.** A run cancelled while nothing was driving it is
  settled by the next recovery sweep — with **no provider call and no spend** —
  instead of being resumed and then cancelled again.
- **It is idempotent.** A retried `DELETE` costs a journal read.

A cancelled run settles as `failed` with code `cave_durable_run_cancelled`. It is
deliberately not a fourth terminal state: every existing reader already branches
on the code, and a new shape would silently read as "still pending" to anything
not taught about it.

A settled run is never rewritten as cancelled. Its outcome is a fact about money
that was already spent.

## Sleeping, and what it costs

An agent waiting on a rate limit, a retry window, or tomorrow morning's approval
does not need a process. It needs a date.

```ts
import { scheduleDurableWake } from "@caveman-ai/agent/durable";

await scheduleDurableWake(store, runId, new Date(Date.now() + 3_600_000), "rate limited");
```

The wake time goes in the journal and the run stops being eligible to drive. The
recovery sweep leaves it alone and reports it under `sleeping` — a healthy run
waiting on a clock, not one the server failed to drive. `GET /runs/{runId}`
names the `wakeAt` and the reason, so "nothing is happening" is answerable.
Resubmitting a sleeping run returns `status: "sleeping"` rather than waking it
early, because the wait is the point.

Wake times are absolute and last-write-wins, which is why there is no
"sleep finished" event: once `wakeAt` has passed, the sleep is over by
definition, so a crash-resume cannot accidentally re-wait it.

**Why this is the cost lever.** Agents spend most of their wall-clock waiting,
and every container platform bills for that wall-clock — on E2B and Daytona a
sandbox is charged for its whole lifetime, not its active CPU. A blocked process
turns a week-long approval into a week of compute. A journaled wake time turns it
into nothing: waiting a week costs the same as waiting a second.

`server.nextWakeAt()` is the hook that makes that real. It returns the earliest
instant any journaled run becomes due, so a platform can set one timer, shut the
instance down, and bring one back exactly when there is work. A wake time in the
past means *there is work now*; `undefined` from a store that cannot enumerate
means *unknown*, never *nothing pending*.

The Cloudflare recipe wires this end to end: the journal Durable Object records
each `sleep_scheduled` wake, arms `storage.setAlarm()` on the earliest one, and
touches the container when it fires. The container's `sleepAfter` is therefore
`5m` rather than the length of the longest wait in the system — it sleeps, and
the alarm brings it back.

## Where the journal lives

| `DurableStore` | Use it when |
|---|---|
| `DiskDurableStore` (default) | The instance has a real volume that survives restarts. |
| `HttpDurableStore` | The instance does not — container platforms, autoscaled fleets. |

Set `CAVE_JOURNAL_URL` + `CAVE_JOURNAL_TOKEN` to switch to the HTTP journal.
Its wire contract is six endpoints, documented on `HttpDurableStoreOptions`;
`cloudflare/worker.ts` is a complete implementation.

Two refusals worth knowing about, both deliberate: an append is **never
retried** (a duplicated settlement is silently wrong money — the run fails and
the resume re-drives instead), and losing the lock lease **poisons the store**
for that run (this process can no longer prove it is the only driver).

## Cloudflare

The runtime shells out for host-sandbox tools and Workers has no
`node:child_process`, so the agent runs in a Container with a Worker in front
holding the journal in a Durable Object — a single writer with ordered appends
whose response is delivered only once the write is durable.

```bash
npm install @cloudflare/containers
npm install -D wrangler

cp node_modules/@caveman-ai/agent/hosting/cloudflare/* .
# set PUBLIC_URL in wrangler.jsonc to your deployed Worker origin
wrangler secret put CAVE_SERVE_TOKEN
wrangler secret put CAVE_JOURNAL_TOKEN
wrangler secret put ANTHROPIC_API_KEY
wrangler deploy
```

## Any other container platform

The same image runs on Fly, Railway, Render, ECS, or Kubernetes:

```bash
docker build -f node_modules/@caveman-ai/agent/hosting/Dockerfile -t my-agent .
```

- Give it `CAVE_SERVE_TOKEN` and the provider credential.
- Point the health check at `/healthz` and the readiness check at `/readyz`.
- Persist the journal: either mount a volume at `/app/.caveman` or set
  `CAVE_JOURNAL_URL`. Without one of the two, an instance restart loses the
  journal, and a lost journal is a lost resume.
- For scale-to-zero, drive shutdown off `server.nextWakeAt()` rather than a
  fixed idle timeout; a run sleeping until Thursday should keep nothing alive.
- Allow at least 30s for SIGTERM drain. Runs that do not finish are journaled
  and picked up by the next instance, so a short grace period costs latency,
  never correctness.
