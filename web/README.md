# Deycid web

The marketing/product frontend — React + TypeScript + Vite + Tailwind. Live at
[deycid.vercel.app](https://deycid.vercel.app). It builds to a single self-contained
`dist/index.html` (via `vite-plugin-singlefile`) that gets copied over
`../src/web/public/index.html`, which `src/web/server.ts` reads and serves at `/` as-is. That
server also exposes the real `/api/status` and `/api/run` (SSE) endpoints — see the root
[README](../README.md) and [docs/REFERENCE.md](../docs/REFERENCE.md#hosting-the-demo).

The "Decision Lab" section (`src/components/DecisionLab.tsx`, `src/hooks/useLiveDecision.ts`)
calls those endpoints directly — there is no mock data path. Pressing "Run decision" spends real
USDC against real Telegraph miners from the operator's wallet, subject to the same rate limits
`server.ts` already enforces.

This site's own live deploy runs split: this frontend on Vercel, the backend on Railway. When
deployed that way, set `VITE_API_BASE_URL` (see `.env.example`) to the backend's public URL at
build time — see [docs/REFERENCE.md](../docs/REFERENCE.md#hosting-the-demo) for the full setup.

## Develop

```bash
npm install
npm run dev        # Vite dev server with HMR
```

`vite.config.ts` proxies `/api/*` to `http://localhost:8080` by default (override with
`DEYCID_API_PROXY_TARGET`), so run the real server alongside it from the repo root:

```bash
npm run build && npm run web   # from the repo root, in another terminal
```

## Publish a change

```bash
npm run build       # typecheck, build, then overwrite ../src/web/public/index.html
```

Commit the updated `src/web/public/index.html` alongside your `web/` changes — it's the artifact
the Node server actually serves, and there is no build step in the deploy path that regenerates
it from `web/`.

## Illustrative example data

`src/data/illustrative.ts` holds fixed numbers used only as a placeholder — labelled "Example" via
`DataBadge` — in the confidence-scale, intelligence-budget, and evidence-matrix sections, shown
until a visitor completes a real run in the Decision Lab. `DecisionRunContext` holds the one live
`useLiveDecision()` instance shared by all of them; once a run finishes, those sections read its
`receipt` and switch their badge to "Live result".
