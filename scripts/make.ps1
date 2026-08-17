# DSH Desktop - build script
# Outputs:
#   - dist\DSHDesktop\             folder build (recommended, no NSIS stub)
#   - dist\DSHDesktop-<ver>-portable.exe   portable single file (not recommended)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make.ps1
# NOTE: keep this file pure ASCII (see DEV-NOTES.md).

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Keep caches inside the project (sandbox/CI friendly)
$env:ELECTRON_BUILDER_CACHE = Join-Path $root ".builder-cache"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"

Write-Host "==> electron-builder (dir + portable)..."
# --publish never: 在带 git tag 的 CI 环境下，electron-builder 会自动触发隐式发布，
# 显式关闭（发布由 GitHub Actions workflow / 用户手动完成）
npx electron-builder --win dir portable --publish never
if ($LASTEXITCODE -ne 0) { throw "Build failed" }

# Copy win-unpacked into a clean delivery folder
$folder = Join-Path $root "dist\DSHDesktop"
if (Test-Path $folder) { Remove-Item $folder -Recurse -Force }
Copy-Item "dist\win-unpacked" $folder -Recurse -Force

$exe = Get-ChildItem $folder -Filter *.exe | Where-Object { $_.Name -like "DSH*" } | Select-Object -First 1
if (-not $exe) { throw "Folder build not generated" }
Write-Host ""
Write-Host ("Folder build: {0}  (double-click {1})" -f $folder, $exe.Name)
Get-ChildItem (Join-Path $root "dist\*-portable.exe") | ForEach-Object {
    Write-Host ("Portable:    {0} ({1:N1} MB)" -f $_.FullName, ($_.Length / 1MB))
}
