FROM node:20-slim

WORKDIR /app

# Install dependencies (includes wrangler, needed to run the local dev server)
COPY server/package.json server/package-lock.json ./
RUN npm ci && npm cache clean --force

# Copy server source and docker-specific config
COPY server/src/ ./src/
COPY server/tsconfig.json ./
COPY server/wrangler.docker.toml ./
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENV WRANGLER_SEND_METRICS=false

EXPOSE 8787
VOLUME /data

ENTRYPOINT ["/docker-entrypoint.sh"]
