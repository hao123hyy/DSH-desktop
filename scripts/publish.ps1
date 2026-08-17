# DSH Desktop - publish script (run manually by the user)
#
# Publishes the dev build (dist\DSHDesktop) to the production folder
# (D:\DSHDesktop) atomically.
#
# IMPORTANT: keep this file pure ASCII. Windows PowerShell 5.1 parses .ps1
# files with the system ANSI codepage (GBK on Chinese systems), so any
# non-ASCII byte in a string literal can break parsing. All names that may
# contain non-ASCII characters (product name, process name, .txt file) are
# resolved dynamically below.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\publish.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\publish.ps1 -SkipVerify

param(
  [switch]$SkipVerify
)

$ErrorActionPreference = "Stop"
$root    = Split-Path -Parent $PSScriptRoot
$src     = Join-Path $root "dist\DSHDesktop"
$target  = "D:\DSHDesktop"
$staging = "D:\DSHDesktop.new"
$bak     = "D:\DSHDesktop.bak"

$product = (Get-Content (Join-Path $root "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json).productName
if (-not $product) { throw "Cannot read productName from package.json" }
$exe = Join-Path $target "$product.exe"

$markers = @(
  "resources\app.asar"
)

Write-Host "==> 1/6 Checking running instances..."
$running = @(Get-Process | Where-Object { $_.ProcessName -like "DSH*" })
if ($running.Count -gt 0) {
  $ids = ($running | ForEach-Object { $_.Id }) -join ", "
  Write-Host "DSH Desktop app is running (PID: $ids)."
  Write-Host "Please close it first (File -> Exit), then run the publish script again."
  exit 1
}

Write-Host "==> 2/6 Validating build artifacts..."
foreach ($m in $markers) {
  if (-not (Test-Path (Join-Path $src $m))) {
    throw "Build incomplete: missing $src\$m . Run 'npm run make' first."
  }
}
if (@(Get-ChildItem $src -Filter *.txt | Measure-Object).Count -lt 1) {
  throw "Build incomplete: no .txt instruction file in $src . Run 'npm run make' first."
}
$asar  = Get-Item (Join-Path $src "resources\app.asar")
if ($asar.Length -lt 1MB) { throw "app.asar looks abnormal ($($asar.Length) bytes). Run 'npm run make' first." }
$appVer = (Get-Content (Join-Path $root "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
$count = (Get-ChildItem $src -Recurse -File | Measure-Object).Count
Write-Host ("Validated: app v{0}, {1} files (dsh payload closure is NOT bundled; it is downloaded on first run)" -f $appVer, $count)

$sizeMB = [math]::Round((Get-ChildItem $src -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 0)
Write-Host "==> 3/6 Staging new version (copying about $sizeMB MB)..."
Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item $src $staging -Recurse -Force
foreach ($m in $markers) {
  if (-not (Test-Path (Join-Path $staging $m))) { throw "Staging copy incomplete: $m" }
}

Write-Host "==> 4/6 Swapping production folder atomically..."
if (Test-Path $target) {
  Remove-Item $bak -Recurse -Force -ErrorAction SilentlyContinue
  Rename-Item $target $bak
}
Rename-Item $staging $target

if (-not $SkipVerify) {
  Write-Host "==> 5/6 Smoke verification (a test window will pop up briefly)..."
  Write-Host "    Note: first run downloads the dsh payload closure (~200MB, needs network);"
  Write-Host "    it is cached in .smoke-data so later publishes skip the download."
  try {
    $smokeData = Join-Path $root ".smoke-data"
    $smokeHome = Join-Path $root ".smoke-home"
    $smokeFile = Join-Path $root ".smoke.json"
    Remove-Item $smokeFile -Force -ErrorAction SilentlyContinue
    $env:DSH_DESKTOP_DATA_DIR = $smokeData
    $env:DSH_HOME = $smokeHome
    $env:DSH_TELEMETRY_DISABLED = "1"
    $env:DSH_DESKTOP_DISABLE_UPDATE_CHECK = "1"
    $env:DSH_DESKTOP_SMOKE_FILE = $smokeFile
    $proc = Start-Process -FilePath $exe -PassThru
    $deadline = (Get-Date).AddMinutes(15)
    while ((Get-Date) -lt $deadline) {
      if (Test-Path $smokeFile) { break }
      Start-Sleep -Seconds 5
    }
    if (-not (Test-Path $smokeFile)) {
      throw "Smoke timeout: no result within 15 minutes (first run downloads ~200MB). Check $smokeData\crash.log"
    }
    $smoke = Get-Content $smokeFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($smoke.hasBoot -ne $true) {
      throw "UI did not render: $($smoke | ConvertTo-Json -Compress)"
    }
    Write-Host ("Smoke passed: title '{0}', {1} elements, hasBoot=true" -f $smoke.title, $smoke.allElements)
  } catch {
    Write-Host "Smoke failed, rolling back..."
    if (Test-Path $target) { Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path $bak) { Rename-Item $bak $target }
    throw "Publish rolled back; production kept the old version. Reason: $_"
  } finally {
    if ($proc -and -not $proc.HasExited) {
      & taskkill.exe /pid $proc.Id /T /F 2>$null | Out-Null
    }
    Remove-Item $smokeFile -Force -ErrorAction SilentlyContinue
  }
} else {
  Write-Host "==> 5/6 Smoke skipped (-SkipVerify)"
}

Remove-Item $bak -Recurse -Force -ErrorAction SilentlyContinue

# ---------------------------------------------------------------------------
# 6/6 Share zip: package the published production folder (D:\DSHDesktop) into a
# clean zip next to it on the D: drive root (D:\DSH桌面版-<ver>-win-x64.zip)
# for easy distribution. The zip must NOT contain the payload closure
# (dsh-server) or a bundled node runtime (resources\node) - both are downloaded
# by the app on first run. The clean check below enforces that.
# ---------------------------------------------------------------------------
Write-Host "==> 6/6 Generating share zip..."
$ver = (Get-Content (Join-Path $root "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
$zipDir = "D:\"
$zip = Join-Path $zipDir "$product-$ver-win-x64.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
& tar.exe -a -c -f $zip -C "D:\" "DSHDesktop"
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "WARNING: zip generation failed. Publish itself succeeded; create the zip manually:"
  Write-Host "  tar -a -c -f `"$zip`" -C D:\ DSHDesktop"
} else {
  $zipSize = [math]::Round((Get-Item $zip).Length / 1MB, 1)
  $listing = & tar.exe -tf $zip
  $unclean = @($listing | Where-Object { $_ -match "dsh-server" -or $_ -match "resources/node" })
  if ($unclean.Count -gt 0) {
    Write-Host ""
    Write-Host "WARNING: zip contains unexpected bundled payload entries - NOT clean:"
    $unclean | Select-Object -First 10 | ForEach-Object { Write-Host "  $_" }
  } else {
    Write-Host "Share zip ready (clean: no bundled payload or node runtime): $zip ($zipSize MB)"
  }
}

Write-Host ""
Write-Host "Publish complete! Production: $target"
Write-Host "You can now double-click $exe to use it."
Write-Host "Share zip: $zip"
