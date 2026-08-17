# diag-net.ps1 - DSH Desktop network diagnostics (keep ASCII only!)
# Run on the problematic machine:
#   powershell -ExecutionPolicy Bypass -File diag-net.ps1
$ErrorActionPreference = 'Continue'
Write-Output '=== DSH Desktop network diagnostics ==='
Write-Output ('Time: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))

Write-Output ''
Write-Output '--- 1. Proxy status ---'
$is = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
Write-Output ('System proxy enabled: ' + $is.ProxyEnable)
Write-Output ('System proxy server : ' + $is.ProxyServer)
Get-ChildItem env: | Where-Object { $_.Name -match '^(HTTP|HTTPS|ALL|NO)_PROXY$' } | ForEach-Object { Write-Output ('Env ' + $_.Name + ' = ' + $_.Value) }

Write-Output ''
Write-Output '--- 2. Connectivity probes (curl, 10s timeout each) ---'
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
  Write-Output 'curl.exe not found (need Windows 10 1803+) - cannot probe network.'
} else {
  $probes = @(
    @{ N = 'npm mirror (npmmirror)    '; U = 'https://registry.npmmirror.com/@deepseek-ai/dsh/latest'; A = @() },
    @{ N = 'npm official (npmjs)      '; U = 'https://registry.npmjs.org/@deepseek-ai/dsh/latest'; A = @() },
    @{ N = 'node official (nodejs.org) '; U = 'https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip'; A = @('-I') },
    @{ N = 'node mirror (npmmirror)   '; U = 'https://npmmirror.com/mirrors/node/v24.19.0/node-v24.19.0-win-x64.zip'; A = @('-I') }
  )
  foreach ($p in $probes) {
    $out = & curl.exe -sS --max-time 10 -o NUL -w 'HTTP %{http_code} %{time_total}s' @($p.A) $p.U 2>&1
    Write-Output ($p.N + '  ' + ($out -join ' '))
  }
}

Write-Output ''
Write-Output '--- 3. DSH desktop logs (tail) ---'
$dataDir = Join-Path $env:APPDATA 'dsh-desktop'
foreach ($f in @('crash.log', 'server.log')) {
  $p = Join-Path $dataDir $f
  if (Test-Path $p) {
    Write-Output ('--- ' + $f + ' (last 20 lines) ---')
    Get-Content $p -Tail 20 -Encoding UTF8 -ErrorAction SilentlyContinue | ForEach-Object { Write-Output $_ }
  } else {
    Write-Output ('--- ' + $f + ' : not found (' + $p + ') ---')
  }
}

Write-Output ''
Write-Output 'Done. Send this output to the developer.'
