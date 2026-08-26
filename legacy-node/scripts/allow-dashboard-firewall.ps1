#Requires -RunAsAdministrator
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 8787
)

$ruleName = "EpikChat Dashboard (Local Network)"
$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue

if ($existing) {
  Set-NetFirewallRule -DisplayName $ruleName -Enabled True -Direction Inbound -Action Allow -Profile Private
  Set-NetFirewallAddressFilter -AssociatedNetFirewallRule $existing -RemoteAddress LocalSubnet
  Set-NetFirewallPortFilter -AssociatedNetFirewallRule $existing -Protocol TCP -LocalPort $Port
} else {
  New-NetFirewallRule `
    -DisplayName $ruleName `
    -Description "Allow the EpikChat dashboard from the private local subnet only." `
    -Enabled True `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $Port `
    -RemoteAddress LocalSubnet `
    -Profile Private | Out-Null
}

Write-Host "Allowed TCP port $Port from the private local subnet."
