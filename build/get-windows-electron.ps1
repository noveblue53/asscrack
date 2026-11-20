param([Parameter(Mandatory)][string]$OutputDirectory)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$lock = Get-Content -LiteralPath (Join-Path $root 'package-lock.json') -Raw | ConvertFrom-Json -AsHashtable
$version = $lock.packages['node_modules/electron'].version
if ($version -notmatch '\A\d+\.\d+\.\d+\z') { throw 'Expected a pinned Electron release version.' }
$filename = "electron-v$version-win32-x64.zip"
$checksums = Get-Content -LiteralPath (Join-Path $root 'node_modules/electron/checksums.json') -Raw | ConvertFrom-Json -AsHashtable
$expected = $checksums[$filename]
if ($expected -notmatch '\A[0-9a-fA-F]{64}\z') { throw 'The locked Electron package lacks the official Windows x64 checksum.' }
[System.IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$archive = Join-Path $OutputDirectory $filename
if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
    Invoke-WebRequest -Uri "https://github.com/electron/electron/releases/download/v$version/$filename" -OutFile $archive -TimeoutSec 180
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) { throw 'Official Windows x64 Electron archive checksum mismatch.' }
$archive
