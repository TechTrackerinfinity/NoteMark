param(
    [Parameter(Mandatory=$true)][string]$Program,
    [switch]$Remove,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$programPath = [IO.Path]::GetFullPath($Program)
if ([IO.Path]::GetFileName($programPath) -notin @('NoteMark.exe','Mira Notes.exe')) { throw 'Expected the NoteMark executable.' }
if (-not $Remove -and -not (Test-Path -LiteralPath $programPath -PathType Leaf)) { throw 'NoteMark executable not found.' }
$sha = [Security.Cryptography.SHA256]::Create()
try { $pathHash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($programPath.ToLowerInvariant()))).Replace('-','').Substring(0,16) }
finally { $sha.Dispose() }
$ruleName = 'MiraNotes-WiFi-47821-' + $pathHash
$plan = [ordered]@{ ruleName=$ruleName; program=$programPath; direction='Inbound'; protocol='TCP'; localPort=47821; remoteAddress='LocalSubnet'; profile='Any'; remove=[bool]$Remove }
if ($DryRun) { $plan | ConvertTo-Json; exit 0 }
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Windows administrator approval is needed to configure Wi-Fi access.' }
# Only this app's rule is replaced. Network profiles and other firewall rules stay intact.
Get-NetFirewallRule -Name $ruleName -PolicyStore PersistentStore -ErrorAction SilentlyContinue | Remove-NetFirewallRule
if (-not $Remove) {
    New-NetFirewallRule -Name $ruleName -DisplayName 'NoteMark Wi-Fi Sync' -Group 'NoteMark' `
        -Description 'Allow NoteMark sync only from the local subnet on TCP 47821.' `
        -Direction Inbound -Action Allow -Enabled True -Program $programPath -Protocol TCP `
        -LocalPort 47821 -RemoteAddress LocalSubnet -Profile Any -EdgeTraversalPolicy Block | Out-Null
}
$plan | ConvertTo-Json
