# Deycid

**Don't let an AI agent act on a guess.**

Deycid is a decision layer for autonomous agents: before an agent executes something
on-chain, Deycid buys real, verified intelligence from the [Telegraph](https://telegraphprotocol.com)
network — paying real USDC per fact — until the decision reaches the confidence it needs,
or the budget runs out. If the evidence isn't good enough, it says so and refuses to
pretend otherwise.

Built for the **Telegraph Protocol Hackathon on Base — Track 3 (AI Agent / Application)**.

### 🔗 [Try it live → deycid.vercel.app](https://deycid.vercel.app)

Press **Run decision** in the "Decision Lab" section. That's not a mock — it's the real
engine, spending real USDC against real Telegraph miners, streaming back what it's
buying and why, live.

---

## The problem

An autonomous agent about to move money usually looks like this:

```
user request  ->  LLM reasoning  ->  action
```

Nowhere in that pipeline does the agent ask *how much evidence is enough*. It has no way
to know if its information is stale, contradicted, or worth what it costs to check. For
a chatbot that's a quality problem. **For an agent with a funded wallet, it's a solvency
problem.**

## How Deycid fixes it

1. **Define** — the agent states a decision, a risk tolerance, and an intelligence budget in USDC.
2. **Acquire** — Deycid buys the most useful fact it can afford from Telegraph's decentralized miner network.
3. **Evaluate** — it scores the evidence (freshness, reliability, agreement vs. contradiction) into one confidence number.
4. **Decide** — confident enough? It stops and returns **APPROVE** or **REJECT**. Not confident enough, but still room in the budget? It buys another fact. Out of budget or rounds with no clear answer? It returns **ABSTAIN** — never a soft approve.

The result is a receipt: the verdict, every fact bought, what it cost, and a link to
verify each one on Telegraph's public explorer.

## Why this matters

- **It's economically honest.** More facts cost more money — Deycid stops buying the moment it's confident enough, instead of blindly querying everything.
- **It fails closed.** No forced answer. If the evidence doesn't clear the bar, the verdict is ABSTAIN, not a guess dressed up as a decision.
- **Nothing is fabricated.** Every confidence score, payment, and signal hash traces back to something real and independently checkable — see [No fabricated data](docs/REFERENCE.md#no-fabricated-data).

---

## Add it to your own agent

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

Fund that wallet with a little **Base Sepolia USDC** from
[faucet.circle.com](https://faucet.circle.com) — no testnet ETH needed, the facilitator
pays gas. Then just ask your agent something like:

> *Should I execute this transaction? 0x… on Base — check it with Deycid first.*

Works without a key too — discovery and case inspection still run; only paid calls refuse.

## Run the demo yourself

```bash
npm install && npm run build
npm run web        # http://localhost:8080
```

One process serves the page and the API — see [hosting it split across Vercel + Railway](docs/REFERENCE.md#hosting-the-demo)
(how this project's own live demo is deployed) for a multi-host setup.

---

## Want the deep dive?

This README is the two-minute version. Everything below lives in `docs/`:

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the acquisition loop, the confidence math, why Telegraph, how Deycid reads a miner's raw answer, the intents & policy tables, a full worked example.
- **[docs/REFERENCE.md](docs/REFERENCE.md)** — every MCP tool and its fields, environment variables, setup for Claude Desktop/Cursor, hosting, security, testing.
- **[web/README.md](web/README.md)** — the frontend (React/TS/Vite) this repo ships.

## Licence

MIT
