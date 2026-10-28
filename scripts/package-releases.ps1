param([switch]$SkipWindows)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$releaseRoot = Join-Path $projectRoot 'releases'
$desktopVersion = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
if ($desktopVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid desktop release version' }
[xml]$androidManifest = Get-Content -LiteralPath (Join-Path $projectRoot 'android\AndroidManifest.xml')
$androidVersion = $androidManifest.manifest.GetAttribute('versionName', 'http://schemas.android.com/apk/res/android')
if ($androidVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid Android release version' }
$stageRoot = Join-Path $projectRoot ('.build\notemark-release-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
$windowsRoot = Join-Path $releaseRoot 'NoteMark-Windows'
if (-not $SkipWindows) {
    foreach ($doc in @('README.md','QUICK-START.md','VERIFICATION.md','LICENSE','CONTRIBUTING.md','SECURITY.md')) { Copy-Item -LiteralPath (Join-Path $projectRoot $doc) -Destination $windowsRoot -Force }
    Compress-Archive -LiteralPath $windowsRoot -DestinationPath (Join-Path $releaseRoot 'NoteMark-Windows.zip') -CompressionLevel Optimal -Force
}
$serverStage = Join-Path $stageRoot 'NoteMark-Sync-Server'
New-Item -ItemType Directory -Path $serverStage -Force | Out-Null
foreach ($dir in @('server','deploy')) { Copy-Item -LiteralPath (Join-Path $projectRoot $dir) -Destination $serverStage -Recurse -Force }
foreach ($file in @('.dockerignore','QUICK-START.md','VERIFICATION.md')) { Copy-Item -LiteralPath (Join-Path $projectRoot $file) -Destination $serverStage -Force }
Compress-Archive -LiteralPath $serverStage -DestinationPath (Join-Path $releaseRoot 'NoteMark-Sync-Server.zip') -Force
$sourceStage = Join-Path $stageRoot 'NoteMark-Source'
New-Item -ItemType Directory -Path $sourceStage -Force | Out-Null
foreach ($dir in @('web','desktop','server','deploy','scripts','test')) { Copy-Item -LiteralPath (Join-Path $projectRoot $dir) -Destination $sourceStage -Recurse -Force }
$androidStage = Join-Path $sourceStage 'android'
New-Item -ItemType Directory -Path $androidStage -Force | Out-Null
foreach ($dir in @('src','res')) { Copy-Item -LiteralPath (Join-Path $projectRoot "android\$dir") -Destination $androidStage -Recurse -Force }
foreach ($file in @('AndroidManifest.xml','README.md')) { Copy-Item -LiteralPath (Join-Path $projectRoot "android\$file") -Destination $androidStage -Force }
$androidTestStage = Join-Path $sourceStage 'android-tests'
New-Item -ItemType Directory -Path $androidTestStage -Force | Out-Null
foreach ($file in @('build.gradle','settings.gradle','README.md')) { Copy-Item -LiteralPath (Join-Path $projectRoot "android-tests\$file") -Destination $androidTestStage -Force }
Copy-Item -LiteralPath (Join-Path $projectRoot 'android-tests\src') -Destination $androidTestStage -Recurse -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'docs') -Destination $sourceStage -Recurse -Force
foreach ($file in @('package.json','package-lock.json','electron-builder.yml','.gitignore','.dockerignore','README.md','QUICK-START.md','VERIFICATION.md','LICENSE','CONTRIBUTING.md','SECURITY.md')) { Copy-Item -LiteralPath (Join-Path $projectRoot $file) -Destination $sourceStage -Force }
Compress-Archive -LiteralPath $sourceStage -DestinationPath (Join-Path $releaseRoot 'NoteMark-Source.zip') -Force
$installerSource = 'installer\NoteMark-Setup-' + $desktopVersion + '.exe'
$installerName = 'NoteMark-Setup-' + $desktopVersion + '.exe'
foreach ($pair in @(@('NoteMark-Android.apk',("NoteMark-Android-"+$androidVersion+'.apk')),@($installerSource,$installerName),@($installerSource,'Setup.exe'))) { Copy-Item -LiteralPath (Join-Path $releaseRoot $pair[0]) -Destination (Join-Path $releaseRoot $pair[1]) -Force }
$archiveNames = @('NoteMark-Android.apk',("NoteMark-Android-"+$androidVersion+'.apk'),$installerName,'Setup.exe','NoteMark-Windows.zip','NoteMark-Sync-Server.zip','NoteMark-Source.zip')
$sumLines = foreach ($name in $archiveNames) { $hash = Get-FileHash -LiteralPath (Join-Path $releaseRoot $name) -Algorithm SHA256; "$($hash.Hash.ToLowerInvariant())  $name" }
$sumLines | Set-Content -LiteralPath (Join-Path $releaseRoot 'NoteMark-SHA256SUMS.txt') -Encoding utf8
Get-Item -LiteralPath ($archiveNames | ForEach-Object { Join-Path $releaseRoot $_ }) | Select-Object Name,Length
