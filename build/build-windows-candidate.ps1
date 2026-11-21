param(
    [ValidateSet('Private', 'TrustedSigned')][string]$Mode = 'Private',
    [Parameter(Mandatory)][string]$OutputDirectory,
    [string]$SevenZip = "$env:ProgramFiles/7-Zip/7z.exe",
    [string]$SignerSha1 = $env:ASSCRACK_WINDOWS_SIGNER_SHA1,
    [string]$SignerSha256 = $env:ASSCRACK_WINDOWS_SIGNER_SHA256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Use this build script on Windows.' }
$root = Split-Path $PSScriptRoot -Parent
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'Use a fresh output directory.' }
if (-not (Test-Path -LiteralPath $SevenZip -PathType Leaf)) { throw 'Set SevenZip to its installed executable.' }

$envNames = @('CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'CSC_IDENTITY_AUTO_DISCOVERY')
$restoreEnvironment = @{}
foreach ($name in $envNames) { $restoreEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$work = Join-Path ([System.IO.Path]::GetTempPath()) "asscrack-build-$([Guid]::NewGuid().ToString('N'))"
$staged = "$output-pending-$([Guid]::NewGuid().ToString('N'))"
Push-Location $root
try {
    $source = (git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $source -notmatch '\A[0-9a-f]{40}\z') { throw 'Could not identify the source commit.' }
    $changes = git status --porcelain --untracked-files=all
    if ($LASTEXITCODE -ne 0 -or $changes) { throw 'Build from a clean checkout so the candidate can be traced to one source commit.' }

    $package = Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json -AsHashtable
    $config = $package.build
    $config.directories.output = Join-Path $work 'dist'
    $config.forceCodeSigning = $Mode -eq 'TrustedSigned'
    $variant = if ($config.forceCodeSigning) { 'signed' } else { 'private-unsigned' }
    $config.portable.artifactName = "ASSCRACK-$($package.version)-windows-x64-$variant-$($source.Substring(0, 12)).exe"
    if ($config.portable.Contains('unpackDirName')) { throw 'Use the build-specific portable extraction directory.' }

    # Ignore ambient certificate credentials. The signed mode selects exactly one installed signer.
    foreach ($name in $envNames) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
    if ($config.forceCodeSigning) {
        if ($SignerSha1 -notmatch '\A[0-9a-fA-F]{40}\z' -or $SignerSha256 -notmatch '\A[0-9a-fA-F]{64}\z') {
            throw 'Both fingerprints of the approved, installed Windows code-signing certificate are required.'
        }
        $certificate = Get-Item -LiteralPath "Cert:/CurrentUser/My/$SignerSha1"
        if (-not $certificate.HasPrivateKey -or
            $certificate.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256) -ne $SignerSha256) {
            throw 'The installed code-signing identity does not match the approved certificate.'
        }
        $config.win.signtoolOptions = @{
            certificateSha1 = $SignerSha1
            signingHashAlgorithms = @('sha256')
            rfc3161TimeStampServer = 'https://timestamp.digicert.com'
        }
        [Environment]::SetEnvironmentVariable('CSC_IDENTITY_AUTO_DISCOVERY', 'true', 'Process')
    } else {
        [Environment]::SetEnvironmentVariable('CSC_IDENTITY_AUTO_DISCOVERY', 'false', 'Process')
    }

    [System.IO.Directory]::CreateDirectory($work) | Out-Null
    $config.electronDist = & "$PSScriptRoot/get-windows-electron.ps1" -OutputDirectory (Join-Path $work 'electron')
    $configPath = Join-Path $work 'build.json'
    ConvertTo-Json -InputObject $config -Depth 32 | Set-Content -LiteralPath $configPath -Encoding utf8
    & node './node_modules/electron-builder/out/cli/cli.js' --win portable --x64 --publish never --config $configPath
    if ($LASTEXITCODE -ne 0) { throw 'Windows portable build failed.' }
    $exe = Join-Path $config.directories.output $config.portable.artifactName
    $verification = Join-Path $work 'verify'
    & node './build/verify-windows-portable.cjs' $exe $verification $SevenZip $config.electronDist
    if ($LASTEXITCODE -ne 0) { throw 'The embedded Windows payload did not match the candidate source.' }
    $evidence = Get-Content -LiteralPath (Join-Path $verification 'verification.json') -Raw | ConvertFrom-Json -AsHashtable
    if ($config.forceCodeSigning) {
        $evidence.signatures = @(& "$PSScriptRoot/verify-windows-signatures.ps1" -Files @($exe, $evidence.application) -SignerSha256 $SignerSha256)
    } else {
        $signature = Get-AuthenticodeSignature -LiteralPath $exe
        if ($signature.Status -ne 'NotSigned') { throw 'The private unsigned output unexpectedly contains a signature.' }
    }
    $evidence.Remove('application')
    $evidence.source = $source
    $evidence.outputMode = $Mode

    [System.IO.Directory]::CreateDirectory($staged) | Out-Null
    Copy-Item -LiteralPath $exe -Destination $staged
    ConvertTo-Json -InputObject $evidence -Depth 32 | Set-Content -LiteralPath (Join-Path $staged 'verification.json') -Encoding utf8
    [System.IO.Directory]::Move($staged, $output)
    Write-Output "Verified candidate and evidence: $output"
} finally {
    foreach ($name in $envNames) { [Environment]::SetEnvironmentVariable($name, $restoreEnvironment[$name], 'Process') }
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
    if (Test-Path -LiteralPath $staged) { Remove-Item -LiteralPath $staged -Recurse -Force }
    Pop-Location
}
