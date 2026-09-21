# Builds and runs the demo server (src/web/server.ts) — the one that serves the
# page and /api/status + /api/run. The MCP stdio server is a different entrypoint
# (dist/index.js) and is not what this image runs.
#
# Node 20+ is required: the x402 client signs with WebCrypto.

FROM node:22-slim AS build
WORKDIR /app

# Install with scripts off: `prepare` runs the build, and the sources aren't
# copied yet at this point.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER node
EXPOSE 8080
CMD ["node", "dist/web/index.js"]
