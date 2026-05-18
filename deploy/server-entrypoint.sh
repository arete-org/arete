#!/bin/sh
set -eu

RESOLUTION_JSON="$(node /usr/local/bin/trace-token-resolver.mjs)"
TRACE_API_TOKEN="$(printf '%s' "$RESOLUTION_JSON" | node -e "let d='';process.stdin.on('data',(c)=>d+=c);process.stdin.on('end',()=>{const parsed=JSON.parse(d);if(typeof parsed.token!=='string'||parsed.token.trim().length===0){process.exit(1);}process.stdout.write(parsed.token);});")"
TRACE_TOKEN_SOURCE="$(printf '%s' "$RESOLUTION_JSON" | node -e "let d='';process.stdin.on('data',(c)=>d+=c);process.stdin.on('end',()=>{const parsed=JSON.parse(d);const source=typeof parsed.source==='string'?parsed.source:'unknown';const tokenPath=typeof parsed.path==='string'?parsed.path:'';process.stdout.write(tokenPath?source+' ('+tokenPath+')':source);});")"
export TRACE_API_TOKEN
echo "TRACE_TOKEN_SOURCE=${TRACE_TOKEN_SOURCE}"

BACKEND_PORT="${PORT:-3000}"
export BACKEND_BASE_URL="http://localhost:${BACKEND_PORT}"

start_backend() {
  (
    cd /app/packages/backend
    exec /usr/local/bin/backend-entrypoint.sh
  ) &
  BACKEND_PID=$!
}

start_bot() {
  (
    cd /app/packages/discord-bot
    exec node dist/index.js
  ) &
  BOT_PID=$!
}

shutdown_children() {
  if kill -0 "${BACKEND_PID}" 2>/dev/null; then
    kill -TERM "${BACKEND_PID}" 2>/dev/null || true
  fi
  if kill -0 "${BOT_PID}" 2>/dev/null; then
    kill -TERM "${BOT_PID}" 2>/dev/null || true
  fi
  wait "${BACKEND_PID}" 2>/dev/null || true
  wait "${BOT_PID}" 2>/dev/null || true
}

on_signal() {
  shutdown_children
  exit 143
}

trap on_signal INT TERM

start_backend
start_bot

while :; do
  if ! kill -0 "${BACKEND_PID}" 2>/dev/null; then
    wait "${BACKEND_PID}" || true
    echo "Backend process exited; stopping server container."
    shutdown_children
    exit 1
  fi

  if ! kill -0 "${BOT_PID}" 2>/dev/null; then
    wait "${BOT_PID}" || true
    echo "Discord node process exited; stopping server container."
    shutdown_children
    exit 1
  fi

  sleep 1
done
