param(
    [Parameter(Mandatory = $true)][string]$LocalState,
    [Parameter(Mandatory = $true)][string]$Database,
    [Parameter(Mandatory = $true)][string]$Wrapper
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$owner = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($owner)
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    @{ outcome = 'unavailable'; stage = 'administrator-token' } | ConvertTo-Json -Compress
    exit 0
}

$suffix = [Guid]::NewGuid().ToString('N')
$userName = 'acpilot_' + $suffix.Substring(0, 10)
$directory = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) ('asscrack-pilot-' + $suffix)
$fixtureNames = @('archive.db', 'archive.key', 'profile-key.dpapi')
$account = $null
$worker = $null
$result = @{ outcome = 'unavailable'; stage = 'local-account'; temporaryProfileRemoved = $null; temporaryAccountRemoved = $null }

$workerCode = @'
$ErrorActionPreference = 'Stop'
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
    $random = [byte[]]::new(30)
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($random) } finally { $rng.Dispose() }
    $password = ConvertTo-SecureString ('A9!' + [Convert]::ToBase64String($random)) -AsPlainText -Force
    [Array]::Clear($random, 0, $random.Length)
    $account = New-LocalUser -Name $userName -Password $password -Description 'Temporary ASSCRACK Windows verification'
    $result.stage = 'standard-user-group'
    $users = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
    if (!(Get-LocalGroupMember -SID $users | Where-Object { $_.SID -eq $account.SID })) {
        Add-LocalGroupMember -SID $users -Member $account
    }

    $result.stage = 'readable-fixture'
    $null = New-Item -ItemType Directory -Path $directory
    $acl = Get-Acl -LiteralPath $directory
    $acl.SetAccessRuleProtection($true, $false)
    $inherits = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($owner.User, 'FullControl', $inherits, 'None', 'Allow'))
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($account.SID, 'ReadAndExecute', $inherits, 'None', 'Allow'))
    Set-Acl -LiteralPath $directory -AclObject $acl

    [IO.File]::WriteAllBytes((Join-Path $directory 'archive.db'), [IO.File]::ReadAllBytes($Database))
    [IO.File]::WriteAllBytes((Join-Path $directory 'archive.key'), [IO.File]::ReadAllBytes($Wrapper))
    $state = Get-Content -LiteralPath $LocalState -Raw | ConvertFrom-Json
    $blob = [Convert]::FromBase64String($state.os_crypt.encrypted_key)
    if ($blob.Length -le 5 -or [Text.Encoding]::ASCII.GetString($blob, 0, 5) -cne 'DPAPI') { throw 'Unexpected profile-key envelope' }
    [byte[]]$payload = $blob[5..($blob.Length - 1)]
    [IO.File]::WriteAllBytes((Join-Path $directory 'profile-key.dpapi'), $payload)
    $files = foreach ($name in $fixtureNames) {
        @{ name = $name; hash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $directory $name)).Hash }
    }
    @{ owner = $owner.User.Value; reader = $account.SID.Value; files = @($files) } | ConvertTo-Json -Depth 4 |
        Set-Content -Encoding UTF8 -LiteralPath (Join-Path $directory 'fixture.json')

    $result.stage = 'alternate-logon'
    $credential = [PSCredential]::new("$env:COMPUTERNAME\$userName", $password)
    $preamble = "`$directory = '" + $directory.Replace("'", "''") + "'`n"
    $command = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($preamble + $workerCode))
    $worker = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Credential $credential -LoadUserProfile `
        -WorkingDirectory $directory -UseNewEnvironment -WindowStyle Hidden -PassThru `
        -ArgumentList '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $command
    if (!$worker.WaitForExit(35000)) {
        $worker.Kill()
        $null = $worker.WaitForExit(5000)
        throw 'Alternate account check timed out'
    }
    $result.stage = 'foreign-account-read'
    $result.workerExit = $worker.ExitCode
    if ($worker.ExitCode -eq 0) {
        $result.outcome = 'passed'
        $result.differentUnprivilegedSid = $true
        $result.sameCiphertextReadable = $true
        $result.alternateDpapiRoundTrip = $true
        $result.originalDpapiKeyDenied = $true
    } else { $result.outcome = 'failed' }
} catch {
    if ($result.stage -eq 'readable-fixture' -or $result.stage -eq 'foreign-account-read') { $result.outcome = 'failed' }
} finally {
    if ($worker) { $worker.Dispose() }
    if (Test-Path -LiteralPath $directory) {
        try { Remove-Item -LiteralPath $directory -Recurse -Force }
        catch { $result.temporaryFixtureRemoved = $false }
    }
    if ($account) {
        try {
            $profile = Get-CimInstance -ClassName Win32_UserProfile -Filter "SID='$($account.SID.Value)'"
            if ($profile -and !$profile.Loaded) { $profile | Remove-CimInstance }
            $result.temporaryProfileRemoved = !(Get-CimInstance -ClassName Win32_UserProfile -Filter "SID='$($account.SID.Value)'")
        } catch { $result.temporaryProfileRemoved = $false }
        try {
            Remove-LocalUser -SID $account.SID
            $result.temporaryAccountRemoved = $true
        } catch { $result.temporaryAccountRemoved = $false }
    }
    if ($password) { $password.Dispose() }
}

$result | ConvertTo-Json -Compress
