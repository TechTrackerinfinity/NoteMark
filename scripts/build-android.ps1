param(
    [string]$AndroidSdk = $(if ($env:ANDROID_HOME) { $env:ANDROID_HOME } elseif ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { '' }),
    [string]$JavaHome = $env:JAVA_HOME,
    [string]$BuildToolsVersion = '36.0.0'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$androidRoot = Join-Path $projectRoot 'android'
$buildRoot = [IO.Path]::GetFullPath((Join-Path $androidRoot 'build'))
$webRoot = Join-Path $projectRoot 'web'
$releaseRoot = Join-Path $projectRoot 'releases'
$toolsRoot = Join-Path $AndroidSdk "build-tools\$BuildToolsVersion"
$platformJar = Join-Path $AndroidSdk 'platforms\android-36\android.jar'
$java = Join-Path $JavaHome 'bin\java.exe'
$javac = Join-Path $JavaHome 'bin\javac.exe'
$jar = Join-Path $JavaHome 'bin\jar.exe'
$keytool = Join-Path $JavaHome 'bin\keytool.exe'
$aapt2 = Join-Path $toolsRoot 'aapt2.exe'
$zipalign = Join-Path $toolsRoot 'zipalign.exe'
$d8Jar = Join-Path $toolsRoot 'lib\d8.jar'
$signerJar = Join-Path $toolsRoot 'lib\apksigner.jar'
$lambdaStubs = Join-Path $toolsRoot 'core-lambda-stubs.jar'

foreach ($required in @($java, $javac, $jar, $keytool, $aapt2, $zipalign, $d8Jar, $signerJar, $platformJar, $lambdaStubs)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required build tool not found: $required" }
}
if (-not (Test-Path -LiteralPath (Join-Path $webRoot 'index.html'))) {
    throw "The shared interface is missing: $webRoot\index.html"
}

function Invoke-BuildTool {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Build command failed ($LASTEXITCODE): $Executable" }
}
function Get-Sha256Text([string]$Path) {
    $inputStream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($inputStream)).Replace('-', '').ToLowerInvariant() }
    finally { $inputStream.Dispose(); $algorithm.Dispose() }
}

# Only the generated android/build directory is cleaned. Never remove sources or the signing key.
$expectedBuildRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'android\build'))
if ($buildRoot -ne $expectedBuildRoot -or -not $buildRoot.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar)) {
    throw "Unsafe build directory: $buildRoot"
}
if (Test-Path -LiteralPath $buildRoot) { Remove-Item -LiteralPath $buildRoot -Recurse -Force }
foreach ($folder in @($buildRoot, "$buildRoot\assets\web", "$buildRoot\gen", "$buildRoot\classes", "$buildRoot\dex", $releaseRoot)) {
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
}
Copy-Item -Path (Join-Path $webRoot '*') -Destination "$buildRoot\assets\web" -Recurse -Force
[xml]$androidManifest = [IO.File]::ReadAllText((Join-Path $androidRoot 'AndroidManifest.xml'))
$androidVersionName = $androidManifest.manifest.GetAttribute('versionName', 'http://schemas.android.com/apk/res/android')
if ($androidVersionName -notmatch '^\d+\.\d+\.\d+$') { throw 'Android versionName is missing or invalid.' }
# Desktop and Android can receive independent fixes. Display the installed APK's version.
$packagedIndex = Join-Path $buildRoot 'assets\web\index.html'
$indexText = [IO.File]::ReadAllText($packagedIndex)
$indexText = [regex]::Replace($indexText, 'NoteMark \d+\.\d+\.\d+(?= \u00b7)', ('NoteMark ' + $androidVersionName))
[IO.File]::WriteAllText($packagedIndex, $indexText, [Text.UTF8Encoding]::new($false))

Write-Host 'Compiling Android resources and shared interface...'
Invoke-BuildTool $aapt2 @('compile', '--dir', (Join-Path $androidRoot 'res'), '-o', "$buildRoot\resources.zip")
Invoke-BuildTool $aapt2 @('link', '-o', "$buildRoot\unsigned.apk", '--manifest',
    (Join-Path $androidRoot 'AndroidManifest.xml'), '-I', $platformJar, '--java', "$buildRoot\gen",
    '-A', "$buildRoot\assets", '--min-sdk-version', '26', '--target-sdk-version', '36',
    '--auto-add-overlay', "$buildRoot\resources.zip")

$sourceFiles = @(Get-ChildItem -LiteralPath (Join-Path $androidRoot 'src') -Filter '*.java' -Recurse |
    ForEach-Object { $_.FullName })
$sourceFiles += @(Get-ChildItem -LiteralPath "$buildRoot\gen" -Filter '*.java' -Recurse |
    ForEach-Object { $_.FullName })
Invoke-BuildTool $javac (@('-encoding', 'UTF-8', '-source', '8', '-target', '8', '-bootclasspath', "$platformJar;$lambdaStubs",
    '-d', "$buildRoot\classes") + $sourceFiles)
Invoke-BuildTool $jar @('cf', "$buildRoot\classes.jar", '-C', "$buildRoot\classes", '.')
Invoke-BuildTool $java @('-cp', $d8Jar, 'com.android.tools.r8.D8', '--lib', $platformJar,
    '--min-api', '26', '--output', "$buildRoot\dex", "$buildRoot\classes.jar")

# Rebuild through one fresh ZIP writer. Mutating a JAR-created ZIP with .NET Update
# can keep GPBF bit 3 but remove its required data descriptor. Android 16 then
# refuses classes.dex with "Failed to extract ... Inconsistent information".
# fflate level 0 uses ZIP STORED (unlike .NET Framework NoCompression, which
# writes DEFLATE level 0 and is rejected for resources.arsc on target Android 11+).
# Store DEX/resources uncompressed for direct Android loading and zip alignment.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
Invoke-BuildTool 'node.exe' @((Join-Path $PSScriptRoot 'repack-apk.mjs'), "$buildRoot\unsigned.apk", "$buildRoot\dex\classes.dex", "$buildRoot\normalized.apk")
Invoke-BuildTool $zipalign @('-f', '-p', '4', "$buildRoot\normalized.apk", "$buildRoot\aligned.apk")

$keyStore = Join-Path $androidRoot 'debug.keystore'
if (-not (Test-Path -LiteralPath $keyStore)) {
    Invoke-BuildTool $keytool @('-genkeypair', '-noprompt', '-keystore', $keyStore, '-storepass', 'android',
        '-keypass', 'android', '-alias', 'mira-development', '-keyalg', 'RSA', '-keysize', '2048',
        '-validity', '10000', '-dname', 'CN=Mira Notes Development,O=Mira Notes,C=IN')
}
$apk = Join-Path $releaseRoot 'NoteMark-Android.apk'
Invoke-BuildTool $java @('-jar', $signerJar, 'sign', '--ks', $keyStore, '--ks-key-alias', 'mira-development',
    '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--out', $apk, "$buildRoot\aligned.apk")
Invoke-BuildTool $zipalign @('-c', '-p', '4', $apk)
Invoke-BuildTool 'node.exe' @((Join-Path $PSScriptRoot 'verify-apk-zip.mjs'), $apk)
$signatureReport = & $java '-jar' $signerJar 'verify' '--verbose' '--print-certs' $apk
if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
$signatureReport | Set-Content -LiteralPath "$releaseRoot\Android-signature.txt" -Encoding utf8
$signatureReport | Write-Host
$manifestReport = & (Join-Path $toolsRoot 'aapt.exe') 'dump' 'badging' $apk
if ($LASTEXITCODE -ne 0) { throw 'APK manifest verification failed.' }
$manifestReport | Set-Content -LiteralPath "$releaseRoot\Android-manifest.txt" -Encoding utf8
$archive = [IO.Compression.ZipFile]::OpenRead($apk)
$assetReport = @()
try {
    foreach ($source in @(Get-ChildItem -LiteralPath "$buildRoot\assets\web" -File -Recurse)) {
        $relativeName = $source.FullName.Substring(("$buildRoot\assets\web").Length + 1).Replace('\', '/')
        $entryName = 'assets/web/' + $relativeName
        $entry = $archive.GetEntry($entryName)
        if ($null -eq $entry) { throw "Packaged asset missing: $entryName" }
        $input = $entry.Open()
        $hasher = [Security.Cryptography.SHA256]::Create()
        try { $assetHash = [BitConverter]::ToString($hasher.ComputeHash($input)).Replace('-', '').ToLowerInvariant() }
        finally { $input.Dispose(); $hasher.Dispose() }
        if ($assetHash -ne (Get-Sha256Text $source.FullName)) {
            throw "Packaged asset changed: $entryName"
        }
        $assetReport += "$assetHash  $entryName"
    }
    if (@($archive.Entries | Where-Object { $_.FullName.Contains('\') }).Count -gt 0) {
        throw 'APK contains invalid Windows path separators.'
    }
} finally { $archive.Dispose() }
$assetReport | Set-Content -LiteralPath "$releaseRoot\Android-assets.txt" -Encoding utf8
$hash = Get-Sha256Text $apk
Write-Host "Built: $apk"
Write-Host "SHA256: $hash"
