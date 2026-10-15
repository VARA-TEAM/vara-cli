# VARA as a service. Build:   docker build -t vara .
# Run (see deploy/docker-compose.yml for the full example):
#   docker run -d --name vara -p 127.0.0.1:7777:7777 -v vara-data:/data -v "$PWD":/workspace -e OPENAI_API_KEY vara
# The first start prints a one-time owner login link in `docker logs vara`.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY ui ./ui
# `npm run build` bundles the web interface, then compiles the host.
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
# git and ripgrep are what the agent works with; tini reaps processes and forwards SIGTERM for a clean stop.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates tini openssh-client \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory '*'
ENV NODE_ENV=production \
    VARA_HOME=/data \
    VARA_CWD=/workspace \
    VARA_BIND=0.0.0.0 \
    VARA_PORT=7777 \
    VARA_LOG=json \
    VARA_NO_UPDATE_CHECK=1
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Not root: the `node` user (uid 1000) owns the data and the working folder.
RUN mkdir -p /data /workspace && chown node:node /data /workspace
USER node
VOLUME ["/data", "/workspace"]
EXPOSE 7777
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.VARA_PORT||7777)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/dist/cli.js"]
CMD ["serve"]
