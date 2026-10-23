#!/usr/bin/env bash
# Use the CLI's request-logs endpoint directly: the CI service token can read
# the project, but `vercel logs` first calls the user API, which returns 404.
# https://github.com/vercel/vercel/blob/main/packages/cli/src/util/logs-v2.ts
set -euo pipefail

: "${URL:?}" "${VERCEL_TOKEN:?}" "${VERCEL_ORG_ID:?}" "${VERCEL_PROJECT_ID:?}"
readonly MAX_RESPONSE_BYTES=2097152
readonly LOOKBACK_MS=86400000
readonly MAX_PAGES=1
readonly LIVE_CAPTURE_SECONDS=90
readonly STREAM_START_POLLS=20
response=$(mktemp)
headers=$(mktemp)
trap 'rm -f "$response" "$headers"' EXIT
auth=(-H "Authorization: Bearer $VERCEL_TOKEN")
id=$(curl -fsS --connect-timeout 10 --max-time 30 "${auth[@]}" \
  "https://api.vercel.com/v13/deployments/${URL#https://}?teamId=$VERCEL_ORG_ID" \
  | jq -er --arg project "$VERCEL_PROJECT_ID" \
    'select(.projectId == $project and .target != "production") | .id | select(type == "string" and length > 0)')

if [[ -n "${BYPASS:-}" ]]; then
  # Subscribe before boot: the public endpoint has no historical replay.
  # The separate health request used to finish before this subscription began.
  curl --fail-with-body -sS --no-buffer --connect-timeout 10 \
    --max-time "$LIVE_CAPTURE_SECONDS" --max-filesize "$MAX_RESPONSE_BYTES" \
    --dump-header "$headers" "${auth[@]}" \
    "https://api.vercel.com/v1/projects/$VERCEL_PROJECT_ID/deployments/$id/runtime-logs?teamId=$VERCEL_ORG_ID&format=lines" \
    > "$response" &
  stream_pid=$!
  for attempt in $(seq 1 "$STREAM_START_POLLS"); do
    if grep -Eq '^HTTP/[^ ]+ 200' "$headers"; then
      break
    fi
    sleep 0.25
  done
  health_status=1
  # Some stream servers flush headers only with the first event. After the
  # bounded connection wait, an open subscription must be allowed to trigger
  # that first event; an explicit HTTP rejection must not invoke health.
  if kill -0 "$stream_pid" 2>/dev/null && ! grep -Eq '^HTTP/[^ ]+ [45][0-9][0-9]' "$headers"; then
    if curl --fail-with-body -sS --connect-timeout 10 --max-time 60 \
      -H "x-vercel-protection-bypass: $BYPASS" "$URL/api/health" \
      | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"; then
      health_status=0
    else
      health_status=$?
    fi
  else
    echo 'Runtime log subscription did not become ready; health was not invoked.' >&2
  fi
  stream_status=0
  wait "$stream_pid" || stream_status=$?
  cat "$response"
  if [[ "$stream_status" == 28 ]]; then
    echo "Live log capture ended at its ${LIVE_CAPTURE_SECONDS}s limit; this is not a complete history." >&2
  fi
  if [[ "$health_status" != 0 ]]; then
    exit "$health_status"
  fi
  exit "$stream_status"
fi

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
