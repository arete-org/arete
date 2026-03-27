#!/bin/sh
set -eu

REPLICA_URL="${LITESTREAM_REPLICA_URL:-}"

# Fail-open: run backend even when replication is not configured or malformed.
if [ -z "${REPLICA_URL}" ]; then
  echo "LITESTREAM_REPLICA_URL not set; starting backend without Litestream replication."
  exec node dist/server.js
fi

case "${REPLICA_URL}" in
  *://*)
    exec litestream replicate -config /etc/litestream.yml -exec "node dist/server.js"
    ;;
  *)
    echo "LITESTREAM_REPLICA_URL is invalid (${REPLICA_URL}); starting backend without Litestream replication."
    exec node dist/server.js
    ;;
esac
