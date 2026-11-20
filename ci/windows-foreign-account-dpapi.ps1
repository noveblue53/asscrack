param(
    [Parameter(Mandatory = $true)][string]$LocalState,
    [Parameter(Mandatory = $true)][string]$Database,
    [Parameter(Mandatory = $true)][string]$Wrapper
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + ';' + $env:PSModulePath
$owner = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($owner)
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    @{ outcome = 'unavailable'; stage = 'administrator-token' } | ConvertTo-Json -Compress
    exit 0
}

$suffix = [Guid]::NewGuid().ToString('N')
$directory = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) ('asscrack-pilot-' + $suffix)
$fixtureNames = @('archive.db', 'archive.key', 'profile-key.dpapi')
$taskRegistered = $false
$taskName = 'AsscrackPilotDpapi-' + $suffix
$reader = [Security.Principal.SecurityIdentifier]::new('S-1-5-19')
$result = @{ outcome = 'unavailable'; stage = 'fixture-directory'; accountKind = 'local-service' }

function Get-ErrorFacts($record) {
    @{
        category = $record.CategoryInfo.Category.ToString()
        type = $record.Exception.GetType().Name
        code = ([string]$record.FullyQualifiedErrorId).Split(',')[0]
        hresult = $record.Exception.HResult
    }
}

$workerCode = @'
$ErrorActionPreference = 'Stop'
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + ';' + $env:PSModulePath
try {
    $fixture = Get-Content -LiteralPath (Join-Path $directory 'fixture.json') -Raw | ConvertFrom-Json
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if ($identity.User.Value -ne $fixture.reader -or $identity.User.Value -eq $fixture.owner -or
        $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 21 }

    foreach ($file in $fixture.files) {
        $hash = Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $directory $file.name)
        if ($hash.Hash -ne $file.hash) { exit 22 }
    }
    [byte[]]$protected = [IO.File]::ReadAllBytes((Join-Path $directory 'profile-key.dpapi'))

    Add-Type -AssemblyName System.Security
    $scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
    [byte[]]$challenge = 16, 32, 64, 128
    $control = [Security.Cryptography.ProtectedData]::Protect($challenge, $null, $scope)
    $readback = [Security.Cryptography.ProtectedData]::Unprotect($control, $null, $scope)
    if ([Convert]::ToBase64String($readback) -ne [Convert]::ToBase64String($challenge)) { exit 23 }

    try { $key = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, $scope) }
    catch {
        if ($_.Exception.InnerException -is [Security.Cryptography.CryptographicException]) { exit 0 }
        throw
    }
    [Array]::Clear($key, 0, $key.Length)
    exit 24
} catch { exit 25 }
'@

try {
    $null = New-Item -ItemType Directory -Path $directory
    $result.stage = 'fixture-permissions'
    $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
    $ownerRule = '*' + $owner.User.Value + ':(OI)(CI)F'
    $readerRule = '*' + $reader.Value + ':(OI)(CI)RX'
    $null = & $icacls $directory /grant:r $ownerRule $readerRule /inheritance:r 2>$null
    if ($LASTEXITCODE -ne 0) {
        $result.aclExit = $LASTEXITCODE
        throw 'Could not set isolated fixture ACL'
    }

    $result.stage = 'fixture-copy'
    [IO.File]::WriteAllBytes((Join-Path $directory 'archive.db'), [IO.File]::ReadAllBytes($Database))
    [IO.File]::WriteAllBytes((Join-Path $directory 'archive.key'), [IO.File]::ReadAllBytes($Wrapper))
    $result.stage = 'fixture-ciphertext'
    $state = Get-Content -LiteralPath $LocalState -Raw | ConvertFrom-Json
    $blob = [Convert]::FromBase64String($state.os_crypt.encrypted_key)
    if ($blob.Length -le 5 -or [Text.Encoding]::ASCII.GetString($blob, 0, 5) -cne 'DPAPI') { throw 'Unexpected profile-key envelope' }
    [byte[]]$payload = $blob[5..($blob.Length - 1)]
    [IO.File]::WriteAllBytes((Join-Path $directory 'profile-key.dpapi'), $payload)
    $result.stage = 'fixture-manifest'
    $files = foreach ($name in $fixtureNames) {
        @{ name = $name; hash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $directory $name)).Hash }
    }
    @{ owner = $owner.User.Value; reader = $reader.Value; files = @($files) } | ConvertTo-Json -Depth 4 |
        Set-Content -Encoding UTF8 -LiteralPath (Join-Path $directory 'fixture.json')

    $result.stage = 'alternate-logon'
    $preamble = "`$directory = '" + $directory.Replace("'", "''") + "'`n"
    $command = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($preamble + $workerCode))
    $powershell = Join-Path $PSHOME 'powershell.exe'
    $arguments = '-NoLogo -NoProfile -NonInteractive -EncodedCommand ' + $command
    $service = $reader.Translate([Security.Principal.NTAccount]).Value
    $principal = New-ScheduledTaskPrincipal -UserId $service -LogonType ServiceAccount -RunLevel Limited
    $action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $directory
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 45)
    $null = Register-ScheduledTask -TaskName $taskName -Principal $principal -Action $action -Settings $settings
    $taskRegistered = $true
    $previousStart = (Get-ScheduledTaskInfo -TaskName $taskName).LastRunTime
    Start-ScheduledTask -TaskName $taskName
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        Start-Sleep -Milliseconds 250
        $info = Get-ScheduledTaskInfo -TaskName $taskName
        $state = (Get-ScheduledTask -TaskName $taskName).State
        if ($info.LastRunTime -ne $previousStart -and $state -eq 'Ready') { break }
    } while ($timer.ElapsedMilliseconds -lt 35000)
    if ($info.LastRunTime -eq $previousStart -or $state -ne 'Ready') { throw 'Alternate account task timed out' }
    $result.stage = 'foreign-account-read'
    $result.workerExit = $info.LastTaskResult
    if ($result.workerExit -eq 0) {
        $result.outcome = 'passed'
        $result.differentUnprivilegedSid = $true
        $result.sameCiphertextReadable = $true
        $result.alternateDpapiRoundTrip = $true
        $result.originalDpapiKeyDenied = $true
    } else { $result.outcome = 'failed' }
} catch {
    $result.failure = Get-ErrorFacts $_
    if ($result.stage.StartsWith('fixture-') -or $result.stage -eq 'foreign-account-read') { $result.outcome = 'failed' }
} finally {
    if ($taskRegistered) {
        try {
            Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
            $result.temporaryTaskRemoved = $true
        } catch { $result.temporaryTaskRemoved = $false }
    }
    if (Test-Path -LiteralPath $directory) {
        try { Remove-Item -LiteralPath $directory -Recurse -Force }
        catch { $result.temporaryFixtureRemoved = $false }
    }
}

$result | ConvertTo-Json -Compress
