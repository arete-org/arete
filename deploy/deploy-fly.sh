#!/usr/bin/env bash
set -euo pipefail

# Deploys backend/web/bot Fly apps, ensuring secrets are set and machines are running.

if ! command -v fly >/dev/null 2>&1; then
  echo "Fly CLI is required. Install from https://fly.io/docs/flyctl/install/"
  exit 1
fi

get_app_name() {
  local config_path="$1"
  # Extract app name from fly.toml to keep scripts DRY.
  local line
  line=$(grep -E "^app\\s*=" "$config_path" | head -n 1 || true)
  if [[ -z "$line" ]]; then
    echo "Unable to find app name in $config_path" >&2
    exit 1
  fi
  echo "$line" | sed -E "s/^app\\s*=\\s*['\\\"]([^'\\\"]+)['\\\"].*/\\1/"
}

ensure_app() {
  local config_path="$1"
  # Create app if missing; no-op when it already exists.
  local app_name
  app_name=$(get_app_name "$config_path")
  set +e
  output=$(fly apps create "$app_name" 2>&1)
  status=$?
  set -e
  if [[ $status -ne 0 ]]; then
    if echo "$output" | grep -qiE "already exists|already taken|name has already been taken"; then
      echo "Fly app already exists: $app_name"
      return
    fi
    echo "$output"
    exit 1
  fi
  echo "Created Fly app: $app_name"
}

get_secret_names() {
  local app_name="$1"
  # Read existing secrets so we only prompt for missing values.
  fly secrets list -a "$app_name" 2>/dev/null | awk 'NR>1 {print $1}'
}

get_env_value() {
  local env_path="$1"
  local key="$2"
  # Load a specific key from .env, if present.
  [[ -f "$env_path" ]] || return 1
  local line
  line=$(grep -E "^${key}=" "$env_path" | head -n 1 || true)
  if [[ -z "$line" ]]; then
    return 1
  fi
  echo "${line#*=}"
}

get_or_create_trace_token() {
  local env_path="$1"
  local existing
  existing=$(get_env_value "$env_path" "TRACE_API_TOKEN" || true)
  if [[ -n "$existing" ]]; then
    echo "$existing"
    return
  fi

  local token
  token=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  echo "Generated TRACE_API_TOKEN for deployment."

  if [[ -f "$env_path" ]]; then
    if grep -q "^TRACE_API_TOKEN=" "$env_path"; then
      sed -i "s/^TRACE_API_TOKEN=.*/TRACE_API_TOKEN=${token}/" "$env_path"
    else
      echo "TRACE_API_TOKEN=${token}" >> "$env_path"
    fi
  else
    echo "TRACE_API_TOKEN=${token}" > "$env_path"
  fi

  echo "$token"
}

ensure_secrets() {
  local app_name="$1"
  shift
  local required_secrets=("$@")
  # Prompt only for missing secrets; prefer .env values when available.
  echo "Checking secrets for $app_name..."
  local existing
  existing=$(get_secret_names "$app_name")
  local env_path="${SCRIPT_DIR}/../.env"

  for secret in "${required_secrets[@]}"; do
    if ! echo "$existing" | grep -qx "$secret"; then
      echo "Setting required secret $secret for $app_name..."
      value=$(get_env_value "$env_path" "$secret" || true)
      if [[ -n "$value" ]]; then
        echo "Using $secret from $env_path."
      elif [[ "$secret" == "TRACE_API_TOKEN" ]]; then
        value=$(get_or_create_trace_token "$env_path")
      else
        read -r -p "Enter value for $secret (required for $app_name): " value
      fi
      if [[ -z "$value" ]]; then
        echo "Missing required secret $secret for $app_name"
        exit 1
      fi
      fly secrets set "$secret=$value" -a "$app_name" >/dev/null
      echo "Set $secret for $app_name."
    fi
  done
}

ensure_optional_secrets() {
  local app_name="$1"
  shift
  local optional_secrets=("$@")
  echo "Checking optional secrets for $app_name..."
  local existing
  existing=$(get_secret_names "$app_name")
  local env_path="${SCRIPT_DIR}/../.env"

  for secret in "${optional_secrets[@]}"; do
    if ! echo "$existing" | grep -qx "$secret"; then
      echo "Setting optional secret $secret for $app_name..."
      value=$(get_env_value "$env_path" "$secret" || true)
      if [[ -n "$value" ]]; then
        echo "Using $secret from $env_path."
      else
        read -r -p "Enter value for $secret (optional for $app_name, leave blank to skip): " value
      fi
      if [[ -n "$value" ]]; then
        fly secrets set "$secret=$value" -a "$app_name" >/dev/null
        echo "Set $secret for $app_name."
      else
        echo "Skipped $secret for $app_name."
      fi
    fi
  done
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Ensuring Fly apps exist..."
ensure_app "$SCRIPT_DIR/fly.backend.toml"
ensure_app "$SCRIPT_DIR/fly.web.toml"
ensure_app "$SCRIPT_DIR/fly.bot.toml"

bot_app_name=$(get_app_name "$SCRIPT_DIR/fly.bot.toml")
backend_app_name=$(get_app_name "$SCRIPT_DIR/fly.backend.toml")
web_app_name=$(get_app_name "$SCRIPT_DIR/fly.web.toml")

echo "Configuring backend secrets..."
ensure_secrets "$backend_app_name" OPENAI_API_KEY TRACE_API_TOKEN
ensure_optional_secrets "$backend_app_name" TURNSTILE_SECRET_KEY TURNSTILE_SITE_KEY GITHUB_WEBHOOK_SECRET

echo "Configuring bot secrets..."
ensure_secrets "$bot_app_name" DISCORD_TOKEN CLIENT_ID GUILD_ID OPENAI_API_KEY DEVELOPER_USER_ID INCIDENT_PSEUDONYMIZATION_SECRET TRACE_API_TOKEN
ensure_optional_secrets "$bot_app_name" CLOUDINARY_CLOUD_NAME CLOUDINARY_API_KEY CLOUDINARY_API_SECRET

echo "Deploying backend..."
fly deploy -c "$SCRIPT_DIR/fly.backend.toml"
echo "Scaling backend to one instance..."
fly scale count 1 -a "$backend_app_name" -y
echo "Deploying web..."
fly deploy -c "$SCRIPT_DIR/fly.web.toml"
echo "Scaling web to one instance..."
fly scale count 1 -a "$web_app_name" -y
echo "Deploying bot..."
fly deploy -c "$SCRIPT_DIR/fly.bot.toml"

echo "Scaling bot to one instance..."
fly scale count 1 -a "$bot_app_name" -y

if [[ -f "$SCRIPT_DIR/fly-start.sh" ]]; then
  echo "Starting all apps..."
  bash "$SCRIPT_DIR/fly-start.sh"
fi
