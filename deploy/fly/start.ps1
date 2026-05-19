$ErrorActionPreference = 'Stop'

# Starts machines for the canonical server app without recreating them.

function Get-FlyAppName {
  param([string]$ConfigPath)
  # Extract app name from fly.toml to keep scripts DRY.
  $content = Get-Content $ConfigPath -Raw
  if ($content -match '(?m)^\s*app\s*=\s*["'']([^"'' ]+)["'']') {
    return $Matches[1]
  }
  throw "Unable to find app name in $ConfigPath"
}

function Get-MachineIds {
  param([string]$AppName)
  $json = & fly machines list -a $AppName --json 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $json) {
    return @()
  }
  try {
    return ($json | ConvertFrom-Json | Where-Object { $_.id } | ForEach-Object { $_.id })
  } catch {
    return @()
  }
}

$configRoot = $PSScriptRoot
$serverApp = Get-FlyAppName -ConfigPath (Join-Path $configRoot 'server.toml')

Write-Host "Starting server ($serverApp)..."
foreach ($id in Get-MachineIds -AppName $serverApp) {
  Write-Host "Starting machine $id..."
  fly machine start $id -a $serverApp | Out-Null
}

