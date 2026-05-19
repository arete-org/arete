#!/bin/sh
set -eu

RESOLUTION_JSON="$(node /usr/local/bin/trace-token-resolver.mjs)"
TRACE_API_TOKEN="$(printf '%s' "$RESOLUTION_JSON" | node -e "let d='';process.stdin.on('data',(c)=>d+=c);process.stdin.on('end',()=>{const parsed=JSON.parse(d);if(typeof parsed.token!=='string'||parsed.token.trim().length===0){process.exit(1);}process.stdout.write(parsed.token);});")"
TRACE_TOKEN_SOURCE="$(printf '%s' "$RESOLUTION_JSON" | node -e "let d='';process.stdin.on('data',(c)=>d+=c);process.stdin.on('end',()=>{const parsed=JSON.parse(d);const source=typeof parsed.source==='string'?parsed.source:'unknown';const tokenPath=typeof parsed.path==='string'?parsed.path:'';process.stdout.write(tokenPath?source+' ('+tokenPath+')':source);});")"
export TRACE_API_TOKEN
echo "TRACE_TOKEN_SOURCE=${TRACE_TOKEN_SOURCE}"

exec node /app/packages/discord-bot/dist/supervisor/serverNodeSupervisor.js
