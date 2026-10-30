<#
.SYNOPSIS
  Removes the AgentShield Network Agent: stops the service, clears the proxy, removes the certificate,
  disconnects the PC and deletes the files. Run as Administrator.
#>
[CmdletBinding()]
param([int]$Port = 8080)

$ErrorActionPreference = 'Continue'
$InstallDir = Join-Path $env:ProgramFiles 'AgentShield\Agent'
$DataDir    = Join-Path $env:ProgramData 'AgentShield\Agent'
$Exe        = Join-Path $InstallDir 'agentshield-agent.exe'
$TaskName   = 'AgentShieldAgent'

$p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'Run as Administrator.' -ForegroundColor Red; exit 1
}

# 1. Disconnect this PC from the account (best effort) and stop the service
if (Test-Path $Exe) { try { & $Exe disconnect } catch {} }
schtasks.exe /End /TN $TaskName 2>$null | Out-Null
schtasks.exe /Delete /TN $TaskName /F 2>$null | Out-Null
Get-Process agentshield-agent -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# 2. Clear the proxy
$reg = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
Remove-ItemProperty -Path $reg -Name 'AutoConfigURL' -ErrorAction SilentlyContinue
Write-Host 'Proxy cleared.'

# 3. Remove the AgentShield inspection certificate(s) from Trusted Root
Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Subject -like '*AgentShield Local AI Inspection CA*' } | ForEach-Object {
    Remove-Item $_.PSPath -Force -ErrorAction SilentlyContinue
    Write-Host "Removed certificate $($_.Thumbprint)."
}

# 4. Remove Firefox policy if we wrote it
foreach ($base in @("$env:ProgramFiles\Mozilla Firefox", "${env:ProgramFiles(x86)}\Mozilla Firefox")) {
    $pol = Join-Path $base 'distribution\policies.json'
    if (Test-Path $pol) { Remove-Item $pol -Force -ErrorAction SilentlyContinue }
}

# 5. Delete files
Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $DataDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host 'AgentShield Network Agent removed. Restart open browsers to drop the proxy.'
exit 0
