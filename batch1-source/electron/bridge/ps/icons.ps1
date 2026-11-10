# GPU Scheduler bridge - batch exe icon extractor.
# Materialised to <dataDir>\ps\ with a UTF-8 BOM at runtime.
# Usage: powershell -File icons.ps1 -JobFile <job.json> -OutDir <icons dir>
# Job file (UTF-8, no BOM needed): [{"path":"C:\\...\\app.exe","out":"C:\\...\\icons\\<sha1>.png"}, ...]
# Output: one single-line JSON document: {"results":[{"path":..,"ok":true|false,"out":..,"error":..}, ...]}
# Icons are saved as 96x96 PNG with alpha (jumbo 256px shell image list -> downscale; 32px fallback).
param(
  [Parameter(Mandatory = $true)][string]$JobFile,
  [Parameter(Mandatory = $true)][string]$OutDir
)
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

$cs = @'
using System;
using System.Runtime.InteropServices;

public static class IconNative
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct SHFILEINFO
    {
        public IntPtr hIcon;
        public int iIcon;
        public uint dwAttributes;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szDisplayName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string szTypeName;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SHGetFileInfoW(string pszPath, uint dwFileAttributes, ref SHFILEINFO psfi, uint cbFileInfo, uint uFlags);

    [DllImport("shell32.dll")]
    public static extern int SHGetImageList(int iImageList, ref Guid riid, out IntPtr ppv);

    [DllImport("comctl32.dll")]
    public static extern IntPtr ImageList_GetIcon(IntPtr himl, int i, uint flags);

    [DllImport("user32.dll")]
    public static extern bool DestroyIcon(IntPtr hIcon);

    // Returns a 256px HICON (SHIL_JUMBO) . Fallback: 32px icon from SHGetFileInfo.
    public static IntPtr GetIcon(string path, out int idx, out bool jumbo)
    {
        jumbo = false;
        idx = -1;
        try
        {
            var shfi = new SHFILEINFO();
            IntPtr r = SHGetFileInfoW(path, 0, ref shfi, (uint)Marshal.SizeOf(typeof(SHFILEINFO)), 0x00004000 | 0x000000100 | 0x000000000);
            if (r == IntPtr.Zero) return IntPtr.Zero;
            idx = shfi.iIcon;
            Guid iid = new Guid("46eb5926-582e-4017-9fdf-e8998daa0950");
            IntPtr iml;
            int hr = SHGetImageList(4 /* SHIL_JUMBO */, ref iid, out iml);
            if (hr == 0 && iml != IntPtr.Zero)
            {
                IntPtr hicon = ImageList_GetIcon(iml, idx, 0x1 /* ILD_TRANSPARENT */);
                if (hicon != IntPtr.Zero) { jumbo = true; return hicon; }
            }
            return shfi.hIcon;
        }
        catch { return IntPtr.Zero; }
    }
}
'@
Add-Type -TypeDefinition $cs -Language CSharp | Out-Null
$wpfOk = $true
try { Add-Type -AssemblyName PresentationCore, WindowsBase | Out-Null } catch { $wpfOk = $false }
Add-Type -AssemblyName System.Drawing | Out-Null

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Save-HIconWpf([IntPtr]$hIcon, [string]$out, [int]$size) {
  if (-not $wpfOk) { return $false }
  try {
    $bs = [System.Windows.Interop.Imaging]::CreateBitmapSourceFromHIcon(
      $hIcon,
      [System.Windows.Int32Rect]::Empty,
      [System.Windows.Media.Imaging.BitmapSizeOptions]::FromWidthAndHeight($size, $size))
    $enc = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
    $enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bs))
    $fs = [IO.File]::Open($out, [IO.FileMode]::Create)
    try { $enc.Save($fs) } finally { $fs.Close() }
    return $true
  } catch { return $false }
}

function Save-HIconDrawing([IntPtr]$hIcon, [string]$out, [int]$size) {
  try {
    $ico = [System.Drawing.Icon]::FromHandle($hIcon)
    $bmp = $ico.ToBitmap()
    $scaled = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($scaled)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($bmp, 0, 0, $size, $size)
    $g.Dispose(); $bmp.Dispose(); $ico.Dispose()
    $scaled.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $scaled.Dispose()
    return $true
  } catch { return $false }
}

$results = @()
try {
  $raw = [IO.File]::ReadAllText($JobFile, [Text.Encoding]::UTF8)
  $job = $raw | ConvertFrom-Json
} catch {
  Write-Output ('{"results":[],"error":"bad job file: ' + ($_.Exception.Message -replace '"', '\"') + '"}')
  exit 2
}

foreach ($item in @($job)) {
  $exe = [string]$item.path
  $out = [string]$item.out
  $entry = [ordered]@{ path = $exe; out = $out; ok = $false; error = ''; size = 0 }
  try {
    if ([string]::IsNullOrWhiteSpace($exe) -or [string]::IsNullOrWhiteSpace($out)) {
      $entry.error = 'empty path'
    } elseif (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
      $entry.error = 'exe not found'
    } elseif ((Test-Path -LiteralPath $out -PathType Leaf) -and ((Get-Item -LiteralPath $out).Length -gt 64)) {
      $entry.ok = $true
      $entry.size = (Get-Item -LiteralPath $out).Length
    } else {
      $idx = -1
      $jumbo = $false
      $hIcon = [IconNative]::GetIcon($exe, [ref]$idx, [ref]$jumbo)
      if ($hIcon -eq [IntPtr]::Zero) {
        $entry.error = 'no icon handle'
      } else {
        $ok = Save-HIconWpf $hIcon $out 96
        if (-not $ok) { $ok = Save-HIconDrawing $hIcon $out 96 }
        [IconNative]::DestroyIcon($hIcon) | Out-Null
        if ($ok -and (Test-Path -LiteralPath $out)) {
          $entry.ok = $true
          $entry.size = (Get-Item -LiteralPath $out).Length
          $entry.jumbo = $jumbo
        } else {
          $entry.error = 'save failed'
        }
      }
    }
  } catch {
    $entry.error = $_.Exception.Message
  }
  $results += [pscustomobject]$entry
}

Write-Output (@{ results = $results } | ConvertTo-Json -Compress -Depth 5)
exit 0