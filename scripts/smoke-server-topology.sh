#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="deploy/compose.server.yml"
ENV_FILE=".env"
REQUIRED_ENV_KEYS=(
  OPENAI_API_KEY
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

echo "[smoke] starting canonical server topology"
docker compose -f "$COMPOSE_FILE" up -d --build

if ! wait_for_config; then
  echo "[smoke] server did not become ready"
  docker compose -f "$COMPOSE_FILE" logs --no-color server || true
  exit 1
fi

container_id="$(docker compose -f "$COMPOSE_FILE" ps -q server)"
if [[ -z "$container_id" ]]; then
  echo "[smoke] unable to resolve server container id"
  exit 1
fi

echo "[smoke] verifying missing local-node config is fail-open"
if ! docker compose -f "$COMPOSE_FILE" logs --no-color server | grep -q "no_local_nodes_configured"; then
  echo "[smoke] expected no_local_nodes_configured log when config is missing"
  exit 1
fi

echo "[smoke] verifying token persistence"
token_1="$(docker exec "$container_id" sh -lc "if [ -f /data/secrets/trace-api-token ]; then cat /data/secrets/trace-api-token; fi" | tr -d '\r\n')"
if [[ -n "$token_1" ]]; then
  docker compose -f "$COMPOSE_FILE" restart server >/dev/null
  if ! wait_for_config; then
    echo "[smoke] server did not recover after restart"
    exit 1
  fi
  container_id="$(docker compose -f "$COMPOSE_FILE" ps -q server)"
  token_2="$(docker exec "$container_id" sh -lc "if [ -f /data/secrets/trace-api-token ]; then cat /data/secrets/trace-api-token; fi" | tr -d '\r\n')"
  if [[ "$token_1" != "$token_2" ]]; then
    echo "[smoke] token was not reused across restart"
    exit 1
  fi
else
  if ! docker compose -f "$COMPOSE_FILE" logs --no-color server | grep -q "TRACE_TOKEN_SOURCE=env"; then
    echo "[smoke] expected TRACE_TOKEN_SOURCE=env when token file was not created"
    exit 1
  fi
fi

echo "[smoke] writing optional local node config with missing credentials"
docker exec "$container_id" sh -lc "mkdir -p /data/config && cat > /data/config/local-discord-nodes.yaml <<'YAML'
version: 1
nodes:
  - id: optional-missing-creds
    required: false
    credentials:
      discordTokenEnv: OPTIONAL_NODE_DISCORD_TOKEN
      discordClientIdEnv: OPTIONAL_NODE_DISCORD_CLIENT_ID
      discordGuildIdEnv: OPTIONAL_NODE_DISCORD_GUILD_ID
      discordUserIdEnv: OPTIONAL_NODE_DISCORD_USER_ID
      incidentSecretEnv: OPTIONAL_NODE_INCIDENT_SECRET
    profile:
      id: optional-node
      displayName: Optional Node
YAML"

docker compose -f "$COMPOSE_FILE" restart server >/dev/null
if ! wait_for_config; then
  echo "[smoke] server did not recover after optional-node config restart"
  exit 1
fi

logs_after_optional="$(docker compose -f "$COMPOSE_FILE" logs --no-color server)"
if ! echo "$logs_after_optional" | grep -q "local_node_disabled"; then
  echo "[smoke] expected local_node_disabled log for optional node missing credentials"
  exit 1
fi

echo "[smoke] verifying non-zero container exit on backend process failure"
container_id="$(docker compose -f "$COMPOSE_FILE" ps -q server)"
restart_count_before="$(docker inspect -f '{{.RestartCount}}' "$container_id")"
docker exec "$container_id" sh -lc "pid=''; for proc in /proc/[0-9]*; do cmd=\$(tr '\0' ' ' < \"\$proc/cmdline\" 2>/dev/null || true); case \"\$cmd\" in *'node dist/server.js'*) pid=\${proc##*/}; break ;; esac; done; test -n \"\$pid\"; kill -TERM \"\$pid\""
for _ in $(seq 1 30); do
  restart_count_after="$(docker inspect -f '{{.RestartCount}}' "$container_id")"
  if [[ "$restart_count_after" -gt "$restart_count_before" ]]; then
    break
  fi
  sleep 1
done

restart_count_after="$(docker inspect -f '{{.RestartCount}}' "$container_id")"
if [[ "$restart_count_after" -le "$restart_count_before" ]]; then
  echo "[smoke] expected container restart after backend process exit"
  exit 1
fi

if ! docker compose -f "$COMPOSE_FILE" logs --no-color server | grep -q "backend_process_exited"; then
  echo "[smoke] expected backend_process_exited log after backend process failure"
  exit 1
fi

echo "[smoke] canonical server topology smoke test passed"
