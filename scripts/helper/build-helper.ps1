<#
.SYNOPSIS
  Builds AgentShieldHelper.exe (the AgentShield Windows app) with the C# compiler that ships with
  Windows (.NET Framework 4.x), so no SDK is needed. Output: dist-installer\helper\AgentShieldHelper.exe,
  which AgentShield-System-Setup.iss packages.
#>
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'The .NET Framework 4 C# compiler (csc.exe) was not found.' }

$outDir = Join-Path $root 'dist-installer\helper'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$out = Join-Path $outDir 'AgentShieldHelper.exe'
$icon = Join-Path $root 'extension\icons\icon.ico'
$source = Join-Path $PSScriptRoot 'AgentShieldHelper.cs'

& $csc /nologo /target:winexe /optimize+ /platform:anycpu "/out:$out" "/win32icon:$icon" `
  /reference:System.Web.Extensions.dll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll `
  /reference:System.Core.dll /reference:System.Security.dll $source
if ($LASTEXITCODE -ne 0) { throw "Compiling the AgentShield app failed (exit code $LASTEXITCODE)." }
Write-Host "Built $out"
