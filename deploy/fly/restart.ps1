$ErrorActionPreference = 'Stop'

# Starts machines for the canonical server app (safe restart after stop).

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

Write-Host "Restarting server ($serverApp)..."
$machineIds = Get-MachineIds -AppName $serverApp
if ($machineIds.Count -eq 0) {
  Write-Host "No machines found for $serverApp; scaling to one machine..."
  fly scale count 1 -a $serverApp -y | Out-Null
  return
}

foreach ($id in $machineIds) {
  Write-Host "Starting machine $id..."
  fly machine start $id -a $serverApp | Out-Null
}

