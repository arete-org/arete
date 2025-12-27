#!/usr/bin/env bash
set -euo pipefail

# Stops machines for backend/web/bot apps without destroying them.

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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backend_app=$(get_app_name "$SCRIPT_DIR/fly.backend.toml")
web_app=$(get_app_name "$SCRIPT_DIR/fly.web.toml")
bot_app=$(get_app_name "$SCRIPT_DIR/fly.bot.toml")

echo "Stopping backend ($backend_app)..."
for id in $(get_machine_ids "$backend_app"); do
  echo "Stopping machine $id..."
  fly machine stop "$id" -a "$backend_app" >/dev/null
done

echo "Stopping web ($web_app)..."
for id in $(get_machine_ids "$web_app"); do
  echo "Stopping machine $id..."
  fly machine stop "$id" -a "$web_app" >/dev/null
done

echo "Stopping bot ($bot_app)..."
for id in $(get_machine_ids "$bot_app"); do
  echo "Stopping machine $id..."
  fly machine stop "$id" -a "$bot_app" >/dev/null
done
