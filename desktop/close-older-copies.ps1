param([Parameter(Mandatory=$true)][string]$InstalledProgram)
$ErrorActionPreference = 'Stop'
$targetPath = [IO.Path]::GetFullPath($InstalledProgram)
if ([IO.Path]::GetFileName($targetPath) -ne 'NoteMark.exe') { throw 'Expected the installed NoteMark executable.' }
$targetSession = [Diagnostics.Process]::GetCurrentProcess().SessionId
$oldCopies = @(Get-CimInstance Win32_Process -Filter "Name='NoteMark.exe' OR Name='Mira Notes.exe'" | Where-Object {
    $_.SessionId -eq $targetSession -and $_.ExecutablePath -and
    $_.ExecutablePath -ne $targetPath -and $_.CommandLine -notmatch '--type='
})
foreach ($oldCopy in $oldCopies) {
    $oldManifest = Join-Path ([IO.Path]::GetDirectoryName($oldCopy.ExecutablePath)) 'resources\app\package.json'
    if (-not (Test-Path -LiteralPath $oldManifest)) { continue }
    try { $identity = Get-Content -LiteralPath $oldManifest -Raw | ConvertFrom-Json } catch { continue }
    if ($identity.name -ne 'mira-notes' -or $identity.productName -notin @('NoteMark','Mira Notes')) { continue }
    $oldProcess = Get-Process -Id $oldCopy.ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $oldProcess) { continue }
    # Exit normally first so Chromium can flush the notebook storage.
    $null = $oldProcess.CloseMainWindow()
    if (-not $oldProcess.WaitForExit(5000)) { Stop-Process -Id $oldCopy.ProcessId -ErrorAction SilentlyContinue }
    Write-Output 'Closed an older portable NoteMark copy so the installed app can own the sync port.'
}
