# Architecture & how the confidence model works

See the [README](../README.md) for the pitch. This is the deep dive: the acquisition
loop, the confidence math, how Deycid reads Telegraph's answers, and the full module
map.

---

## The acquisition loop

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

### The intelligence budget

Every case carries a hard economic envelope:

```
budget            = $0.10 USDC
confidenceTarget  = 0.90
maxRounds         = 3
riskTolerance     = low
```

Deycid tracks `allocated / spent / remaining` and checks `estimatedCost <= remainingBudget`
**before every single purchase**. Two independent brakes enforce it: the case budget in the
decision engine, and a per-call ceiling inside the x402 client's spend controls. A case can
never overspend its envelope.

---

## Why Telegraph

Deycid does not replace, reimplement, or route around any part of Telegraph. It is a
consumer of Telegraph's existing intelligence infrastructure.

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

An agent that buys its facts from a single API inherits that API's blind spots, outages,
and incentives, and has no way to tell a good answer from a bad one. Telegraph's Miners are
continuously graded by validators against scraped ground truth, ranked per-Intent, and
routed to probabilistically by rank — so quality compounds with usage, and a downstream
application gets something a plain aggregator cannot offer: an answer that something other
than the vendor has an incentive to check. That is exactly what a confidence engine needs
underneath it.

### What Deycid does *not* do

- It is **not a Miner** and registers nothing on-chain.
- It defines **no custom Intent**. Every intent it uses is canonical, verified live against `GET /engine/v1/intents`.
- It implements **no routing algorithm**. It cannot and does not pick a Miner — it asks, and Telegraph routes.

One protocol detail shapes the whole design: **`POST /engine/v1/ask` does not accept an
intent.** It takes a natural-language `query`, and Telegraph's own router classifies it. So
Deycid shapes a query intended to reach a given intent, then reads back the `intent`
Telegraph actually chose. Both are recorded on every piece of evidence, and a mismatch
**discounts** that evidence rather than being hidden.

### Whose confidence is this?

Telegraph's `POST /engine/v1/ask` returns **no per-response confidence score**. Every
confidence number Deycid reports is therefore **Deycid confidence** — computed by Deycid,
labelled as such in the code, the logs, the MCP responses, and the footer of every receipt.

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

## Module map

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

The decision engine talks to `TelegraphClientLike` and has never heard of HTTP. That
boundary is what makes the loop testable without spending USDC.

---

## The confidence model

Per evidence item:

```
weight = reliability x relevance x freshness
```

- **reliability** — starts at the Telegraph scoring tier (A: 0.92, B: 0.74), then multiplied by read quality (HIGH 1.0 / MEDIUM 0.88 / LOW 0.70), routing match (x0.82 on a mismatch), signal recording (x0.90 when absent), and warnings (x0.93 each, capped at three).
- **relevance** — the intent registry's base relevance for an on-chain execution decision, lifted 10% when the case actually carries the fact the intent needs, halved when it does not.
- **freshness** — `2^(-age / halfLife)`. Exactly 0.5 at one half-life. A price half-lives in 10 minutes; a mined transaction in 24 hours.

Aggregated across the case, where `S` and `C` are the summed weights of SUPPORTS and
CONTRADICTS evidence (NEUTRAL and UNCERTAIN carry no direction and contribute nothing):

```
evidenceStrength    E = 1 - exp(-(S + C) / 1.15)
agreement           A = max(S, C) / (S + C)                 0.5 .. 1
corroboration       R = 1 - exp(-0.85 x distinctIntents)
contradictionRatio  p = min(S, C) / (S + C)                 0 .. 0.5

confidence = E x A x R x (1 - p x policy.contradictionPenaltyWeight)
```

Averaging the item confidences is deliberately avoided. Two agreeing sources should beat
one, and a contradiction should cost more than it gains — the product form gives both,
every factor is bounded on `[0,1]`, and a hard ceiling of 0.99 means nothing is ever
certain.

When `p` exceeds the policy's tolerance, Deycid declares a **material conflict** and
reopens research *even if confidence looks adequate*. Disagreement is precisely when one
more deterministic answer is worth its price.

### Adaptive acquisition

Deycid does not run a fixed list of intents. Each round it ranks every candidate by
expected information value per dollar:

```
novelty  = 0.35 ^ (times this intent already bought)
EIV      = relevance x tierReliability x novelty x (1 + boosts)
score    = EIV / estimatedCost
```

Boosts apply when the case is in material conflict (favouring a deterministic
tie-breaker) or has no directional evidence at all. Candidates whose required facts the
case lacks are never considered — there is no "always applicable" intent, so Deycid
cannot spend money researching a question it has no purchase on.

### Reading what a miner said

Telegraph routes **probabilistically**, so the same intent comes back in a different
shape on different calls — one run returned `CRYPTO_PRICE` as `{ price: 0.9999 }`, the
next as the prose `"USDC (USDC): $0.9998 USD."`. Deycid's normalizer is therefore
shape-agnostic, running four passes in descending order of trust: structured markers
(HIGH), status strings (MEDIUM), stated currency figures (MEDIUM), and keyword polarity
(LOW). If none produce a reading the stance is `UNCERTAIN`, which carries no weight — an
unreadable answer can never manufacture confidence.

Three rules exist because earlier versions got **real** answers wrong, and each is
pinned by a fixture built from an actual miner response:

- **Negation.** A fraud miner answering *"No evidence links this address to known scams, drains or phishing"* contains every alarming word in the lexicon. Read naively it becomes an accusation. Polarity terms are scored per sentence, and a negator before the term flips its sign.
- **Scope.** Miners echo the request back, and search miners return source documents about something else entirely — one returned an unrelated JFrog CVE advisory. Only fields carrying the miner's own conclusion are read, and the echoed request is subtracted.
- **Metadata.** `provenance_events[].status: "SUCCESS"` is pipeline bookkeeping, not a claim about your decision. Metadata paths are excluded from every pass.

---

## Decision policies

Keyed by risk tolerance, and monotonic: the *less* risk you tolerate, the *more*
confidence Deycid must reach.

| Policy | Confidence target | Max contradiction | Corroborating intents | Budget cap | Rounds |
|---|---:|---:|---:|---:|---:|
| `LOW_RISK_TOLERANCE` | 0.95 | 0.10 | 3 | $1.00 | 4 |
| `MEDIUM_RISK_TOLERANCE` | 0.90 | 0.20 | 2 | $0.50 | 3 |
| `HIGH_RISK_TOLERANCE` | 0.80 | 0.30 | 1 | $0.25 | 2 |

An explicit `confidenceThreshold` overrides the band; the rest of the policy still
applies. A caller may always ask for stricter terms, never looser ones — requested
budgets and round counts are clamped to the policy ceiling.

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

Adding another is a single entry in [`src/telegraph/intents.ts`](../src/telegraph/intents.ts)
— a query builder, a tier, a half-life, and the facts it needs. Miner counts above were
read from `/engine/v1/intents`; check `deycid_network_status` for the live figure.

---

## A full run, end to end

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

Deycid extracts the facts it can act on (transaction hash, `USDC`, `aave`, chain), ranks
the intents those facts unlock, buys the top few, reads each answer, scores, and either
stops or escalates.

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

Plus the confidence derivation line by line, every x402 payment with its settlement
transaction, and every Telegraph signal hash so the whole thing can be re-checked at
`GET /engine/v1/signal/{hash}`.
