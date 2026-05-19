#!/usr/bin/env bash
set -euo pipefail

# Removes all Fly secrets from the canonical server app.

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

get_secret_names() {
  local app_name="$1"
  fly secrets list -a "$app_name" 2>/dev/null | awk 'NR>1 {print $1}'
}

read -r -p "This will remove ALL Fly secrets for the server app. Type YES to continue: " confirm
if [[ "$confirm" != "YES" ]]; then
  echo "Aborted."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
server_app=$(get_app_name "$SCRIPT_DIR/server.toml")

echo "Clearing secrets for $server_app..."
secrets=$(get_secret_names "$server_app")
for secret in $secrets; do
  echo "Removing $secret from $server_app..."
  fly secrets unset "$secret" -a "$server_app" >/dev/null
done

