<#
.SYNOPSIS
  Installs the AgentShield Network Agent on this PC so AI data protection applies to every browser
  (Chrome, Edge, Brave, Opera, Firefox) and desktop AI apps — with no browser extension and no
  Developer mode. Run as Administrator.

.DESCRIPTION
  AgentShield is the organisation's own data-loss-prevention tool. This installer sets it up the way
  enterprise DLP products do, but self-hosted and free:

    1. copies agentshield-agent.exe to Program Files and keeps its data folder admin-only;
    2. generates this PC's own inspection certificate (valid ONLY for the AI domains) and adds it to
       Trusted Root Certification Authorities, so the agent can check HTTPS AI sites;
    3. publishes a PAC proxy that sends ONLY the AI domains to the local agent and everything else
       DIRECT (banking, mail, etc. are never routed through it, never decrypted);
    4. runs the agent as a SYSTEM scheduled task that starts with the PC;
    5. optionally connects the PC with a portal activation code (-Code).

  Nothing is installed inside any browser. To make the proxy and certificate un-removable by users,
  push the same two settings through Group Policy / Intune instead of this script (see agent/README.md).

.PARAMETER Code
  A portal activation code (ASA1.… ) to connect this PC during install. You can also connect later:
  "agentshield-agent.exe connect ASA1.…".

.PARAMETER Firefox
  Also tell Firefox to trust the Windows certificate store (so AI sites work in Firefox too).

.EXAMPLE
  .\Install-Agent.ps1 -Code ASA1.xxxxxxxxxxxx
.EXAMPLE
  .\Install-Agent.ps1 -Code ASA1.xxxxxxxxxxxx -Firefox
.EXAMPLE
  .\Uninstall-Agent.ps1
#>
[CmdletBinding()]
param(
    [string]$Code,
    [switch]$Firefox,
    [string]$SourceExe = (Join-Path $PSScriptRoot "dist\agentshield-agent.exe"),
    [int]$Port = 8080
)

$ErrorActionPreference = 'Stop'
$InstallDir = Join-Path $env:ProgramFiles 'AgentShield\Agent'
$DataDir    = Join-Path $env:ProgramData 'AgentShield\Agent'
$Exe        = Join-Path $InstallDir 'agentshield-agent.exe'
$PacPath    = Join-Path $DataDir 'agentshield.pac'
$TaskName   = 'AgentShieldAgent'

# The AI domains the agent inspects — keep in step with agent/agentshield_agent/config.py
$AiDomains = @(
    'chatgpt.com','chat.openai.com','claude.ai','gemini.google.com','aistudio.google.com',
    'copilot.microsoft.com','perplexity.ai','deepseek.com','chat.mistral.ai','poe.com','meta.ai','grok.com'
)

function Assert-Admin {
    $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this installer as Administrator (right-click > Run as administrator).'
    }
}

function New-PacFile {
    $conds = ($AiDomains | ForEach-Object {
        "    if (dnsDomainIs(host, `"$_`") || shExpMatch(host, `"*.$_`")) return proxy;"
    }) -join "`n"
    $pac = @"
// AgentShield: send only AI domains to the local inspector; everything else goes direct.
function FindProxyForURL(url, host) {
    var proxy = "PROXY 127.0.0.1:$Port";
$conds
    return "DIRECT";
}
"@
    [IO.File]::WriteAllText($PacPath, $pac, (New-Object Text.UTF8Encoding($false)))
    Write-Host "PAC proxy written: $PacPath (AI domains -> 127.0.0.1:$Port, all else DIRECT)."
}

function Set-Proxy {
    # WinINET AutoConfigURL (HKCU): Chrome, Edge, Brave, Opera and Firefox (system setting) follow it.
    $reg = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
    $pacUrl = 'file:///' + ($PacPath -replace '\\', '/')
    Set-ItemProperty -Path $reg -Name 'AutoConfigURL' -Value $pacUrl
    Set-ItemProperty -Path $reg -Name 'ProxyEnable' -Value 0 -Type DWord
    Write-Host "System proxy set to the PAC (restart browsers to pick it up)."
}

function Trust-Certificate {
    $cer = Join-Path $DataDir 'ca\agentshield-root.cer'
    if (-not (Test-Path $cer)) { throw "Certificate not found at $cer (the agent did not create it)." }
    $imported = Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\Root
    Write-Host "Inspection certificate trusted (LocalMachine\Root, thumbprint $($imported.Thumbprint))."
    if ($Firefox) {
        # Firefox has its own store; this makes it trust the Windows roots.
        foreach ($base in @("$env:ProgramFiles\Mozilla Firefox", "${env:ProgramFiles(x86)}\Mozilla Firefox")) {
            if (Test-Path $base) {
                $dist = Join-Path $base 'distribution'
                New-Item -ItemType Directory -Force -Path $dist | Out-Null
                '{ "policies": { "Certificates": { "ImportEnterpriseRoots": true } } }' |
                    Set-Content -Path (Join-Path $dist 'policies.json') -Encoding utf8
                Write-Host "Firefox set to trust Windows enterprise roots ($dist\policies.json)."
            }
        }
    }
}

function Install-Service {
    # Run as SYSTEM at startup. (A pilot uses a scheduled task; production can use a service wrapper.)
    schtasks.exe /Create /TN $TaskName /TR "`"$Exe`" run --port $Port" /SC ONSTART /RU SYSTEM /RL HIGHEST /F | Out-Null
    schtasks.exe /Run /TN $TaskName | Out-Null
    Write-Host "Agent service installed and started (scheduled task '$TaskName', runs as SYSTEM)."
}

try {
    Assert-Admin
    if (-not (Test-Path $SourceExe)) { throw "agentshield-agent.exe not found at $SourceExe. Build it first (see agent/packaging)." }

    New-Item -ItemType Directory -Force -Path $InstallDir, $DataDir | Out-Null
    Copy-Item $SourceExe $Exe -Force

    # Lock the data folder (keys, state) to SYSTEM + Administrators only.
    icacls $DataDir /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null

    & $Exe new-ca | Out-Null
    Trust-Certificate
    New-PacFile
    Set-Proxy
    Install-Service

    if ($Code) {
        Write-Host "Connecting this PC..."
        & $Exe connect $Code
    } else {
        Write-Host "No -Code given. Connect later with:  `"$Exe`" connect ASA1.<your code from the portal>"
    }

    Write-Host ""
    Write-Host "Done. AgentShield now protects AI sites in every browser on this PC - no extension, no Developer mode."
    Write-Host "Restart open browsers so they pick up the proxy. Check status:  `"$Exe`" status"
    exit 0
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
