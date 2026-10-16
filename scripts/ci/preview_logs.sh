#!/usr/bin/env bash
# Use the CLI's request-logs endpoint directly: the CI service token can read
# the project, but `vercel logs` first calls the user API, which returns 404.
# https://github.com/vercel/vercel/blob/main/packages/cli/src/util/logs-v2.ts
set -euo pipefail

: "${URL:?}" "${VERCEL_TOKEN:?}" "${VERCEL_ORG_ID:?}" "${VERCEL_PROJECT_ID:?}"
readonly MAX_RESPONSE_BYTES=2097152
readonly LOOKBACK_MS=86400000
readonly MAX_PAGES=1
response=$(mktemp)
trap 'rm -f "$response"' EXIT
auth=(-H "Authorization: Bearer $VERCEL_TOKEN")
id=$(curl -fsS --connect-timeout 10 --max-time 30 "${auth[@]}" \
  "https://api.vercel.com/v13/deployments/${URL#https://}?teamId=$VERCEL_ORG_ID" \
  | jq -er --arg project "$VERCEL_PROJECT_ID" \
    'select(.projectId == $project and .target != "production") | .id | select(type == "string" and length > 0)')
now_ms=$(($(date +%s) * 1000))
# One bounded page is enough for a failed health probe; report overflow instead
# of silently presenting an incomplete diagnostic as the complete log history.
if curl --fail-with-body -sS --get --connect-timeout 10 --max-time 30 \
  --max-filesize "$MAX_RESPONSE_BYTES" "${auth[@]}" \
  --data-urlencode "projectId=$VERCEL_PROJECT_ID" \
  --data-urlencode "ownerId=$VERCEL_ORG_ID" \
  --data-urlencode "teamId=$VERCEL_ORG_ID" \
  --data-urlencode "deploymentId=$id" \
  --data-urlencode "startDate=$((now_ms - LOOKBACK_MS))" \
  --data-urlencode "endDate=$now_ms" --data-urlencode "page=$((MAX_PAGES - 1))" \
  --output "$response" https://vercel.com/api/logs/request-logs; then
  cat "$response"
  jq -e 'if (.rows | type) != "array" then error("Invalid runtime log response")
         elif .hasMoreRows then error("Runtime logs exceed the one-page diagnostic limit")
         else true end' "$response" > /dev/null
else
  # Preserve the actual API denial, then try the public deployment-log API:
  # project service tokens need not have access to the dashboard history API.
  cat "$response" >&2
  echo 'Historical logs unavailable; reading the public runtime stream for at most 30 seconds.' >&2
  # This endpoint is a live stream. A timeout remains visible (curl exit 28);
  # do not claim a complete history when the bounded capture ends.
  curl --fail-with-body -sS --no-buffer --connect-timeout 10 --max-time 30 \
    --max-filesize "$MAX_RESPONSE_BYTES" "${auth[@]}" \
    "https://api.vercel.com/v1/projects/$VERCEL_PROJECT_ID/deployments/$id/runtime-logs?teamId=$VERCEL_ORG_ID&format=lines"
fi
