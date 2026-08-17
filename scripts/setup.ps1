# DSH Desktop - setup script (one-time initialization)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup.ps1
# NOTE: keep this file pure ASCII (see DEV-NOTES.md).
#
# Note: `npm install` triggers postinstall -> scripts/prepare-payload.js, which
# downloads the @deepseek-ai/dsh closure into resources/dsh-server automatically.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "==> 1/3 Installing app dependencies (electron / electron-builder)..."
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

Write-Host "==> 2/3 Preparing local server payload (@deepseek-ai/dsh + deps)..."
node scripts/prepare-payload.js
if ($LASTEXITCODE -ne 0) { throw "Server payload preparation failed" }

Write-Host "==> 3/3 Generating app icon..."
if (-not (Test-Path "build\icon.png")) {
    & "$PSScriptRoot\icon.ps1"
} else {
    Write-Host "    already present, skipped."
}

Write-Host ""
Write-Host "Setup complete."
Write-Host "  - Dev mode:    npm start"
Write-Host "  - Build exe:   npm run make   (output to dist\)"
