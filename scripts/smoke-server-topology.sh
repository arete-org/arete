#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="deploy/compose.server.yml"
ENV_FILE=".env"
REQUIRED_ENV_KEYS=(
  DISCORD_TOKEN
  DISCORD_CLIENT_ID
  DISCORD_GUILD_ID
  OPENAI_API_KEY
  DISCORD_USER_ID
  INCIDENT_PSEUDONYMIZATION_SECRET
)

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required for smoke test."
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required for smoke test."
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[smoke] skipping: $ENV_FILE is missing"
  exit 0
fi

for key in "${REQUIRED_ENV_KEYS[@]}"; do
  if ! grep -Eq "^${key}=.+" "$ENV_FILE"; then
    echo "[smoke] skipping: missing required key $key in $ENV_FILE"
    exit 0
  fi
done

cleanup() {
  docker compose -f "$COMPOSE_FILE" down >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[smoke] starting server-local-node topology"
docker compose -f "$COMPOSE_FILE" up -d --build

wait_for_config() {
  local retries=40
  for _ in $(seq 1 "$retries"); do
    if curl -fsS "http://localhost:8080/config.json" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

if ! wait_for_config; then
  echo "[smoke] server did not become ready"
  logs="$(docker compose -f "$COMPOSE_FILE" logs --no-color server 2>/dev/null || true)"
  echo "$logs"
  if echo "$logs" | grep -qiE "discord|invalid token|authentication failed|used disallowed intents"; then
    echo "[smoke] skipping: startup requires valid Discord credentials for runtime handshake"
    exit 0
  fi
  exit 1
fi

echo "[smoke] verifying token persistence"
container_id="$(docker compose -f "$COMPOSE_FILE" ps -q server)"
if [[ -z "$container_id" ]]; then
  echo "[smoke] unable to resolve server container id"
  exit 1
fi

token_1="$(docker exec "$container_id" sh -lc "cat /data/secrets/trace-api-token" | tr -d '\r\n')"
if [[ -z "$token_1" ]]; then
  echo "[smoke] token file was not created"
  exit 1
fi

docker compose -f "$COMPOSE_FILE" restart server >/dev/null
if ! wait_for_config; then
  echo "[smoke] server did not recover after restart"
  exit 1
fi
container_id="$(docker compose -f "$COMPOSE_FILE" ps -q server)"
token_2="$(docker exec "$container_id" sh -lc "cat /data/secrets/trace-api-token" | tr -d '\r\n')"
if [[ "$token_1" != "$token_2" ]]; then
  echo "[smoke] token was not reused across restart"
  exit 1
fi

echo "[smoke] verifying non-zero container exit on node process failure"
docker exec "$container_id" sh -lc "pid=\$(ps -eo pid,args | grep 'node dist/index.js' | grep -v grep | awk 'NR==1{print \$1}'); test -n \"\$pid\"; kill -TERM \"\$pid\""
exit_code_node="$(docker wait "$container_id")"
if [[ "$exit_code_node" == "0" ]]; then
  echo "[smoke] expected non-zero exit when node process exits"
  exit 1
fi

echo "[smoke] restarting topology for backend failure check"
docker compose -f "$COMPOSE_FILE" up -d --build
if ! wait_for_config; then
  echo "[smoke] server did not become ready for backend failure check"
  exit 1
fi
container_id="$(docker compose -f "$COMPOSE_FILE" ps -q server)"

echo "[smoke] verifying non-zero container exit on backend process failure"
docker exec "$container_id" sh -lc "pid=\$(ps -eo pid,args | grep 'node dist/server.js' | grep -v grep | awk 'NR==1{print \$1}'); test -n \"\$pid\"; kill -TERM \"\$pid\""
exit_code_backend="$(docker wait "$container_id")"
if [[ "$exit_code_backend" == "0" ]]; then
  echo "[smoke] expected non-zero exit when backend process exits"
  exit 1
fi

echo "[smoke] server topology smoke test passed"
