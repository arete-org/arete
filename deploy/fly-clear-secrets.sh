#!/usr/bin/env bash
set -euo pipefail

# Removes all Fly secrets from backend/web/bot apps.

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

read -r -p "This will remove ALL Fly secrets for backend/web/bot apps. Type YES to continue: " confirm
if [[ "$confirm" != "YES" ]]; then
  echo "Aborted."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backend_app=$(get_app_name "$SCRIPT_DIR/fly.backend.toml")
web_app=$(get_app_name "$SCRIPT_DIR/fly.web.toml")
bot_app=$(get_app_name "$SCRIPT_DIR/fly.bot.toml")

for app in "$backend_app" "$web_app" "$bot_app"; do
  echo "Clearing secrets for $app..."
  secrets=$(get_secret_names "$app")
  for secret in $secrets; do
    echo "Removing $secret from $app..."
    fly secrets unset "$secret" -a "$app" >/dev/null
  done
 done
