#!/usr/bin/env bash
set -euo pipefail

# Starts machines for backend/web/bot apps (safe restart after stop).

get_app_name() {
  local config_path="$1"
  # Extract app name from fly.toml to keep scripts DRY.
  local line
  line=$(grep -E "^app\s*=" "$config_path" | head -n 1 || true)
  if [[ -z "$line" ]]; then
    echo "Unable to find app name in $config_path" >&2
    exit 1
  fi
  echo "$line" | sed -E "s/^app\s*=\s*['\"]([^'\"]+)['\"].*/\1/"
}

get_machine_ids() {
  local app_name="$1"
  fly machines list -a "$app_name" 2>/dev/null | awk 'NR>1 {print $1}'
}

start_machines() {
  local app_name="$1"
  local ids
  ids=$(get_machine_ids "$app_name")
  if [[ -z "$ids" ]]; then
    fly scale count 1 -a "$app_name" -y >/dev/null
    return
  fi
  for id in $ids; do
    echo "Starting machine $id..."
    fly machine start "$id" -a "$app_name" >/dev/null
  done
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backend_app=$(get_app_name "$SCRIPT_DIR/fly.backend.toml")
web_app=$(get_app_name "$SCRIPT_DIR/fly.web.toml")
bot_app=$(get_app_name "$SCRIPT_DIR/fly.bot.toml")

echo "Restarting backend ($backend_app)..."
start_machines "$backend_app"
echo "Restarting web ($web_app)..."
start_machines "$web_app"
echo "Restarting bot ($bot_app)..."
start_machines "$bot_app"
