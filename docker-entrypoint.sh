#!/bin/sh
set -e

# Write Worker environment variables to .dev.vars
# wrangler dev reads this file for Worker bindings
: > .dev.vars

if [ -n "$SYNC_TOKEN" ]; then
  echo "SYNC_TOKEN=$SYNC_TOKEN" >> .dev.vars
fi

if [ -n "$YAOS_CANONICAL_REPO" ]; then
  echo "YAOS_CANONICAL_REPO=$YAOS_CANONICAL_REPO" >> .dev.vars
fi

exec npx wrangler dev \
  --config wrangler.docker.toml \
  --ip 0.0.0.0 \
  --port 8787 \
  --persist-to /data
