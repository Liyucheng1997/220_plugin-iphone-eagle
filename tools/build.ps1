<#
  build.ps1 -- build PhoneBridge.exe and (optionally) the .eagleplugin package.

    powershell -NoProfile -ExecutionPolicy Bypass -File tools\build.ps1            # compile only
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\build.ps1 -Package   # compile + package

  Uses the C# compiler that ships with .NET Framework 4.x on every Windows 10/11
  machine, so no SDK is needed. The exe targets .NET Framework 4 (always present),
  AnyCPU, so it runs natively on x64, x86 and ARM64 Windows.
#>
param([switch]$Package)

$ErrorActionPreference = 'Stop'
$root   = Split-Path -Parent $PSScriptRoot
$plugin = Join-Path $root 'plugin'
$src    = Join-Path $plugin 'bridge\PhoneBridge.cs'
$exe    = Join-Path $plugin 'bridge\PhoneBridge.exe'

# The same source is compiled by PowerShell's Add-Type on machines where the exe
# is blocked, and PowerShell 5.1 reads it with the system ANSI codepage -- so any
# non-ASCII byte is a latent "works here, breaks on a Chinese Windows" bug.
$bytes = [IO.File]::ReadAllBytes($src)
for ($i = 0; $i -lt $bytes.Length; $i++) {
    if ($bytes[$i] -gt 127) {
        $line = ([Text.Encoding]::ASCII.GetString($bytes, 0, $i) -split "`n").Count
        throw "PhoneBridge.cs must be ASCII-only (non-ASCII byte at line $line)."
    }
}

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'csc.exe (.NET Framework 4.x) not found.' }

& $csc /nologo /target:exe /platform:anycpu /optimize+ /warn:4 `
    /r:System.Web.Extensions.dll /r:System.Drawing.dll /r:System.Management.dll `
    "/out:$exe" $src
if ($LASTEXITCODE -ne 0) { throw "csc failed ($LASTEXITCODE)" }
Write-Host "built $exe ($([math]::Round((Get-Item $exe).Length / 1KB)) KB)"

if (-not $Package) { return }

$manifest = Get-Content (Join-Path $plugin 'manifest.json') -Raw | ConvertFrom-Json
$out = Join-Path $root ("dist\phone-photo-sync-" + $manifest.version + ".eagleplugin")
New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
if (Test-Path $out) { Remove-Item $out -Force }

Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::Open($out, 'Create')
try {
    Get-ChildItem $plugin -Recurse -File | Where-Object {
        $rel = $_.FullName.Substring($plugin.Length + 1)
        -not ($rel -like '.cache\*' -or $rel -like '*.log')
    } | ForEach-Object {
        # Eagle needs forward-slash entry names (Compress-Archive writes
        # backslashes and the install silently breaks).
        $rel = $_.FullName.Substring($plugin.Length + 1).Replace('\', '/')
        [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel)
    }
} finally { $zip.Dispose() }
Write-Host "packaged $out"
