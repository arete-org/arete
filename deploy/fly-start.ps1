$ErrorActionPreference = 'Stop'

# Starts machines for backend/web/bot apps without recreating them.

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
$backendApp = Get-FlyAppName -ConfigPath (Join-Path $configRoot 'fly.backend.toml')
$webApp = Get-FlyAppName -ConfigPath (Join-Path $configRoot 'fly.web.toml')
$botApp = Get-FlyAppName -ConfigPath (Join-Path $configRoot 'fly.bot.toml')

Write-Host "Starting backend ($backendApp)..."
foreach ($id in Get-MachineIds -AppName $backendApp) {
  Write-Host "Starting machine $id..."
  fly machine start $id -a $backendApp | Out-Null
}
Write-Host "Starting web ($webApp)..."
foreach ($id in Get-MachineIds -AppName $webApp) {
  Write-Host "Starting machine $id..."
  fly machine start $id -a $webApp | Out-Null
}
Write-Host "Starting bot ($botApp)..."
foreach ($id in Get-MachineIds -AppName $botApp) {
  Write-Host "Starting machine $id..."
  fly machine start $id -a $botApp | Out-Null
}
