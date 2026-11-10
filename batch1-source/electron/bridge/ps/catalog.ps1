# GPU Scheduler bridge - installed app catalog (for the "添加应用" picker).
# Materialised to <dataDir>\ps\ with a UTF-8 BOM at runtime.
# Sources:  HKCU/HKLM Uninstall entries (DisplayIcon)  +  Start Menu .lnk shortcuts (resolved targets).
# Output:   one single-line JSON document {"apps":[{"exePath":..,"name":..,"source":"uninstall"|"startmenu"}],"ms":..,"counts":{..}}
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
$sw = [Diagnostics.Stopwatch]::StartNew()

function Clean-ExePath([string]$raw) {
  if ([string]::IsNullOrWhiteSpace($raw)) { return '' }
  $s = $raw.Trim()
  if ($s.StartsWith('"')) {
    $end = $s.IndexOf('"', 1)
    if ($end -gt 1) { $s = $s.Substring(1, $end - 1) }
  } else {
    # "C:\path\app.exe,0" / "C:\path\app.exe -something"
    $m = [regex]::Match($s, '^(.*?\.exe)', 'IgnoreCase')
    if ($m.Success) { $s = $m.Groups[1].Value.Trim() }
  }
  return $s
}

$skipName = [regex]'(?i)(uninstall|unins\d*|setup|installer|update|updater|crash|report|vc_?redist|dotnet|directx|runtime|helper|repair|readme|license|webview|language|卸载|修复|补丁)'
$skipExe = [regex]'(?i)(\\windows\\(system32|syswow64|winsxs|servicing)\\|\\unins\d*\.exe$|\\setup\.exe$|\\update\.exe$|\\uninstall\.exe$|\\vc_redist|\\dotnet|\\directx)'

$found = [ordered]@{}   # lower path -> @{exePath; name; source}
function Add-App([string]$exe, [string]$name, [string]$source) {
  if ([string]::IsNullOrWhiteSpace($exe)) { return }
  $e = $exe.Trim()
  if (-not $e.ToLowerInvariant().EndsWith('.exe')) { return }
  if ($e.Contains('%%')) { return }
  if ($skipExe.IsMatch($e)) { return }
  if (-not (Test-Path -LiteralPath $e -PathType Leaf)) { return }
  $lower = $e.ToLowerInvariant()
  if ($found.Contains($lower)) { return }
  $n = $name
  if ([string]::IsNullOrWhiteSpace($n)) { $n = [IO.Path]::GetFileNameWithoutExtension($e) }
  $n = $n.Trim()
  if ($skipName.IsMatch($n) -and $source -eq 'startmenu') { return }
  $entry = [ordered]@{ exePath = $e; name = $n; source = $source }
  $found[$lower] = $entry
}

$regCount = 0
$regPaths = @(
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
foreach ($rp in $regPaths) {
  $items = Get-ItemProperty -Path $rp -ErrorAction SilentlyContinue
  foreach ($it in $items) {
    if ($null -eq $it) { continue }
    $display = [string]$it.DisplayName
    if ([string]::IsNullOrWhiteSpace($display)) { continue }
    if ($it.SystemComponent -eq 1) { continue }
    if ($display -match '^(Update|KB\d|Security Update|Hotfix)') { continue }
    $regCount++
    $icon = Clean-ExePath ([string]$it.DisplayIcon)
    if ($icon -and $icon.ToLowerInvariant().EndsWith('.exe')) {
      Add-App $icon $display 'uninstall'
    } elseif ($it.InstallLocation) {
      # DisplayIcon was an .ico / empty: look for a single obvious exe in InstallLocation
      $loc = ([string]$it.InstallLocation).Trim()
      if ($loc -and $loc.Length -lt 260 -and (Test-Path -LiteralPath $loc -PathType Container)) {
        $cand = Get-ChildItem -LiteralPath $loc -Filter *.exe -File -ErrorAction SilentlyContinue |
          Where-Object { $skipExe.IsMatch($_.FullName) -eq $false -and $skipName.IsMatch($_.BaseName) -eq $false } |
          Sort-Object Length -Descending | Select-Object -First 1
        if ($cand) { Add-App $cand.FullName $display 'uninstall' }
      }
    }
  }
}

$lnkCount = 0
$menuRoots = @(
  (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
)
$shell = $null
try { $shell = New-Object -ComObject WScript.Shell } catch { }
if ($null -ne $shell) {
  foreach ($root in $menuRoots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $lnks = Get-ChildItem -LiteralPath $root -Recurse -Filter *.lnk -File -ErrorAction SilentlyContinue
    foreach ($lnk in $lnks) {
      $lnkCount++
      try {
        $sc = $shell.CreateShortcut($lnk.FullName)
        $target = [string]$sc.TargetPath
        if ([string]::IsNullOrWhiteSpace($target)) { continue }
        if ($target.ToLowerInvariant().EndsWith('.exe')) {
          Add-App $target ([IO.Path]::GetFileNameWithoutExtension($lnk.Name)) 'startmenu'
        }
      } catch { }
    }
  }
}

$apps = @()
foreach ($k in $found.Keys) { $apps += $found[$k] }
$apps = @($apps | Sort-Object { $_.name })

$sw.Stop()
$result = [ordered]@{
  apps = $apps
  ms = $sw.ElapsedMilliseconds
  counts = [ordered]@{ registry = $regCount; lnk = $lnkCount; apps = $apps.Count }
  error = ''
}
Write-Output ($result | ConvertTo-Json -Compress -Depth 5)
exit 0