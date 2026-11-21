param(
    [Parameter(Mandatory)][string[]]$Files,
    [Parameter(Mandatory)][string]$SignerSha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $IsWindows) { throw 'Authenticode trust verification requires Windows.' }
if ($SignerSha256 -notmatch '\A[0-9a-fA-F]{64}\z') { throw 'Set the approved code-signing certificate SHA-256 fingerprint.' }
foreach ($file in $Files) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($signature.Status -ne 'Valid' -or $signature.SignatureType -ne 'Authenticode' -or
        $null -eq $signature.SignerCertificate -or $null -eq $signature.TimeStamperCertificate) {
        throw "Expected valid, embedded, timestamped Authenticode on $(Split-Path $file -Leaf). Status: $($signature.Status)"
    }
    $fingerprint = $signature.SignerCertificate.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256)
    if ($fingerprint -ne $SignerSha256) { throw "Unexpected Authenticode signer on $(Split-Path $file -Leaf)." }
    [pscustomobject]@{
        file = Split-Path $file -Leaf
        signerSha256 = $fingerprint.ToLowerInvariant()
        timestamped = $true
        trusted = $true
    }
}
