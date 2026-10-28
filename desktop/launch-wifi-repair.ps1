param([Parameter(Mandatory=$true)][string]$Program)
$ErrorActionPreference = 'Stop'
$programPath = (Resolve-Path -LiteralPath $Program).Path
$repairScript = Join-Path $PSScriptRoot 'repair-wifi.ps1'
$arguments = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$repairScript+'"'),'-Program',('"'+$programPath+'"'))
try {
    $repairProcess = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    if ($repairProcess.ExitCode -ne 0) { throw 'Wi-Fi access could not be configured. Run Setup.exe again.' }
} catch { Write-Error $_.Exception.Message; exit 1 }
