param([Parameter(Mandatory=$true)][string]$Program)
$ErrorActionPreference = 'Stop'
$programPath = [IO.Path]::GetFullPath($Program)
$rules = @(Get-NetFirewallApplicationFilter -Program $programPath -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' })
$allowRules = @($rules | Where-Object { $_.Action -eq 'Allow' })
$blockRules = @($rules | Where-Object { $_.Action -eq 'Block' })
$profiles = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | ForEach-Object { [ordered]@{ name=$_.Name; category=$_.NetworkCategory.ToString() } })
[ordered]@{ allowed=($allowRules.Count -gt 0 -and $blockRules.Count -eq 0); blocked=($blockRules.Count -gt 0); profiles=$profiles; temporaryLocation=($programPath -like ($env:TEMP+'\*')) } | ConvertTo-Json -Depth 4 -Compress
