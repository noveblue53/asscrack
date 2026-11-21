$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ($env:GITHUB_EVENT_NAME -eq 'push') {
    $pin = Get-Content -LiteralPath './ci/hardened-windows-draft-pin.json' -Raw | ConvertFrom-Json
    $env:RELEASE_ID = [string]$pin.releaseId
    $env:ASSET_ID = [string]$pin.assetId
    $env:SOURCE_SHA = [string]$pin.sourceSha
    $env:ASSET_SHA256 = [string]$pin.assetSha256
}
if ($env:RELEASE_ID -notmatch '\A[1-9][0-9]{0,17}\z' -or $env:ASSET_ID -notmatch '\A[1-9][0-9]{0,17}\z' -or
    $env:SOURCE_SHA -notmatch '\A[0-9a-fA-F]{40}\z' -or $env:ASSET_SHA256 -notmatch '\A[0-9a-fA-F]{64}\z') {
    throw 'Enter the exact draft release ID, asset ID, source and executable digests.'
}
Write-Output "::add-mask::$env:RELEASE_ID"
Write-Output "::add-mask::$env:ASSET_ID"
Write-Output "::add-mask::$env:SOURCE_SHA"
Write-Output "::add-mask::$env:ASSET_SHA256"
if ($env:GITHUB_REPOSITORY -ne 'noveblue53/asscrack') { throw 'This draft verification is repository-scoped.' }
$release = gh api --method GET "repos/$env:GITHUB_REPOSITORY/releases/$env:RELEASE_ID" | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $release.draft -ne $true -or $release.target_commitish -ine $env:SOURCE_SHA) {
    throw 'The selected release is not a draft pinned to the requested source commit.'
}
$assets = @($release.assets | Where-Object { [string]$_.id -eq $env:ASSET_ID })
if ($assets.Count -ne 1 -or $assets[0].state -ne 'uploaded' -or
    $assets[0].name -notmatch '\AASSCRACK-[A-Za-z0-9._-]{1,160}\.exe\z' -or
    ($assets[0].digest -and $assets[0].digest -ine "sha256:$env:ASSET_SHA256")) {
    throw 'The draft asset was not found or its recorded digest did not match.'
}

$root = Join-Path $env:RUNNER_TEMP ('asscrack-native-smoke-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $root
"ASSCRACK_SMOKE_ROOT=$root" >> $env:GITHUB_ENV
$exe = Join-Path $root $assets[0].name
curl.exe --location --max-redirs 3 --proto '=https' --proto-redir '=https' --fail --silent --show-error `
    --header 'Accept: application/octet-stream' --header "Authorization: Bearer $env:GH_TOKEN" `
    --output $exe "https://api.github.com/repos/$env:GITHUB_REPOSITORY/releases/assets/$env:ASSET_ID"
if ($LASTEXITCODE -ne 0) { throw 'Could not download the pinned draft asset.' }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash -ine $env:ASSET_SHA256 -or
    (Get-Item -LiteralPath $exe).Length -ne $assets[0].size) { throw 'The downloaded asset is not the requested executable.' }
$candidate = Join-Path $root 'candidate.exe'
Move-Item -LiteralPath $exe -Destination $candidate
"ASSCRACK_SMOKE_EXE=$candidate" >> $env:GITHUB_ENV
"ASSCRACK_SMOKE_SHA256=$env:ASSET_SHA256" >> $env:GITHUB_ENV
Write-Output 'Verified the exact asset bytes and source pin from the private draft.'
