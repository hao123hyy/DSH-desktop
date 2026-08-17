# 生成应用图标 build\icon.png（512x512）
# 用法： powershell -NoProfile -ExecutionPolicy Bypass -File scripts/icon.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root "build"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$out = Join-Path $outDir "icon.png"

Add-Type -AssemblyName System.Drawing

$size = 512
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

# 深色圆角方块（四角圆角路径）
$rect = New-Object System.Drawing.Rectangle(24, 24, ($size - 48), ($size - 48))
$radius = 110
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$d = $radius * 2
$path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
$path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
$path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
$path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
$path.CloseFigure()

# 蓝色渐变填充
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 45, 111, 255),
    [System.Drawing.Color]::FromArgb(255, 61, 200, 255),
    45.0)
$g.FillPath($brush, $path)

# 白色 "D" 字母
$font = New-Object System.Drawing.Font("Segoe UI", 250, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$textRect = New-Object System.Drawing.RectangleF(0, -14, $size, $size)
$white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
$g.DrawString("D", $font, $white, $textRect, $sf)

$g.Dispose()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "Icon generated: $out"
