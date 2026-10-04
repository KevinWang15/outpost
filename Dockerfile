FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --offline --no-audit --no-fund

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /state && chown node:node /state
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
LABEL org.opencontainers.image.source="https://github.com/KevinWang15/outpost" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.description="Outpost hosted coding workspaces and mobile SSH terminals"
ENV NODE_ENV=production OUTPOST_MODE=hosted HOST=0.0.0.0 PORT=3000 OUTPOST_DATA_DIR=/state/outpost
USER node
EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist/server/server.js"]
