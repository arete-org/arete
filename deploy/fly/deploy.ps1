$ErrorActionPreference = 'Stop'

# Deploys the canonical server Fly app, ensuring required secrets are set.

if (-not (Get-Command fly -ErrorAction SilentlyContinue)) {
  Write-Host "Fly CLI is required. Install from https://fly.io/docs/flyctl/install/"
  exit 1
}

function Get-FlyAppName {
  param([string]$ConfigPath)
  # Extract app name from fly.toml to keep scripts DRY.
  $content = Get-Content $ConfigPath -Raw
  if ($content -match '(?m)^\s*app\s*=\s*["'']([^"'' ]+)["'']') {
    return $Matches[1]
  }
  throw "Unable to find app name in $ConfigPath"
}

function Ensure-FlyApp {
  param([string]$ConfigPath)
  # Create app if missing; no-op when it already exists.
  $appName = Get-FlyAppName -ConfigPath $ConfigPath
  $output = & fly apps create $appName 2>&1
  if ($LASTEXITCODE -ne 0) {
    if ($output -match 'already exists|already taken|Name has already been taken') {
      Write-Host "Fly app already exists: $appName"
      return
    }
    Write-Host $output
    throw "Failed to create Fly app: $appName"
  }
  Write-Host "Created Fly app: $appName"
}

function Get-FlySecretNames {
  param([string]$AppName)
  # Read existing secrets so we only prompt for missing values.
  $output = & fly secrets list -a $AppName 2>$null
  if ($LASTEXITCODE -ne 0) {
    return @()
  }
  $lines = $output -split "`r?`n" | Where-Object { $_ -and $_ -notmatch '^\s*NAME' }
  return $lines | ForEach-Object { ($_ -split '\s+')[0] }
}

function Invoke-EnvValidation {
  param(
    [ValidateSet('fly-server')]
    [string]$Target,
    [string]$AppName
  )

  $assumedPresent = (Get-FlySecretNames -AppName $AppName) -join ','
  Write-Host "Validating env for $Target..."
  if ($assumedPresent -and $assumedPresent.Trim().Length -gt 0) {
    pnpm validate-env --target $Target --assume-present $assumedPresent
    if ($LASTEXITCODE -ne 0) {
      throw "env validation failed with exit code $LASTEXITCODE"
    }
  } else {
    pnpm validate-env --target $Target
    if ($LASTEXITCODE -ne 0) {
      throw "env validation failed with exit code $LASTEXITCODE"
    }
  }
}

function Get-EnvValueFromFile {
  param(
    [string]$EnvPath,
    [string]$Key
  )
  # Load a specific key from .env, if present.
  if (-not (Test-Path $EnvPath)) {
    return $null
  }
  $lines = Get-Content $EnvPath
  foreach ($line in $lines) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) {
      continue
    }
    $parts = $trimmed -split '=', 2
    if ($parts.Count -lt 2) {
      continue
    }
    if ($parts[0].Trim() -eq $Key) {
      return $parts[1].Trim()
    }
  }
  return $null
}

function Get-OrCreate-TraceToken {
  param([string]$EnvPath)
  $existing = Get-EnvValueFromFile -EnvPath $EnvPath -Key 'TRACE_API_TOKEN'
  if ($existing -and $existing.Trim().Length -gt 0) {
    return $existing.Trim()
  }

  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $rng.Dispose()
  $token = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''

  Write-Host "Generated TRACE_API_TOKEN for deployment."
  if (Test-Path $EnvPath) {
    $content = Get-Content $EnvPath
    if ($content -match '^(TRACE_API_TOKEN=)') {
      $content = $content -replace '^(TRACE_API_TOKEN=).*', "`$1$token"
      Set-Content -Path $EnvPath -Value $content -Encoding UTF8
    } else {
      Add-Content -Path $EnvPath -Value "TRACE_API_TOKEN=$token"
    }
  } else {
    Set-Content -Path $EnvPath -Value "TRACE_API_TOKEN=$token" -Encoding UTF8
  }

  return $token
}

function Ensure-FlySecrets {
  param(
    [string]$AppName,
    [string[]]$RequiredSecrets,
    [string[]]$OptionalSecrets,
    [string]$EnvPath
  )
  # Prompt only for missing secrets; prefer .env values when available.
  Write-Host "Checking secrets for $AppName..."
  $existing = Get-FlySecretNames -AppName $AppName
  foreach ($secret in $RequiredSecrets) {
    if ($existing -notcontains $secret) {
      Write-Host "Setting required secret $secret for $AppName..."
      $value = Get-EnvValueFromFile -EnvPath $EnvPath -Key $secret
      if ($value) {
        Write-Host "Using $secret from $EnvPath."
      } elseif ($secret -eq 'TRACE_API_TOKEN') {
        $value = Get-OrCreate-TraceToken -EnvPath $EnvPath
      } else {
        $value = Read-Host "Enter value for $secret (required for $AppName)"
      }
      if ($value -and $value.Trim().Length -gt 0) {
        & fly secrets set "$secret=$value" -a $AppName | Out-Null
        Write-Host "Set $secret for $AppName."
      } else {
        throw "Missing required secret $secret for $AppName"
      }
    }
  }

  foreach ($secret in $OptionalSecrets) {
    if ($existing -notcontains $secret) {
      Write-Host "Setting optional secret $secret for $AppName..."
      $value = Get-EnvValueFromFile -EnvPath $EnvPath -Key $secret
      if ($value) {
        Write-Host "Using $secret from $EnvPath."
      } else {
        $value = Read-Host "Enter value for $secret (optional for $AppName, leave blank to skip)"
      }
      if ($value -and $value.Trim().Length -gt 0) {
        & fly secrets set "$secret=$value" -a $AppName | Out-Null
        Write-Host "Set $secret for $AppName."
      } else {
        Write-Host "Skipped $secret for $AppName."
      }
    }
  }
}

function Upload-FootnoteSettings {
  param(
    [string]$AppName,
    [string]$RepoRootPath
  )

  $settingsPath = Join-Path $RepoRootPath 'footnote.yaml'
  if (-not (Test-Path $settingsPath)) {
    Write-Host "No footnote.yaml found at $settingsPath; skipping remote settings upload."
    return
  }

  Write-Host "Uploading canonical footnote.yaml to /data/config/footnote.yaml..."
  try {
    Get-Content -Path $settingsPath -Raw | fly ssh console -a $AppName -C "mkdir -p /data/config && cat > /data/config/footnote.yaml" | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "Unable to upload footnote.yaml to $AppName. Continuing deploy."
      return
    }
    Write-Host "Uploaded footnote.yaml to $AppName."
  } catch {
    Write-Warning "Unable to upload footnote.yaml to $AppName. Continuing deploy."
  }
}

$configRoot = $PSScriptRoot
$repoRoot = Resolve-Path (Join-Path $configRoot '..\..')
$envPath = Join-Path $configRoot '..\..\.env'

Push-Location $repoRoot
try {
$serverConfigPath = Join-Path $configRoot 'server.toml'
$serverAppName = Get-FlyAppName -ConfigPath $serverConfigPath

Write-Host "Ensuring Fly app exists ($serverAppName)..."
Ensure-FlyApp -ConfigPath $serverConfigPath

Write-Host "Configuring server secrets..."
Ensure-FlySecrets -AppName $serverAppName `
  -RequiredSecrets @('INCIDENT_PSEUDONYMIZATION_SECRET') `
  -OptionalSecrets @('OPENAI_API_KEY', 'OLLAMA_API_KEY', 'TRACE_API_TOKEN', 'REFLECT_SERVICE_TOKEN', 'TURNSTILE_SECRET_KEY', 'DISCORD_TOKEN', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'GITHUB_WEBHOOK_SECRET') `
  -EnvPath $envPath
Invoke-EnvValidation -Target 'fly-server' -AppName $serverAppName
Upload-FootnoteSettings -AppName $serverAppName -RepoRootPath $repoRoot

Write-Host "Deploying server..."
fly deploy -c $serverConfigPath
Write-Host "Scaling server to one instance..."
fly scale count 1 -a $serverAppName -y

$startScript = Join-Path $configRoot 'start.ps1'
if (Test-Path $startScript) {
  Write-Host "Starting server app..."
  & $startScript
}
} finally {
  Pop-Location
}

