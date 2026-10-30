<#
.SYNOPSIS
  Installs AgentShield for every user of this computer, in Google Chrome, Microsoft Edge and Brave,
  through the browsers' enterprise policies. Users cannot remove it. With -HelperPath it also registers
  the AgentShield Windows app, so each Windows user connects the PC once and every browser follows.

.DESCRIPTION
  Writes machine-wide browser policy (HKLM\SOFTWARE\Policies):
    * ExtensionInstallForcelist  - browsers install AgentShield automatically and keep it updated
    * 3rdparty extension policy  - the AgentShield server address (apiUrl) and, optionally, the
                                   dashboard address (dashboardUrl); users cannot change them
    * ExtensionInstallAllowlist  - keeps it allowed if extensions are otherwise restricted
    * optional: DeveloperToolsAvailability = 2 (blocks developer tools, which could bypass in-page checks)
  The extension ID and update URL come from the AgentShield server given with -ServerUrl
  (/extension-updates/info), so the same script works for self-hosted and store-published builds.

  Installing grants no access by itself and no organization key is written: every user activates
  their own browser once (generate a single-use activation code in the dashboard: My activation,
  then click the AgentShield icon and paste it; the extension asks for no password). AI sites stay blocked until then. Old enrollmentCode /
  deviceKey policy values from earlier versions are removed.

  IMPORTANT: Chrome and Edge only force-install a SELF-HOSTED extension on devices that are
  Active Directory domain-joined, Microsoft Entra (Azure AD) joined, or MDM/Intune enrolled
  (Chrome also accepts Chrome Browser Cloud Management). On other PCs, publish the extension to
  the Chrome Web Store / Edge Add-ons and set CHROME_STORE_EXTENSION_ID / EDGE_STORE_EXTENSION_ID
  on the server; this script then uses the store copies, which work on any Windows PC.

  Run as Administrator. Equivalent Group Policy / Intune settings are listed in DEPLOYMENT.md.

.EXAMPLE
  .\Install-AgentShield.ps1 -ServerUrl https://agentshield.company.com
.EXAMPLE
  .\Install-AgentShield.ps1 -ServerUrl https://agentshield.company.com -DashboardUrl https://dashboard.company.com -BlockDeveloperTools
.EXAMPLE
  .\Install-AgentShield.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    # AgentShield backend base URL. Written as the extension's apiUrl policy and used to look up
    # the extension ID / update URL. May be omitted only together with -ExtensionId and -UpdateUrl;
    # then no apiUrl is written and users get the server from their activation code.
    [Alias('ApiUrl')]
    [string]$ServerUrl,
    # Optional: dashboard address shown to users (dashboardUrl policy)
    [string]$DashboardUrl,
    [switch]$Uninstall,
    [switch]$BlockDeveloperTools,
    [ValidateSet('Chrome', 'Edge', 'Brave')]
    [string[]]$Browsers = @('Chrome', 'Edge', 'Brave'),
    # Optional: full path of AgentShieldHelper.exe (the AgentShield Windows app). Registers it as the
    # browsers' native messaging host, so a PC connected once in the app connects every browser.
    [string]$HelperPath,
    # Optional: Chrome Browser Cloud Management enrollment token (lets Chrome accept the
    # self-hosted extension on PCs that are not domain-joined).
    [string]$ChromeEnrollmentToken,
    # Only for testing: write under another registry root instead of HKLM\SOFTWARE\Policies
    [string]$PolicyRoot = 'HKLM:\SOFTWARE\Policies',
    # Skip the call to the server and use these values (testing, or installs without -ServerUrl)
    [string]$ExtensionId,
    [string]$UpdateUrl
)

$ErrorActionPreference = 'Stop'
$machineWide = $PolicyRoot -like 'HKLM:*'
$markerKey = if ($machineWide) { 'HKLM:\SOFTWARE\AgentShield' } else { Join-Path $PolicyRoot 'AgentShieldInstall' }
$logDir = if ($machineWide) { Join-Path $env:ProgramData 'AgentShield' } else { $env:TEMP }
$logFile = Join-Path $logDir 'install.log'

$browserRoots = @{
    Chrome = Join-Path $PolicyRoot 'Google\Chrome'
    Edge   = Join-Path $PolicyRoot 'Microsoft\Edge'
    Brave  = Join-Path $PolicyRoot 'BraveSoftware\Brave'
}

# Native messaging host of the AgentShield Windows app, registered for each browser (HKLM, all users)
$nativeHostName = 'com.agentshield.helper'
$nativeHostKeys = if ($machineWide) {
    @('HKLM:\SOFTWARE\Google\Chrome\NativeMessagingHosts', 'HKLM:\SOFTWARE\Microsoft\Edge\NativeMessagingHosts',
      'HKLM:\SOFTWARE\BraveSoftware\Brave-Browser\NativeMessagingHosts') | ForEach-Object { Join-Path $_ $nativeHostName }
} else {
    @(Join-Path $PolicyRoot "NativeMessagingHosts\$nativeHostName")
}

function Register-NativeHost([string]$Exe, [string[]]$ExtensionIds) {
    $dir = Split-Path -Parent $Exe
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $manifestPath = Join-Path $dir "$nativeHostName.json"
    $manifest = [ordered]@{
        name            = $nativeHostName
        description     = 'AgentShield Windows app (connects this PC''s browsers)'
        path            = $Exe
        type            = 'stdio'
        allowed_origins = @($ExtensionIds | Sort-Object -Unique | ForEach-Object { "chrome-extension://$_/" })
    }
    # UTF-8 without BOM: browsers refuse a manifest that starts with a BOM
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    foreach ($key in $nativeHostKeys) {
        Ensure-Key $key
        Set-ItemProperty -Path $key -Name '(default)' -Value $manifestPath
    }
    Write-Log "AgentShield app registered for Chrome, Edge and Brave ($manifestPath)."
}

function Unregister-NativeHost {
    foreach ($key in $nativeHostKeys) {
        if (Test-Path $key) { Remove-Item $key -Recurse -Force }
    }
}

function Write-Log([string]$Message) {
    $line = "{0:u}  {1}" -f (Get-Date), $Message
    Write-Host $Message
    try {
        New-Item -ItemType Directory -Force -Path $logDir | Out-Null
        Add-Content -Path $logFile -Value $line -Encoding UTF8
    } catch { }
}

function Assert-Admin {
    if (-not $machineWide) { return }
    $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this installer as Administrator (right-click > Run as administrator).'
    }
}

function ConvertTo-BaseUrl([string]$Url, [string]$Name) {
    if (-not $Url) { return '' }
    $u = ($Url -replace '\s', '').Trim('"', "'", '`', ',').TrimEnd('/')
    if (-not ($u -match '^https?://[^/]+')) { throw "$Name must be a full address such as https://agentshield.company.com" }
    return $u
}

# Policy values written by earlier versions (organization-wide enrollment). The extension ignores
# them now; they are removed so upgrades do not leave an organization key in the registry.
$legacyPolicyValues = @('enrollmentCode', 'deviceKey', 'userId', 'organizationName')

function Get-DeviceManagementState {
    $cs = Get-CimInstance Win32_ComputerSystem
    $status = (dsregcmd /status 2>$null) -join "`n"
    return [pscustomobject]@{
        DomainJoined = [bool]$cs.PartOfDomain
        EntraJoined  = $status -match 'AzureAdJoined\s*:\s*YES'
        MdmEnrolled  = [bool](Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Enrollments' -ErrorAction SilentlyContinue |
                         Where-Object { (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).ProviderID -eq 'MS DM Server' })
    }
}

function Ensure-Key([string]$Key) {
    # Never use New-Item -Force on an existing registry key: it recreates the key and deletes
    # every value in it (e.g. the company's other force-installed extensions).
    if (-not (Test-Path $Key)) { New-Item -Path $Key -Force | Out-Null }
}

function Set-ListEntry([string]$Key, [string]$Value, [string]$MatchPrefix) {
    # Chrome/Edge list policies are numbered string values (1, 2, 3...) under a key
    Ensure-Key $Key
    $props = (Get-Item $Key).Property
    foreach ($name in $props) {
        $current = (Get-ItemProperty -Path $Key -Name $name).$name
        if ($current -like "$MatchPrefix*") {
            Set-ItemProperty -Path $Key -Name $name -Value $Value
            return
        }
    }
    $numbers = @($props | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ })
    $next = if ($numbers.Count) { ($numbers | Measure-Object -Maximum).Maximum + 1 } else { 1 }
    New-ItemProperty -Path $Key -Name "$next" -Value $Value -PropertyType String -Force | Out-Null
}

function Remove-ListEntry([string]$Key, [string]$MatchPrefix) {
    if (-not (Test-Path $Key)) { return }
    foreach ($name in (Get-Item $Key).Property) {
        $current = (Get-ItemProperty -Path $Key -Name $name).$name
        if ($current -like "$MatchPrefix*") { Remove-ItemProperty -Path $Key -Name $name }
    }
}

function Uninstall-AgentShield {
    if (-not (Test-Path $markerKey)) { Write-Log 'AgentShield policies are not installed on this computer.'; return }
    $marker = Get-ItemProperty -Path $markerKey
    Unregister-NativeHost
    foreach ($browser in @('Chrome', 'Edge', 'Brave')) {
        $id = $marker."${browser}ExtensionId"
        if (-not $id) { continue }
        $root = $browserRoots[$browser]
        Remove-ListEntry (Join-Path $root 'ExtensionInstallForcelist') "$id;"
        Remove-ListEntry (Join-Path $root 'ExtensionInstallAllowlist') $id
        $cfg = Join-Path $root "3rdparty\extensions\$id"
        if (Test-Path $cfg) { Remove-Item $cfg -Recurse -Force }
        if ($marker."${browser}DevToolsSet" -eq 1) {
            Remove-ItemProperty -Path $root -Name 'DeveloperToolsAvailability' -ErrorAction SilentlyContinue
        }
        Write-Log "[$browser] AgentShield policies removed."
    }
    if ($marker.ChromeTokenSet -eq 1) {
        Remove-ItemProperty -Path $browserRoots['Chrome'] -Name 'CloudManagementEnrollmentToken' -ErrorAction SilentlyContinue
    }
    Remove-Item $markerKey -Recurse -Force
    Write-Log 'Done. Restart Chrome, Edge and Brave; AgentShield is removed automatically.'
}

function Install-AgentShieldPolicies {
    $server = ConvertTo-BaseUrl $ServerUrl 'The server address (-ServerUrl)'
    $dashboard = ConvertTo-BaseUrl $DashboardUrl 'The dashboard address (-DashboardUrl)'
    if (-not $server -and -not ($ExtensionId -and $UpdateUrl)) {
        throw 'Provide -ServerUrl (the AgentShield server address, e.g. https://agentshield.company.com). It is needed to find the extension package.'
    }
    if ($server) { Write-Log "Server: $server" } else { Write-Log 'Server: not set (users get it from their activation code)' }

    if ($ExtensionId -and $UpdateUrl) {
        $info = [pscustomobject]@{
            version = 'manual'
            chrome  = [pscustomobject]@{ id = $ExtensionId; update_url = $UpdateUrl; source = 'manual' }
            edge    = [pscustomobject]@{ id = $ExtensionId; update_url = $UpdateUrl; source = 'manual' }
        }
    } else {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        try {
            $info = Invoke-RestMethod -Uri "$server/extension-updates/info" -TimeoutSec 20
        } catch {
            throw "Cannot reach the AgentShield server at $server ($($_.Exception.Message)). Check the address and the network, or that the extension package has been built on the server."
        }
    }

    # Remove entries from a previous install (e.g. after switching from self-hosted to store IDs)
    if (Test-Path $markerKey) { Uninstall-AgentShield }

    $marker = @{ InstalledAt = (Get-Date).ToString('s'); ServerUrl = $server; Version = [string]$info.version }
    # The AgentShield Windows app reads the portal address from here ("Open the portal to get my code")
    if ($dashboard) { $marker['DashboardUrl'] = $dashboard }

    # Chrome and Edge ignore a self-hosted force-install on PCs that are not domain-joined, Entra-joined or
    # MDM-enrolled. Setup then installs the extension folder and the person adds it with "Load unpacked",
    # which needs Developer mode, so developer tools are not blocked on such PCs.
    $selfHostedUsed = @($Browsers | ForEach-Object { if ($_ -eq 'Edge') { $info.edge.source } else { $info.chrome.source } }) -contains 'self_hosted'
    $needsLoadUnpacked = $false
    if ($selfHostedUsed -and $machineWide -and -not $ChromeEnrollmentToken) {
        $state = Get-DeviceManagementState
        $needsLoadUnpacked = -not ($state.DomainJoined -or $state.EntraJoined -or $state.MdmEnrolled)
    }
    $marker['NeedsLoadUnpacked'] = [int]$needsLoadUnpacked
    $blockDevTools = $BlockDeveloperTools -and -not $needsLoadUnpacked
    if ($BlockDeveloperTools -and $needsLoadUnpacked) {
        Write-Log 'Developer tools are NOT blocked: this PC is not managed, so AgentShield is added with "Load unpacked", which needs Developer mode.'
    }
    $extensionIds = @()
    foreach ($browser in $Browsers) {
        # Brave installs from the Chrome Web Store (or the self-hosted package), like Chrome
        $entry = if ($browser -eq 'Edge') { $info.edge } else { $info.chrome }
        $extensionIds += $entry.id
        if (-not ($entry.id -match '^[a-p]{32}$')) { throw "Server returned an invalid extension ID for $browser." }
        $root = $browserRoots[$browser]

        Set-ListEntry (Join-Path $root 'ExtensionInstallForcelist') "$($entry.id);$($entry.update_url)" "$($entry.id);"
        Set-ListEntry (Join-Path $root 'ExtensionInstallAllowlist') $entry.id $entry.id

        $cfg = Join-Path $root "3rdparty\extensions\$($entry.id)\policy"
        Ensure-Key $cfg
        foreach ($old in $legacyPolicyValues) {
            Remove-ItemProperty -Path $cfg -Name $old -ErrorAction SilentlyContinue
        }
        # Only addresses are written; access comes from each user's own activation.
        if ($server) {
            New-ItemProperty -Path $cfg -Name 'apiUrl' -Value $server -PropertyType String -Force | Out-Null
        } else {
            Remove-ItemProperty -Path $cfg -Name 'apiUrl' -ErrorAction SilentlyContinue
        }
        if ($dashboard) {
            New-ItemProperty -Path $cfg -Name 'dashboardUrl' -Value $dashboard -PropertyType String -Force | Out-Null
        } else {
            Remove-ItemProperty -Path $cfg -Name 'dashboardUrl' -ErrorAction SilentlyContinue
        }

        $marker["${browser}ExtensionId"] = $entry.id
        if ($blockDevTools) {
            Ensure-Key $root
            New-ItemProperty -Path $root -Name 'DeveloperToolsAvailability' -Value 2 -PropertyType DWord -Force | Out-Null
            $marker["${browser}DevToolsSet"] = 1
        }
        Write-Log "[$browser] AgentShield will be installed from $($entry.source) ($($entry.id))."
    }

    if ($ChromeEnrollmentToken -and ($Browsers -contains 'Chrome')) {
        Ensure-Key $browserRoots['Chrome']
        New-ItemProperty -Path $browserRoots['Chrome'] -Name 'CloudManagementEnrollmentToken' -Value $ChromeEnrollmentToken -PropertyType String -Force | Out-Null
        $marker['ChromeTokenSet'] = 1
        Write-Log '[Chrome] Chrome Browser Cloud Management enrollment token set.'
    }

    if ($HelperPath) {
        Register-NativeHost $HelperPath ($extensionIds + @($info.chrome.id, $info.edge.id) | Where-Object { $_ -match '^[a-p]{32}$' })
        $marker['HelperPath'] = $HelperPath
    }

    Ensure-Key $markerKey
    foreach ($k in $marker.Keys) {
        $type = if ($marker[$k] -is [int]) { 'DWord' } else { 'String' }
        New-ItemProperty -Path $markerKey -Name $k -Value $marker[$k] -PropertyType $type -Force | Out-Null
    }

    if ($needsLoadUnpacked) {
        Write-Log ''
        Write-Log 'NOTE: this PC is not domain-joined, Entra-joined or MDM-enrolled.'
        Write-Log '  Chrome and Edge ignore self-hosted force-installs on such PCs, so AgentShield does not appear by itself.'
        Write-Log '  The setup wizard installs the extension folder and shows how to add it once per browser with "Load unpacked".'
        Write-Log '  For a fully automatic install, publish to the Chrome Web Store / Edge Add-ons and set the store IDs'
        Write-Log '  on the server (see DEPLOYMENT.md), or join the PC to your domain / Intune.'
    }

    Write-Log ''
    Write-Log 'Done. Restart Chrome, Edge and Brave. Within a few minutes AgentShield appears in the toolbar for every user.'
    if ($HelperPath) {
        Write-Log 'Each Windows user then connects the PC once in the AgentShield app ("Connect AgentShield" in the Start menu,'
        Write-Log 'or the portal''s "Connect this PC" button); every browser of that user then connects by itself.'
    } else {
        Write-Log 'Each user then activates it once: generate an activation code in the AgentShield dashboard (My activation),'
        Write-Log 'click the AgentShield icon, paste the code and click "Connect and verify". AI sites stay blocked until then.'
    }
    Write-Log 'Check chrome://policy, edge://policy and brave://policy if the icon does not appear.'
}

try {
    Assert-Admin
    if ($Uninstall) { Uninstall-AgentShield } else { Install-AgentShieldPolicies }
    exit 0
} catch {
    Write-Log "ERROR: $($_.Exception.Message)"
    exit 1
}
