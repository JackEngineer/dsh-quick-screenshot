# dsh-quick-screenshot - Windows capture worker.
#
# Captures one window (or the whole desktop) into a PNG and prints one line of
# JSON describing the result. It is pure ASCII on purpose: Windows PowerShell
# 5.1 reads a .ps1 file as ANSI unless it carries a UTF-8 BOM, so the file stays
# ASCII-only and the JSON it prints carries any non-ASCII window title escaped
# by ConvertTo-Json.
#
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
#     -File capture-windows.ps1 -Out <png> -Mode window -TitlePattern "DeepSeek Harness"
#
# Modes:
#   window  the largest visible window whose title matches -TitlePattern, or the
#           foreground window when nothing matches
#   active  the current foreground window
#   screen  the whole virtual desktop (every monitor)
#
# Exit codes: 0 success, 2 no target window, 3 unusable window geometry,
# 4 capture failed, 5 the PNG was not written.

param(
  [Parameter(Mandatory = $true)][string]$Out,
  [ValidateSet('window', 'active', 'screen')][string]$Mode = 'window',
  [string]$TitlePattern = '',
  [int]$MaxDimension = 0,
  [int]$DelayMs = 140
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

if (-not ('DshCapture' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class DshCapture {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT value, int size);

  /** Per-monitor-v2 DPI awareness when the OS supports it, system awareness otherwise. */
  public static void MakeDpiAware() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
    try { SetProcessDPIAware(); } catch { }
  }

  public static string Title(IntPtr hWnd) {
    int len = GetWindowTextLength(hWnd);
    if (len <= 0) return "";
    StringBuilder sb = new StringBuilder(len + 2);
    GetWindowText(hWnd, sb, sb.Capacity);
    return sb.ToString();
  }

  /** DWMWA_EXTENDED_FRAME_BOUNDS (9) excludes the invisible resize border. */
  public static bool FrameBounds(IntPtr hWnd, out RECT rect) {
    rect = new RECT();
    try {
      if (DwmGetWindowAttribute(hWnd, 9, out rect, Marshal.SizeOf(typeof(RECT))) == 0) return true;
    } catch { }
    return GetWindowRect(hWnd, out rect);
  }

  /** Largest visible, non-minimized top-level window whose title matches, or IntPtr.Zero. */
  public static IntPtr FindWindow(string pattern) {
    IntPtr best = IntPtr.Zero;
    long bestArea = 0;
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      if (bestArea < 0) return true;
      if (!IsWindowVisible(hWnd) || IsIconic(hWnd)) return true;
      string title = Title(hWnd);
      if (title.Length == 0) return true;
      if (pattern.Length > 0 && title.IndexOf(pattern, StringComparison.OrdinalIgnoreCase) < 0) return true;
      RECT rect;
      if (!GetWindowRect(hWnd, out rect)) return true;
      long w = rect.Right - rect.Left, h = rect.Bottom - rect.Top;
      if (w < 160 || h < 120) return true;
      long area = w * h;
      if (area > bestArea) { bestArea = area; best = hWnd; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
'@
}

[DshCapture]::MakeDpiAware() | Out-Null

function Write-Result($data) {
  $data | ConvertTo-Json -Compress -Depth 4
}

function Save-Shot([System.Drawing.Bitmap]$bitmap) {
  $directory = Split-Path -Parent $Out
  if ($directory -and -not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
  }
  $bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
}

# Fraction of sampled pixels equal to the first sample: near 1 means the capture
# came back as one flat colour (a blank PrintWindow result).
function Get-FlatRatio([System.Drawing.Bitmap]$bitmap) {
  $first = $null
  $same = 0
  $total = 0
  $stepX = [Math]::Max(1, [int]($bitmap.Width / 28))
  $stepY = [Math]::Max(1, [int]($bitmap.Height / 28))
  for ($y = 0; $y -lt $bitmap.Height; $y += $stepY) {
    for ($x = 0; $x -lt $bitmap.Width; $x += $stepX) {
      $pixel = $bitmap.GetPixel($x, $y).ToArgb()
      if ($null -eq $first) { $first = $pixel } elseif ($pixel -eq $first) { $same++ }
      $total++
    }
  }
  if ($total -le 1) { return 1.0 }
  return $same / ($total - 1)
}

$capture = [ordered]@{
  ok = $false
  mode = $Mode
  method = ''
  path = $Out
  width = 0
  height = 0
  window = ''
  windowHandle = 0
  flat = 0
  error = ''
}

try {
  if ($Mode -eq 'screen') {
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try { $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size) } finally { $graphics.Dispose() }
    $capture.method = 'screen'
    $capture.window = 'virtual-screen'
  } else {
    $handle = [IntPtr]::Zero
    if ($Mode -eq 'window' -and $TitlePattern.Length -gt 0) {
      $handle = [DshCapture]::FindWindow($TitlePattern)
    }
    if ($handle -eq [IntPtr]::Zero) { $handle = [DshCapture]::GetForegroundWindow() }
    elseif ($Mode -eq 'window') { $capture.window = [DshCapture]::Title($handle) }

    if ($handle -eq [IntPtr]::Zero) {
      $capture.error = 'no visible target window'
      Write-Result $capture
      exit 2
    }
    if ([DshCapture]::IsIconic($handle)) {
      [DshCapture]::ShowWindow($handle, 9) | Out-Null
      Start-Sleep -Milliseconds 240
    }
    if ($capture.window -eq '') { $capture.window = [DshCapture]::Title($handle) }
    $capture.windowHandle = [int64]$handle

    $rect = New-Object DshCapture+RECT
    [DshCapture]::FrameBounds($handle, [ref]$rect) | Out-Null
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -lt 160 -or $height -lt 120) {
      [DshCapture]::GetWindowRect($handle, [ref]$rect) | Out-Null
      $width = $rect.Right - $rect.Left
      $height = $rect.Bottom - $rect.Top
    }
    if ($width -lt 80 -or $height -lt 80) {
      $capture.error = "unusable window geometry ${width}x${height}"
      Write-Result $capture
      exit 3
    }

    $bitmap = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $hdc = $graphics.GetHdc()
    $printed = $false
    try { $printed = [DshCapture]::PrintWindow($handle, $hdc, 2) } finally { $graphics.ReleaseHdc($hdc) }
    $graphics.Dispose()
    $capture.method = 'printwindow'
    $flat = 1.0
    if ($printed) {
      $flat = Get-FlatRatio $bitmap
      $capture.flat = [Math]::Round($flat, 4)
    }
    # A window that never painted (or a compositor that refuses PrintWindow)
    # falls back to reading the same rectangle off the screen, which requires the
    # window to be on top - acceptable, because the request came from that window.
    if (-not $printed -or $flat -gt 0.985) {
      $bitmap.Dispose()
      [DshCapture]::SetForegroundWindow($handle) | Out-Null
      Start-Sleep -Milliseconds ([Math]::Max(60, $DelayMs))
      $bitmap = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try { $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size) } finally { $graphics.Dispose() }
      $capture.method = 'screen-rect'
    }
  }

  if ($MaxDimension -gt 0 -and ($bitmap.Width -gt $MaxDimension -or $bitmap.Height -gt $MaxDimension)) {
    $scale = [Math]::Min($MaxDimension / $bitmap.Width, $MaxDimension / $bitmap.Height)
    $targetWidth = [Math]::Max(1, [int][Math]::Round($bitmap.Width * $scale))
    $targetHeight = [Math]::Max(1, [int][Math]::Round($bitmap.Height * $scale))
    $scaled = New-Object System.Drawing.Bitmap($targetWidth, $targetHeight, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($scaled)
    try {
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.DrawImage($bitmap, 0, 0, $targetWidth, $targetHeight)
    } finally { $graphics.Dispose() }
    $bitmap.Dispose()
    $bitmap = $scaled
  }

  Save-Shot $bitmap
  $capture.ok = $true
  $capture.width = $bitmap.Width
  $capture.height = $bitmap.Height
  $bitmap.Dispose()

  if (-not (Test-Path -LiteralPath $Out)) {
    $capture.ok = $false
    $capture.error = 'capture produced no file'
    Write-Result $capture
    exit 5
  }
  Write-Result $capture
  exit 0
} catch {
  $capture.ok = $false
  $capture.error = $_.Exception.Message
  Write-Result $capture
  exit 4
}
