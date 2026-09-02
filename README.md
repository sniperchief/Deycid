# Deycid

**Deycid is an intelligence decision layer for autonomous agents. It buys verified intelligence from the Telegraph network until a proposed action reaches a required confidence threshold — or until its budget runs out.**

Built for the **Telegraph Protocol Hackathon on Base — Track 3 (AI Agent / Application)**.

---

## Quickstart

Add Deycid to Claude Desktop, Cursor, or any MCP client:

```jsonc
{
  "mcpServers": {
    "deycid": {
      "command": "npx",
      "args": ["-y", "github:sniperchief/Deycid"],
      "env": { "AGENT_PRIVATE_KEY": "0x<burner key>" }
    }
  }
}
```

> Installing from GitHub builds on first install, so it needs npm's lifecycle scripts to be permitted (recent npm versions may ask you to approve them). The first install takes a few minutes; after that it is cached.

Fund that wallet with a little **Base Sepolia USDC** from [faucet.circle.com](https://faucet.circle.com) — 20 USDC covers roughly 2,000 intelligence calls. **No testnet ETH is needed**: payments are signed as EIP-3009 authorizations and the facilitator pays the gas.

Then ask your agent:

> *Should I execute this transaction? 0x… on Base — check it with Deycid first.*

Deycid buys verified intelligence from Telegraph until it can answer, and hands back a verdict with the evidence, the cost, and the settlement proofs.

Without a key it still runs — discovery and case inspection work, and only paid calls refuse — so you can inspect the tool surface before funding anything.


---

## Try it without installing anything

Deycid ships a small demo server (`src/web/server.ts`) built on the **same engine** — no separate code path, no simulated data on its API. It exposes `GET /api/status` and `POST /api/run` (Server-Sent Events); every call to `/api/run` buys real intelligence from real Telegraph miners and pays for it with real USDC.

```bash
npm run web        # http://localhost:8080
```

The page it serves is the marketing/product site built from [`web/`](web/) (React + TypeScript + Vite; see [`web/README.md`](web/README.md)). Its "Decision Lab" section is wired directly to `/api/status` and `/api/run` — nothing is scripted or mocked. Loading the page only reads `/api/status`; a wallet is charged only when a visitor presses "Run decision," which streams the same SSE events described below. The concept-explainer sections further down the page (confidence scale, intelligence budget, evidence matrix) show a labelled illustrative example until a visitor completes a real run, at which point they switch to that run's actual receipt.

A real run:

```
$ deycid evaluate
  decision  : Should I supply USDC to the Aave v3 lending pool on Base?
  budget    : $0.1100 USDC   risk: medium

→ Round 1: requesting URL_SCAN
→ Round 1: requesting CRYPTO_PRICE
→ Round 1: requesting FRAUD_DETECTION
→ Round 2: requesting TVL_LOOKUP
→ Round 2: requesting NEWS_SEARCH
→ Round 2: requesting GAS_PRICE

VERDICT: APPROVE   confidence 92% / target 90%
spent $0.0600 of $0.1100 USDC
```

Six calls, six distinct intents, six distinct miners — so the 92% is corroboration from independent sources rather than the same one counted twice. Round 1 was not enough on its own; Deycid escalated, and stopped as soon as it had cleared its target rather than spending the rest of the budget. The same evidence under `low` tolerance (95% target) returns ABSTAIN.

### Hosting it

Because it pays from your wallet, three independent brakes guard it: a per-run budget, a per-visitor hourly rate limit, and a hard daily ceiling across all visitors — plus the wallet balance itself. Defaults are $0.11/run (enough for three rounds), 3 runs/hour/visitor, $2.00/day.

Any Node host works. On Render or Railway: point it at this repo, build with `npm install && npm run build`, start with `npm run web`, and set `AGENT_PRIVATE_KEY` as a **secret** (never a plain env var in a dashboard that logs). Tune the caps with the `DEYCID_WEB_*` variables.

Visitors choose from a fixed set of decisions rather than free text — arbitrary questions would let anyone spend the wallet on anything, and most off-topic questions produce unreadable evidence that misrepresents how Deycid performs.

---

## The problem

An autonomous agent about to move money looks roughly like this:

```
user request  ->  LLM reasoning  ->  action
```

There is no step in that pipeline where the agent asks *how much evidence is enough*. It has no mechanism for deciding whether its information is reliable, whether it is stale, whether two sources disagree, whether buying one more fact is worth the money, or when to stop researching and act.

For a chatbot that is a quality problem. For an agent with a funded wallet it is a solvency problem.

## The solution

Deycid wraps a decision in an **intelligence acquisition loop**:

```
        proposed decision
                |
     confidence target + intelligence budget
                |
                v
      +--> plan the next round <--------------+
      |         |                             |
      |    buy intelligence from Telegraph    |
      |         |  (x402 micropayment)        |
      |         v                             |
      |    normalize -> stance + quality      |
      |         |                             |
      |    score confidence                   |
      |         |                             |
      |    enough? ------- no ----------------+
      |         |                     (budget & rounds permitting)
      |        yes
      |         |
      +---------+--> VERDICT + decision receipt
```

Four things stop the loop, and only four:

1. confidence reaches the target **with enough corroboration**,
2. the USDC intelligence budget is spent,
3. the round limit is reached,
4. nothing affordable is left that would change the answer.

If the bar is not met, the verdict is **ABSTAIN** — never a soft approve. Deycid fails closed.

### The differentiator: an intelligence budget

Every case carries a hard economic envelope:

```
budget            = $0.10 USDC
confidenceTarget  = 0.90
maxRounds         = 3
riskTolerance     = low
```

Deycid tracks `allocated / spent / remaining` and checks `estimatedCost <= remainingBudget` **before every single purchase**. Two independent brakes enforce it: the case budget in the decision engine, and a per-call ceiling inside the x402 client's spend controls. A case can never overspend its envelope.

---

## Why Telegraph

Deycid does not replace, reimplement, or route around any part of Telegraph. It is a consumer of Telegraph's existing intelligence infrastructure.

```
Deycid
  |  declares an intelligence need in natural language
  v
Telegraph Engine
  |  LLM router classifies the query into a canonical Intent
  v
probabilistic routing, weighted by leaderboard rank
  |
  v
ranked Miners  ->  answer  ->  validator scoring, BFT consensus
  |
  v
verified intelligence + signal hash
  |
  v
Deycid decision engine
```

Decentralised intelligence matters here for a reason specific to autonomous decisions. An agent that buys its facts from a single API inherits that API's blind spots, outages, and incentives, and has no way to tell a good answer from a bad one. Telegraph's Miners are continuously graded by validators against scraped ground truth, ranked per-Intent, and routed to probabilistically by rank — so quality compounds with usage, and a downstream application gets something a plain aggregator cannot offer: **an answer that something other than the vendor has an incentive to check.**

That is exactly what a confidence engine needs underneath it.

### What Deycid does *not* do

- It is **not a Miner** and registers nothing on-chain.
- It defines **no custom Intent**. Every intent it uses is canonical, verified live against `GET /engine/v1/intents`.
- It implements **no routing algorithm**. It cannot and does not pick a Miner — it asks, and Telegraph routes.

One protocol detail shapes the whole design and is worth stating plainly: **`POST /engine/v1/ask` does not accept an intent.** It takes a natural-language `query`, and Telegraph's own router classifies it. So Deycid shapes a query intended to reach a given intent, then reads back the `intent` Telegraph actually chose. Both are recorded on every piece of evidence, and a mismatch **discounts** that evidence rather than being hidden. You can see this in any receipt: the "Intent requested" and "Routed to" columns are separate, and a divergence is bolded.

---

## Whose confidence is this?

This distinction is load-bearing, so Deycid is explicit about it everywhere.

Telegraph's `POST /engine/v1/ask` returns **no per-response confidence score**. Every confidence number Deycid reports is therefore **Deycid confidence** — computed by Deycid, labelled as such in the code, the logs, the MCP responses, and the footer of every receipt. There is no field in this project that presents an application-computed number as if the protocol produced it.

What Deycid *does* use are real, observable properties of each Telegraph exchange:

| Input | Where it comes from |
|---|---|
| Scoring tier (A deterministic / B LLM-judge) | The intent's documented Telegraph tier |
| Routing match | `intent` in the ask response vs. what Deycid aimed for |
| Signal recording | `signal_hash` present on the response |
| Warnings | `warnings[]` on the response |
| Cost | `cost_usd` on the response, and the signed x402 amount |
| Read quality | How cleanly Deycid's normalizer could read the miner's output |
| Freshness | `timestamp` vs. the intent's half-life |

---

## Architecture

```
                    MCP client (Claude Desktop / Cursor / any MCP agent)
                                        |
                                 JSON-RPC over stdio
                                        |
  +-------------------------------------v--------------------------------------+
  |                              Deycid MCP server                              |
  |                                                                             |
  |   mcp/tools.ts     evaluate_decision | case_status | network_status          |
  |         |                                                                   |
  |   decision/                                                                 |
  |     case-manager.ts       the acquisition loop, budget ledger, state machine |
  |     policy-engine.ts      risk tolerance -> targets, ceilings, tolerances    |
  |     evidence-strategy.ts  facet extraction, information value, round planning|
  |     confidence-engine.ts  weights, aggregation, contradiction detection      |
  |     receipt.ts            JSON + Markdown decision receipts                  |
  |         |                                                                   |
  |   telegraph/                                                                |
  |     intents.ts        registry: query builders, tiers, half-lives, relevance |
  |     client.ts         the ONLY module that knows Telegraph's wire format     |
  |     normalizer.ts     deterministic stance extraction from miner output      |
  |         |                                                                   |
  |   payments/                                                                 |
  |     wallet.ts         viem LocalAccount; the key never leaves this file      |
  |     x402-client.ts    @x402 exchange, spend controls, settlement capture     |
  +-------------------------------------|--------------------------------------+
                                        |
                             HTTPS + x402 micropayments
                                        |
                    Telegraph node (devnode.telegraphprotocol.com)
                          /engine  ask, intents, signals
                          /api     miner discovery
```

The decision engine talks to `TelegraphClientLike` and has never heard of HTTP. That boundary is what makes the loop testable without spending USDC.

### The confidence model

Per evidence item:

```
weight = reliability x relevance x freshness
```

- **reliability** — starts at the Telegraph scoring tier (A: 0.92, B: 0.74), then multiplied by read quality (HIGH 1.0 / MEDIUM 0.88 / LOW 0.70), routing match (x0.82 on a mismatch), signal recording (x0.90 when absent), and warnings (x0.93 each, capped at three).
- **relevance** — the intent registry's base relevance for an on-chain execution decision, lifted 10% when the case actually carries the fact the intent needs, halved when it does not.
- **freshness** — `2^(-age / halfLife)`. Exactly 0.5 at one half-life. A price half-lives in 10 minutes; a mined transaction in 24 hours.

Aggregated across the case, where `S` and `C` are the summed weights of SUPPORTS and CONTRADICTS evidence (NEUTRAL and UNCERTAIN carry no direction and contribute nothing):

```
evidenceStrength    E = 1 - exp(-(S + C) / 1.15)
agreement           A = max(S, C) / (S + C)                 0.5 .. 1
corroboration       R = 1 - exp(-0.85 x distinctIntents)
contradictionRatio  p = min(S, C) / (S + C)                 0 .. 0.5

confidence = E x A x R x (1 - p x policy.contradictionPenaltyWeight)
```

Averaging the item confidences is deliberately avoided. Two agreeing sources should beat one, and a contradiction should cost more than it gains — the product form gives both, every factor is bounded on `[0,1]`, and a hard ceiling of 0.99 means nothing is ever certain.

When `p` exceeds the policy's tolerance, Deycid declares a **material conflict** and reopens research *even if confidence looks adequate*. Disagreement is precisely when one more deterministic answer is worth its price.

### Adaptive acquisition

Deycid does not run a fixed list of intents. Each round it ranks every candidate by expected information value per dollar:

```
novelty  = 0.35 ^ (times this intent already bought)
EIV      = relevance x tierReliability x novelty x (1 + boosts)
score    = EIV / estimatedCost
```

Boosts apply when the case is in material conflict (favouring a deterministic tie-breaker) or has no directional evidence at all. Candidates whose required facts the case lacks are never considered — there is no "always applicable" intent, so Deycid cannot spend money researching a question it has no purchase on.

### Reading what a miner said

Telegraph routes **probabilistically**, so the same intent comes back in a different shape on different calls — one run returned `CRYPTO_PRICE` as `{ price: 0.9999 }`, the next as the prose `"USDC (USDC): $0.9998 USD."`. Deycid's normalizer is therefore shape-agnostic, running four passes in descending order of trust: structured markers (HIGH), status strings (MEDIUM), stated currency figures (MEDIUM), and keyword polarity (LOW). If none produce a reading the stance is `UNCERTAIN`, which carries no weight — an unreadable answer can never manufacture confidence.

Three rules exist because earlier versions got **real** answers wrong, and each is pinned by a fixture built from an actual miner response:

- **Negation.** A fraud miner answering *"No evidence links this address to known scams, drains or phishing"* contains every alarming word in the lexicon. Read naively it becomes an accusation. Polarity terms are scored per sentence, and a negator before the term flips its sign.
- **Scope.** Miners echo the request back, and search miners return source documents about something else entirely — one returned an unrelated JFrog CVE advisory. Only fields carrying the miner's own conclusion are read, and the echoed request is subtracted.
- **Metadata.** `provenance_events[].status: "SUCCESS"` is pipeline bookkeeping, not a claim about your decision. Metadata paths are excluded from every pass.

---

## Decision policies

Keyed by risk tolerance, and monotonic: the *less* risk you tolerate, the *more* confidence Deycid must reach.

| Policy | Confidence target | Max contradiction | Corroborating intents | Budget cap | Rounds |
|---|---:|---:|---:|---:|---:|
| `LOW_RISK_TOLERANCE` | 0.95 | 0.10 | 3 | $1.00 | 4 |
| `MEDIUM_RISK_TOLERANCE` | 0.90 | 0.20 | 2 | $0.50 | 3 |
| `HIGH_RISK_TOLERANCE` | 0.80 | 0.30 | 1 | $0.25 | 2 |

An explicit `confidenceThreshold` overrides the band; the rest of the policy still applies. A caller may always ask for stricter terms, never looser ones — requested budgets and round counts are clamped to the policy ceiling.

---

## Intents

Nine canonical Telegraph intents, all verified live with active miners:

| Intent | Tier | Live miners | Contributes |
|---|---|---:|---|
| `ONCHAIN_TX_LOOKUP` | A | 12 | Whether the transaction exists and what state it settled in |
| `WALLET_BALANCE_CHECK` | A | 10 | Whether the wallet holds the funds the action needs |
| `CRYPTO_PRICE` | A | 14 | Whether the asset is priced where the decision assumes |
| `TVL_LOOKUP` | A | 10 | Whether the counterparty protocol still holds liquidity |
| `GAS_PRICE` | A | 9 | Whether execution is unusually expensive right now |
| `URL_SCAN` | A | 10 | Whether a URL in the action is flagged malicious |
| `FRAUD_DETECTION` | B | 15 | Whether the counterparty carries a known fraud signal |
| `NEWS_SEARCH` | B | 5 | Whether a recent public incident should stop the action |
| `RESEARCH_QUERY` | B | 7 | Open-ended background when structured evidence runs out |

Adding another is a single entry in [`src/telegraph/intents.ts`](src/telegraph/intents.ts) — a query builder, a tier, a half-life, and the facts it needs. Miner counts above were read from `/engine/v1/intents`; check `deycid_network_status` for the live figure.

---

## Example

```jsonc
// deycid_evaluate_decision
{
  "decision": "Should I execute this transaction supplying USDC to Aave?",
  "transactionHash": "0x7a44...",
  "chain": "base",
  "riskTolerance": "low",
  "confidenceThreshold": 0.90,
  "intelligenceBudgetUsdc": 0.10
}
```

Deycid extracts the facts it can act on (transaction hash, `USDC`, `aave`, chain), ranks the intents those facts unlock, buys the top few, reads each answer, scores, and either stops or escalates.

The demo log on stderr:

```
[Deycid] Case #1042 created
[Deycid] Confidence target: 90%
[Deycid] Intelligence budget: $0.10 (policy LOW_RISK_TOLERANCE)
[Deycid] Opening evidence round 1
[Deycid] Requesting ONCHAIN_TX_LOOKUP
[Deycid] Intelligence received — SUPPORTS (Deycid item confidence 91%, HIGH read)
[Deycid] Requesting TVL_LOOKUP
[Deycid] Intelligence received — SUPPORTS (Deycid item confidence 88%, HIGH read)
[Deycid] Aggregate Deycid confidence: 79% (target 90%)
[Deycid] Evidence insufficient — Confidence 0.790 is below target 0.9.
[Deycid] Opening evidence round 2
[Deycid] Requesting CRYPTO_PRICE
[Deycid] Intelligence received — SUPPORTS (Deycid item confidence 86%, HIGH read)
[Deycid] Aggregate Deycid confidence: 93% (target 90%)
[Deycid] VERDICT: APPROVE (Confidence target reached with sufficient corroboration.)
```

And the returned receipt (Markdown alongside structured JSON):

```markdown
## Deycid Decision #1042

**Verdict:** APPROVE

**Deycid confidence:** 93% · **Required:** 90% · **Policy:** LOW_RISK_TOLERANCE

### Evidence

| Round | Intent requested | Routed to | Miner | Finding | Deycid conf. | Stance |
|---:|---|---|---|---|---:|---|
| 1 | ONCHAIN_TX_LOOKUP | ONCHAIN_TX_LOOKUP | ... | Evidence favours proceeding: status="success" | 91% | SUPPORTS |
| 1 | TVL_LOOKUP | TVL_LOOKUP | ... | Evidence favours proceeding: tvl=... | 88% | SUPPORTS |
| 2 | CRYPTO_PRICE | CRYPTO_PRICE | ... | Evidence favours proceeding: price=... | 86% | SUPPORTS |

### Intelligence economics

- Budget: $0.1000
- Spent: $0.0300
- Remaining: $0.0700
- Rounds: 2 of 4
```

Plus the confidence derivation line by line, every x402 payment with its settlement transaction, and every Telegraph signal hash so the whole thing can be re-checked at `GET /engine/v1/signal/{hash}`.

---

## MCP tools

### `deycid_evaluate_decision`

Runs the acquisition loop. **Spends real USDC.**

| Field | Type | Notes |
|---|---|---|
| `decision` | string | Required, min 8 chars. The proposed action as a question. |
| `context` | string | Free text: addresses, protocol names, amounts, URLs. |
| `chain` | string | e.g. `base`. |
| `transactionHash` | string | Must be `0x` + 64 hex. |
| `actingAddress` | string | The wallet that would **execute** the action. Balance checks run against this; risk checks against counterparties in `context`. Without it, no balance check is bought. |
| `riskTolerance` | `low`\|`medium`\|`high` | Default `medium`. |
| `confidenceThreshold` | number | 0.01–0.99. Overrides the policy band. |
| `intelligenceBudgetUsdc` | number | Clamped to the policy ceiling. |
| `maxRounds` | integer | Clamped to the policy ceiling. |

Returns the verdict, evidence matrix, confidence derivation, budget spent, and x402 payment proofs — as Markdown and as `structuredContent`.

**`ABSTAIN` means the evidence bar was not met. Do not execute.**

### `deycid_case_status`

`{ "caseId": "case-1042" }` — the full receipt for a case from this process. Cases are in-memory and do not survive a restart.

### `deycid_usage_report`

No arguments. Summarises the Telegraph calls this installation has paid for — count, spend, intents, and the Signal hashes that prove them, each linked to Telegraph's public explorer.

It exists because of a real gap: Telegraph keys Signals to the **paying wallet**, and there is no public way to list signals for a wallet (the explorer searches by hash, miner or intent). A self-hosted application whose users each pay from their own wallet therefore cannot see its own aggregate usage unless it keeps the record itself.

**Privacy:** the log is an append-only JSONL file written **locally only**. Deycid never transmits it — sharing a report is always a deliberate act. It records only what your wallet already published to Telegraph by making the call. Set `DEYCID_USAGE_LOG=off` to disable recording entirely, or point it at a different path.

### `deycid_network_status`

No arguments, no payment. Configured intents with **live** Telegraph miner counts, the agent wallet and payment network, the policy table, and telemetry for cases this process actually ran. Nothing here is synthesized: with no cases run, averages report `—`, not a number.

---

## Setup

### From GitHub

```bash
npx -y github:sniperchief/Deycid     # runs the MCP server on stdio
```

Builds itself on install via the `prepare` script, so npm's lifecycle scripts must be allowed.

### From source

Requires **Node.js 20+**. The x402 client signs with WebCrypto, which Node 18 does not expose — on Node 18 every paid call fails with `Failed to create payment payload: Crypto API not available`.

```bash
npm install
npm run build
cp .env.example .env.local     # then set AGENT_PRIVATE_KEY
```

Deycid reads `.env.local` then `.env` at startup, and **never overwrites a variable already present in the real environment** — so a key passed in an MCP client's `env` block always wins over one left in a file. Both files are gitignored; only `.env.example` is tracked.

Fund the agent wallet with a little **Base Sepolia USDC** (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`). Each Telegraph call floors at $0.01 and rises with a demand multiplier.

> **Network note.** The Telegraph testnet node bills on **Base Sepolia** (`eip155:84532`), not Base mainnet. Deycid signs for exactly the CAIP-2 network it is configured for and refuses to fall back to another chain or asset — so pointing it at a mainnet USDC address would simply make it decline every challenge.

### Claude Desktop / Cursor (from source)

```jsonc
{
  "mcpServers": {
    "deycid": {
      "command": "node",
      "args": ["/absolute/path/to/deycid/dist/index.js"],
      "env": {
        "AGENT_PRIVATE_KEY": "0x<your burner key>",
        "DEFAULT_INTELLIGENCE_BUDGET_USDC": "0.10",
        "MAX_PAYMENT_PER_CALL_USDC": "0.05"
      }
    }
  }
}
```

Use a **burner wallet** holding only what you are willing to spend on inference.

**On timeouts.** A multi-round evaluation takes longer than the 60-second default request timeout most MCP clients use — a live run was cut off at exactly that. Deycid emits `notifications/progress` for every intelligence request, so a client that resets its deadline on progress (the MCP-specified behaviour) will wait as long as the run needs, and shows what is being bought meanwhile. If your client does not, cap the work with `maxRounds: 1` or raise its timeout.

The server starts without a key — discovery and case inspection work, and only paid calls refuse — so you can inspect the tool surface before funding anything.

---

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `AGENT_PRIVATE_KEY` | for paid calls | — | `0x` + 64 hex. Signs x402 authorizations. `TELEGRAPH_EVM_PRIVATE_KEY` is accepted as an alias (the name the official Telegraph MCP server uses); `AGENT_PRIVATE_KEY` wins if both are set. |
| `TELEGRAPH_NODE_URL` | no | `https://devnode.telegraphprotocol.com` | Used bare, e.g. `/api/miners`. |
| `TELEGRAPH_ENGINE_URL` | no | `<node>/engine` | Used bare after the prefix, e.g. `/v1/ask`. |
| `TELEGRAPH_PAYMENT_NETWORK` | no | `eip155:84532` | CAIP-2 network Deycid will sign for. |
| `MAX_PAYMENT_PER_CALL_USDC` | no | `0.05` | Hard per-call ceiling in the x402 spend controls. |
| `TELEGRAPH_REQUEST_TIMEOUT_MS` | no | `45000` | Applied to every outbound request. |
| `DEFAULT_CONFIDENCE_THRESHOLD` | no | _(policy band)_ | Operator default. Precedence: per-case value > this > the risk policy's band. Leave unset to let policies decide. |
| `DEFAULT_INTELLIGENCE_BUDGET_USDC` | no | `0.10` | Per-case override available. |
| `DEFAULT_MAX_ROUNDS` | no | `3` | Per-case override available. |
| `DEYCID_USAGE_LOG` | no | `~/.deycid/usage.jsonl` | Local usage record. Never transmitted. `off` disables it. |
| `DEYCID_WEB_PORT` | no | `8080` | Demo server port. |
| `DEYCID_WEB_PER_REQUEST_BUDGET_USDC` | no | `0.11` | Ceiling for one demo run. |
| `DEYCID_WEB_DAILY_BUDGET_USDC` | no | `2.00` | Ceiling across all visitors per UTC day. |
| `DEYCID_WEB_RATE_LIMIT_PER_HOUR` | no | `3` | Runs per visitor per hour. |
| `LOG_LEVEL` | no | `info` | `error` \| `warn` \| `info` \| `debug`. |

---

## Development

```bash
npm install
npm run typecheck   # tsc strict, src + tests
npm test            # 183 unit + integration tests
npm run build
npm run lint
npm run web         # the browser demo on :8080
npm run inspect     # MCP Inspector against the built server
```

### Testing approach

Unit tests mock the Telegraph client **at its interface** (`TelegraphClientLike`), so the decision engine is exercised without a private key and without spending USDC. The MCP suite runs a real client/server pair over an in-memory transport — the same code path Claude Desktop takes.

**Deycid ships no mock Telegraph mode.** The mock lives in `tests/helpers/` and is unreachable from `src/`. The production server always talks to a real node, as Track 3 requires.

---

## Security

`AGENT_PRIVATE_KEY` is treated as hostile-to-leak throughout:

- The key exists in exactly one place — a private field on `AgentWallet` — and is never returned, logged, or serialized. `toJSON` is overridden so an accidental `JSON.stringify(wallet)` yields only public metadata.
- Validation errors about the key **never echo its value**; viem's own error is swallowed for the same reason.
- The logger writes NDJSON to **stderr only** (stdout is the MCP transport) and passes every payload through a redactor that strips secret-looking keys and any loose 32-byte hex run.
- Untrusted upstream text is truncated before it reaches a log or an error, and miner-supplied strings are pipe-escaped before entering a Markdown table.
- `.env` is gitignored; `.env.example` carries no secrets.
- Configuration is validated at startup and the process refuses to start on a malformed one.

There are tests asserting each of these.

---

## No fabricated data

Every number Deycid reports traces to something real:

- **Payment receipts** carry the amount actually signed for and the settlement `transaction`, `payer` and `network` decoded from the facilitator's `PAYMENT-RESPONSE` header. When the facilitator does not report a field, it stays `undefined` — no placeholder is invented.
- **Signal hashes** are Telegraph's, reproduced verbatim, linked to the public explorer at `explorer.telegraphprotocol.com/signal/{hash}`, and re-checkable at `/engine/v1/signal/{hash}`. Every receipt points at third-party proof rather than asking you to trust it.
- **Miner counts** in `deycid_network_status` are read live from `/engine/v1/intents`.
- **Telemetry** covers only cases this process actually ran; with none, it reports `—`.
- **Failed acquisitions** are recorded as `FAILED` evidence with zero weight, visible in the receipt. A failed Telegraph call never becomes a silent success.
- **Confidence** is labelled `Deycid confidence` everywhere, because Telegraph returns none.

---

## Hackathon positioning

> **Deycid is a Track 3 application** consuming Telegraph's decentralised intelligence network. It is not a Miner, it registers no custom Intent, and it implements no routing algorithm. It declares intelligence needs in natural language; Telegraph classifies, routes probabilistically to ranked Miners, and returns verified answers. Deycid's contribution is the layer above: deciding *how much* verified intelligence a decision is worth, buying exactly that much, and showing its work.

Deycid exercises several of the areas the rules call high-value: on-chain intelligence pipelines feeding an execute/don't-execute gate, multi-intent cross-domain reasoning, and explicit confidence thresholds driving how much routing demand the application generates.

---

## Licence

MIT
