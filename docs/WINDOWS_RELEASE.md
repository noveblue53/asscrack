# Windows candidate verification

The manually dispatched [Windows candidate workflow](../.github/workflows/windows-candidate.yml) builds from the chosen source ref. On the public repository it reports checks and hashes without uploading the executable. In a private repository it keeps the unsigned test artifact private. The workflow has read-only repository access and no publication step.

## Private test build

From a clean Windows checkout with Node and 7-Zip installed, run `npm ci --ignore-scripts` and `npm test`. Then use a fresh output directory.

```powershell
./build/build-windows-candidate.ps1 -OutputDirectory 'C:\builds\asscrack-private'
```

The filename and `verification.json` identify unsigned output, the source commit, the exact executable SHA-256 and the architecture. The checker opens the embedded package, verifies the application files, packaged dependency versions, native modules and Electron fuses against policy. It also compares the executable code and runtime components with the checksum-verified official Electron distribution. Each build gets its own portable extraction directory. Quit older copies before switching candidates because the profile is shared.

## Signed release staging

Use an approved Windows code-signing certificate available through the signing account's CurrentUser certificate store. Configure `ASSCRACK_WINDOWS_SIGNER_SHA1` for certificate selection and `ASSCRACK_WINDOWS_SIGNER_SHA256` for the independently approved fingerprint. The workflow uses a protected source ref and the `windows-release-signing` environment on a dedicated `asscrack-signing` Windows runner. The private key stays with the signing provider. Require an environment reviewer and restrict this runner to release jobs.

An operator can stage signed output locally instead. The build fails if the installed identity does not match or either executable lacks a valid, timestamped embedded signature.

```powershell
./build/build-windows-candidate.ps1 -Mode TrustedSigned -OutputDirectory 'C:\builds\asscrack-signed'
```

Private CI verifies the staged artifact on a fresh Windows runner with no signing credentials before producing its final verified artifact. For a public repository, repeat that readback verification on a clean Windows system after privately moving the signed executable and its manifest. Use a fresh verification directory and the clean checkout of the recorded source. Compare the reported outer and inner SHA-256 values with the signing manifest. Verify both signatures using the approved fingerprint from the release policy.

```powershell
$exe = 'C:\builds\asscrack-signed\ASSCRACK-<version>-windows-x64-signed-<commit>.exe'
$verify = 'C:\builds\asscrack-readback'
$runtime = ./build/get-windows-electron.ps1 -OutputDirectory 'C:\builds\electron-reference'
node build/verify-windows-portable.cjs $exe $verify "$env:ProgramFiles/7-Zip/7z.exe" $runtime
if ($LASTEXITCODE -ne 0) { throw 'Embedded package verification failed.' }
$result = Get-Content -LiteralPath "$verify/verification.json" -Raw | ConvertFrom-Json
./build/verify-windows-signatures.ps1 -Files @($exe, $result.application) -SignerSha256 $env:ASSCRACK_WINDOWS_SIGNER_SHA256
```

Publish only the exact bytes that passed independent signature and digest verification. The signing and packaging checks do not replace the app and field checks.
