#!/usr/bin/env bash
set -euo pipefail

# Stops machines for the canonical server app without destroying them.

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
server_app=$(get_app_name "$SCRIPT_DIR/server.toml")

echo "Stopping server ($server_app)..."
for id in $(get_machine_ids "$server_app"); do
  echo "Stopping machine $id..."
  fly machine stop "$id" -a "$server_app" >/dev/null
done

