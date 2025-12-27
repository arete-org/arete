$ErrorActionPreference = 'Stop'

# Removes all Fly secrets from backend/web/bot apps.

function Get-FlyAppName {
  param([string]$ConfigPath)
  # Extract app name from fly.toml to keep scripts DRY.
  $content = Get-Content $ConfigPath -Raw
  if ($content -match '(?m)^\s*app\s*=\s*["'']([^"'' ]+)["'']') {
    return $Matches[1]
  }
  throw "Unable to find app name in $ConfigPath"
}

function Get-FlySecrets {
  param([string]$AppName)
  $output = & fly secrets list -a $AppName 2>$null
  if ($LASTEXITCODE -ne 0) {
    return @()
  }
  $lines = $output -split "`r?`n" | Where-Object { $_ -and $_ -notmatch '^\s*NAME' }
  return $lines | ForEach-Object { ($_ -split '\s+')[0] }
}

$confirm = Read-Host "This will remove ALL Fly secrets for backend/web/bot apps. Type YES to continue"
if ($confirm -ne 'YES') {
  Write-Host "Aborted."
  exit 1
}

$configRoot = $PSScriptRoot
$appNames = @(
  (Get-FlyAppName -ConfigPath (Join-Path $configRoot 'fly.backend.toml'))
  (Get-FlyAppName -ConfigPath (Join-Path $configRoot 'fly.web.toml'))
  (Get-FlyAppName -ConfigPath (Join-Path $configRoot 'fly.bot.toml'))
)

foreach ($app in $appNames) {
  Write-Host "Clearing secrets for $app..."
  $secrets = Get-FlySecrets -AppName $app
  foreach ($secret in $secrets) {
    Write-Host "Removing $secret from $app..."
    fly secrets unset $secret -a $app | Out-Null
  }
}
