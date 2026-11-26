# Shrinks generated stickers in public/characters/<key>/stickers/ to 256 px (originals kept in data/art/stickers/<key>/).
param([int]$Size = 256)
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
Get-ChildItem (Join-Path $root 'public\characters') -Recurse -Filter *.png | Where-Object { $_.Directory.Name -eq 'stickers' } | ForEach-Object {
  $img = [System.Drawing.Image]::FromFile($_.FullName)
  try {
    if ($img.Width -le $Size) { return }
    $backup = Join-Path $root ("data\art\stickers\" + $_.Directory.Parent.Name)
    New-Item -ItemType Directory -Force $backup | Out-Null
    $bmp = New-Object System.Drawing.Bitmap $Size, $Size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($img, 0, 0, $Size, $Size)
    $g.Dispose()
  } finally { $img.Dispose() }
  if ($bmp) {
    Copy-Item $_.FullName (Join-Path $backup $_.Name) -Force
    $bmp.Save($_.FullName, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $bmp = $null
    "shrunk $($_.Directory.Name)/$($_.Name)"
  }
}
