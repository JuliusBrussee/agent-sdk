# The deployable image: one agent directory served by `caveman-agent serve`.
#
# Build from your agent project root:
#   docker build -f node_modules/@caveman-ai/agent/hosting/Dockerfile -t my-agent .
#
# Runs anywhere that runs a container: Cloudflare Containers, Fly, Railway,
# Render, ECS, Kubernetes. The journal is the durability boundary, so on a
# platform with ephemeral disk point CAVE_JOURNAL_URL at a persistent journal
# (see hosting/cloudflare/) or mount a volume at /app/.caveman.
FROM node:22-slim

# The runtime shells out for host-sandbox tools; keep the base minimal but real.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Non-root: the agent's own tools should not run as root inside the image.
RUN chown -R node:node /app
USER node

ENV PORT=8080
EXPOSE 8080

# /healthz is liveness and needs no credential. /readyz reports 503 until the
# instance has swept the journal for runs a previous instance left unfinished.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "caveman-agent", "serve"]
