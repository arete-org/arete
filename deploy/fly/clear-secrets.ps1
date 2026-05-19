$ErrorActionPreference = 'Stop'

# Removes all Fly secrets from the canonical server app.

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

$confirm = Read-Host "This will remove ALL Fly secrets for the server app. Type YES to continue"
if ($confirm -ne 'YES') {
  Write-Host "Aborted."
  exit 1
}

$configRoot = $PSScriptRoot
$appName = Get-FlyAppName -ConfigPath (Join-Path $configRoot 'server.toml')

Write-Host "Clearing secrets for $appName..."
$secrets = Get-FlySecrets -AppName $appName
foreach ($secret in $secrets) {
  Write-Host "Removing $secret from $appName..."
  fly secrets unset $secret -a $appName | Out-Null
}

