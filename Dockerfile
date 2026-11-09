# Flock in Docker. No npm dependencies: the image is Node plus this repo.
# Configure it with FLOCK_* environment variables, or mount a config file at
# /config/flock.config.json. See docs/configuration.md.
FROM node:24-slim

WORKDIR /app
COPY package.json ./
COPY scripts ./scripts
COPY web ./web

# Flock never needs root. The SQLite file lives on a volume owned by this user.
RUN mkdir -p /data && chown node:node /data
USER node

ENV FLOCK_HOST=0.0.0.0 \
    FLOCK_PORT=4174 \
    FLOCK_CONFIG=/config/flock.config.json \
    FLOCK_DB=/data/flock.db \
    NODE_ENV=production

EXPOSE 4174
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4174/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "scripts/serve.mjs"]
