# coding-agent — the new caveman-code

An interactive coding agent built on [`@caveman-ai/agent/code`](../../packages/agent).
It reads, greps, runs shell commands, and edits files in one workspace, and it
compresses its own conversation history and tool results **reversibly** while it
does so.

The whole example is `agent.mjs`. Everything interesting — the host-sandbox
tools, the default efficiency plan, the observe-only fallback, the token bill,
the recovery proof — lives in the package.

```bash
pnpm --filter @caveman-ai/agent build     # build the package this example imports
export ANTHROPIC_API_KEY=...           # or OPENAI_API_KEY / GEMINI_API_KEY
node examples/coding-agent/agent.mjs
```

## What the first run actually looks like

**Cold machine — no Caveman engine installed.** The session still works. It runs
straight to your provider, announces that it is degraded, and keeps saying so on
every prompt:

```console
$ node agent.mjs
cave: OBSERVE-ONLY — the Caveman engine/gateway is not available here.
  Context transforms are OFF. Nothing is measured and nothing is claimed.
  Turn optimized mode on: npm i -g caveman && caveman start

caveman-code · anthropic/claude-sonnet-4-6 · workspace /repo
mode: observe-only

agent [observe-only] > …
```

**With the engine installed.** The session starts the local Cave runtime for you
and runs optimized from the first turn: history and tool results are compressed
by a recoverable-only plan, `cave_retrieve` is available to the model, and every
turn prints its bill.

```console
agent [optimized] > read big.txt and summarize it

turn 2 · optimized · anthropic/claude-sonnet-4-6 · 412 ms
  context transforms: caveman.engine.terminal.v1, caveman.engine.text.v1
  transformed context: 3,318 tokens before → 33 after
  tokens saved: 3,285 this turn · 3,285 this session — inferred (local estimate), token counts only
  provider usage (provider_reported): in 1,204 · out 96 · cache read 0 · cache write 0
  spend: 0.004812 USD measured at public catalog list prices (public_catalog)
recovery proof: read_file:big.txt round-trip OK (sha256 match 1f0a4c9d21b7)
```

## Commands

| Command | What it does |
|---|---|
| `/tokens` | the session token bill so far |
| `/prove-recovery` | compress one recorded tool output and recover it byte-exactly |
| `/mode` | whether this session is optimized or observe-only |
| `/exit` | end the session and print the final bill |

## What the numbers mean

- **Tokens saved is a token count, labelled `inferred (local estimate)`.** It is
  never converted to a dollar figure, and a local session mints nothing. Verified
  savings are a platform concept with signed, provider-causal evidence behind
  them; nothing here qualifies. See
  [`docs/SAVINGS_ACCOUNTING.md`](../../docs/SAVINGS_ACCOUNTING.md).
- **Spend is a public-catalog list-price subtotal**, labelled with its
  `priceBasis`. It is not a provider invoice. `unpriced` means the catalog has no
  price for that model, so the number is an honest zero contribution.
- **Recovery is proved, not asserted.** The runtime retrieves and byte-compares
  every compressed body before the provider ever sees it; the printed proof line
  re-runs that same engine pair on a recorded tool output and reports the sha256
  comparison — including when it fails.

## Honest limits

- Tools run on the **real host** (`sandbox: "host"`). `bash` executes what the
  model asks for, in the workspace, with your credentials. Run it on a repo you
  are willing to let an agent edit.
- Tool output is capped **before** compression (24 KB for `read_file`/`bash`,
  16 KB for `grep`) so a runaway command cannot blow the context even with no
  engine present.
- A live coding session is **never lock-eligible**: `compile` refuses host mode
  (EAB-101), so nothing this example does can become a Cave Build.
- Once a session degrades to observe-only it stays there. Restart it after
  `caveman start` to get optimized mode back.
