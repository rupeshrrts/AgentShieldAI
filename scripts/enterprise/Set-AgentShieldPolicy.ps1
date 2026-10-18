<#
.SYNOPSIS
  Superseded by scripts\system-installer\Install-AgentShield.ps1 (kept so existing instructions still work).

.DESCRIPTION
  Forwards to Install-AgentShield.ps1, which writes the Chrome and Edge policies safely
  (existing policy entries are preserved) and looks up the extension ID and update URL
  from the AgentShield server.

  Only the server address (apiUrl) and, optionally, the dashboard address (dashboardUrl) are
  written. Organization enrollment codes and device keys are no longer used: stale
  enrollmentCode/deviceKey policy values are removed, and every user activates their own
  browser once (sign in + activation code from the dashboard: My activation).

.EXAMPLE
  .\Set-AgentShieldPolicy.ps1 -ApiUrl https://agentshield.company.com
.EXAMPLE
  .\Set-AgentShieldPolicy.ps1 -ApiUrl https://agentshield.company.com -DashboardUrl https://dashboard.company.com
.EXAMPLE
  .\Set-AgentShieldPolicy.ps1 -Remove
#>
[CmdletBinding()]
param(
    [Alias('ServerUrl')]
    [string]$ApiUrl,
    [string]$DashboardUrl,
    [switch]$Remove,
    [switch]$BlockDeveloperTools
)

$installer = Join-Path $PSScriptRoot '..\system-installer\Install-AgentShield.ps1'
if ($Remove) {
    & $installer -Uninstall
} else {
    & $installer -ServerUrl $ApiUrl -DashboardUrl $DashboardUrl -BlockDeveloperTools:$BlockDeveloperTools
}
exit $LASTEXITCODE
