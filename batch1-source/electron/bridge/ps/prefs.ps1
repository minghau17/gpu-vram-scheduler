# GPU Scheduler bridge - HKCU\Software\Microsoft\DirectX\UserGpuPreferences read/write helper.
# This file is materialised to <dataDir>\ps\ with a UTF-8 BOM at runtime.
# Output: exactly one single-line JSON document on stdout.
#   read                         -> {"values":{"<exe path>":"<raw value>", ...}}
#   readone -Path <exe>          -> {"path":"<exe>","exists":true|false,"raw":"..."}
#   set     -Path <exe> -Value <raw>   -> {"ok":true,"path":"...","raw":"...","existed":true|false}
#   remove  -Path <exe>          -> {"ok":true,"path":"...","removed":true|false}
# Anything else: {"error":"..."} and exit code 2.  Never touches other values in the key.
param(
  [ValidateSet('read', 'readone', 'set', 'remove')]
  [string]$Action = 'read',
  [string]$Path = '',
  [string]$Value = ''
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

$sub = 'Software\Microsoft\DirectX\UserGpuPreferences'

function Emit($obj) {
  Write-Output ($obj | ConvertTo-Json -Compress -Depth 5)
}

try {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($sub, $false)
  if ($Action -eq 'read') {
    $values = [ordered]@{}
    if ($null -ne $key) {
      foreach ($name in $key.GetValueNames()) {
        $kind = $key.GetValueKind($name)
        $raw = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($null -eq $raw) { continue }
        $values[$name] = [string]$raw
      }
      $key.Close()
    }
    Emit ([ordered]@{ values = $values })
    exit 0
  }

  if ([string]::IsNullOrWhiteSpace($Path)) {
    Emit ([ordered]@{ error = 'Path is required' }); exit 2
  }

  if ($Action -eq 'readone') {
    $exists = $false
    $raw = ''
    if ($null -ne $key) {
      $names = @($key.GetValueNames())
      if ($names -contains $Path) {
        $raw = [string]$key.GetValue($Path, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $exists = $true
      }
      $key.Close()
    }
    Emit ([ordered]@{ path = $Path; exists = $exists; raw = $raw })
    exit 0
  }

  if ($Action -eq 'set') {
    $existed = $false
    if ($null -eq $key) {
      $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($sub)
    } else {
      $key.Close()
      $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($sub, $true)
    }
    $existed = (@($key.GetValueNames()) -contains $Path)
    $key.SetValue($Path, $Value, [Microsoft.Win32.RegistryValueKind]::String)
    $readBack = [string]$key.GetValue($Path, '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $key.Close()
    Emit ([ordered]@{ ok = $true; path = $Path; raw = $readBack; existed = $existed })
    exit 0
  }

  if ($Action -eq 'remove') {
    $removed = $false
    if ($null -ne $key) {
      $names = @($key.GetValueNames())
      if ($names -contains $Path) {
        $key.Close()
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($sub, $true)
        $key.DeleteValue($Path, $false)
        $removed = $true
        $key.Close()
      } else {
        $key.Close()
      }
    }
    Emit ([ordered]@{ ok = $true; path = $Path; removed = $removed })
    exit 0
  }
} catch {
  Emit ([ordered]@{ error = $_.Exception.Message })
  exit 2
}