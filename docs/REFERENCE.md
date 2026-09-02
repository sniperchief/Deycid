# Reference

See the [README](../README.md) for the pitch and quickstart, and
[ARCHITECTURE.md](./ARCHITECTURE.md) for how the engine works. This is the field-by-field
reference: MCP tools, setup, environment variables, hosting, development, security.

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

Returns the verdict, evidence matrix, confidence derivation, budget spent, and x402
payment proofs — as Markdown and as `structuredContent`.

**`ABSTAIN` means the evidence bar was not met. Do not execute.**

### `deycid_case_status`

`{ "caseId": "case-1042" }` — the full receipt for a case from this process. Cases are
in-memory and do not survive a restart.

### `deycid_usage_report`

No arguments. Summarises the Telegraph calls this installation has paid for — count,
spend, intents, and the Signal hashes that prove them, each linked to Telegraph's public
explorer.

It exists because of a real gap: Telegraph keys Signals to the **paying wallet**, and
there is no public way to list signals for a wallet (the explorer searches by hash, miner
or intent). A self-hosted application whose users each pay from their own wallet
therefore cannot see its own aggregate usage unless it keeps the record itself.

**Privacy:** the log is an append-only JSONL file written **locally only**. Deycid never
transmits it — sharing a report is always a deliberate act. It records only what your
wallet already published to Telegraph by making the call. Set `DEYCID_USAGE_LOG=off` to
disable recording entirely, or point it at a different path.

### `deycid_network_status`

No arguments, no payment. Configured intents with **live** Telegraph miner counts, the
agent wallet and payment network, the policy table, and telemetry for cases this process
actually ran. Nothing here is synthesized: with no cases run, averages report `—`, not a
number.

---

## Setup

### From GitHub

```bash
npx -y github:sniperchief/Deycid     # runs the MCP server on stdio
```

Builds itself on install via the `prepare` script, so npm's lifecycle scripts must be
allowed.

### From source

Requires **Node.js 20+**. The x402 client signs with WebCrypto, which Node 18 does not
expose — on Node 18 every paid call fails with `Failed to create payment payload: Crypto
API not available`.

```bash
npm install
npm run build
cp .env.example .env.local     # then set AGENT_PRIVATE_KEY
```

Deycid reads `.env.local` then `.env` at startup, and **never overwrites a variable
already present in the real environment** — so a key passed in an MCP client's `env`
block always wins over one left in a file. Both files are gitignored; only
`.env.example` is tracked.

Fund the agent wallet with a little **Base Sepolia USDC**
(`0x036CbD53842c5426634e7929541eC2318f3dCF7e`). Each Telegraph call floors at $0.01 and
rises with a demand multiplier.

> **Network note.** The Telegraph testnet node bills on **Base Sepolia** (`eip155:84532`),
> not Base mainnet. Deycid signs for exactly the CAIP-2 network it is configured for and
> refuses to fall back to another chain or asset — so pointing it at a mainnet USDC
> address would simply make it decline every challenge.

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

**On timeouts.** A multi-round evaluation takes longer than the 60-second default request
timeout most MCP clients use — a live run was cut off at exactly that. Deycid emits
`notifications/progress` for every intelligence request, so a client that resets its
deadline on progress (the MCP-specified behaviour) will wait as long as the run needs,
and shows what is being bought meanwhile. If your client does not, cap the work with
`maxRounds: 1` or raise its timeout.

The server starts without a key — discovery and case inspection work, and only paid
calls refuse — so you can inspect the tool surface before funding anything.

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

Frontend-only (`web/.env.example`, build-time, only needed if the frontend is deployed
separately from the backend — see below):

| Variable | Required | Purpose |
|---|---|---|
| `VITE_API_BASE_URL` | no | Base URL of the backend, e.g. `https://deycid-production.up.railway.app`. Unset means same-origin. |

---

## Hosting the demo

`src/web/server.ts` is a small Node HTTP server built on the **same engine** — no
separate code path, no simulated data. It exposes `GET /api/status` and `POST /api/run`
(Server-Sent Events); every call to `/api/run` buys real intelligence from real Telegraph
miners and pays for it with real USDC.

Because it pays from your wallet, three independent brakes guard it: a per-run budget, a
per-visitor hourly rate limit, and a hard daily ceiling across all visitors — plus the
wallet balance itself. Defaults are $0.11/run (enough for three rounds), 3 runs/hour, $2/day.

Visitors choose from a fixed set of decisions rather than free text — arbitrary questions
would let anyone spend the wallet on anything, and most off-topic questions produce
unreadable evidence that misrepresents how Deycid performs.

**Same host (simplest):** any Node host works. Build with `npm install && npm run build`,
start with `npm run web`, set `AGENT_PRIVATE_KEY` as a secret. One process serves both the
static page and `/api/*`.

**Split hosting (this project's live deploy):** the frontend (`web/`, static Vite build)
on Vercel, the backend on Railway — chosen because the backend is a long-running process
holding in-memory spend guards, which doesn't fit a stateless serverless model without
extra infrastructure (a persistent store for the rate limiter). To split them:

- Backend (Railway or similar): root directory = repo root (not `web/`); **override the
  start command to `npm run web`** (the default `npm start` runs the MCP stdio server,
  which opens no HTTP port and will 502); set `AGENT_PRIVATE_KEY`.
- Frontend (Vercel or similar static host): root directory = `web`; set
  `VITE_API_BASE_URL` to the backend's public URL and rebuild.
- `server.ts` reflects the request's `Origin` on every response and answers CORS
  preflight `OPTIONS` requests, so the browser will accept the cross-origin calls.

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

Unit tests mock the Telegraph client **at its interface** (`TelegraphClientLike`), so the
decision engine is exercised without a private key and without spending USDC. The MCP
suite runs a real client/server pair over an in-memory transport — the same code path
Claude Desktop takes.

**Deycid ships no mock Telegraph mode.** The mock lives in `tests/helpers/` and is
unreachable from `src/`. The production server always talks to a real node, as Track 3
requires.

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

> **Deycid is a Track 3 application** consuming Telegraph's decentralised intelligence
> network. It is not a Miner, it registers no custom Intent, and it implements no routing
> algorithm. It declares intelligence needs in natural language; Telegraph classifies,
> routes probabilistically to ranked Miners, and returns verified answers. Deycid's
> contribution is the layer above: deciding *how much* verified intelligence a decision
> is worth, buying exactly that much, and showing its work.

Deycid exercises several of the areas the rules call high-value: on-chain intelligence
pipelines feeding an execute/don't-execute gate, multi-intent cross-domain reasoning, and
explicit confidence thresholds driving how much routing demand the application generates.
