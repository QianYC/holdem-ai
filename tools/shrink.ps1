# Shrinks generated stickers in public/characters/<key>/stickers/ so the longer side is $Size px, keeping the
# aspect ratio (originals kept in data/art/stickers/<key>/). Windows PowerShell / PowerShell 7 on Windows.
param([int]$Size = 256)
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
Get-ChildItem (Join-Path $root 'public\characters') -Recurse -Filter *.png | Where-Object { $_.Directory.Name -eq 'stickers' } | ForEach-Object {
  $bmp = $null
  $img = [System.Drawing.Image]::FromFile($_.FullName)
  try {
    $long = [Math]::Max($img.Width, $img.Height)
    if ($long -le $Size) { return }
    $w = [int][Math]::Round($img.Width * $Size / $long)
    $h = [int][Math]::Round($img.Height * $Size / $long)
    $backup = Join-Path $root ("data\art\stickers\" + $_.Directory.Parent.Name)
    New-Item -ItemType Directory -Force $backup | Out-Null
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($img, 0, 0, $w, $h)
    $g.Dispose()
  } finally { $img.Dispose() }
  if ($bmp) {
    Copy-Item $_.FullName (Join-Path $backup $_.Name) -Force
    $bmp.Save($_.FullName, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    "shrunk $($_.Directory.Parent.Name)/$($_.Name) to ${w}x${h}"
  }
}