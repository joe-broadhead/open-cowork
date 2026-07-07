# Verifying Releases

Every Open Cowork release is published with tamper-evidence: a checksum
manifest, a detached signature for it (on signed releases), per-platform
code signatures, and GitHub build-provenance attestations. This page shows
how to verify a download before trusting it.

The examples use `joe-broadhead/open-cowork`; replace the owner/repo for a
downstream fork.

## What ships with a release

| Asset | Purpose |
| --- | --- |
| `Open-Cowork-<version>-<arch>.dmg` / `-mac.zip` | macOS installers |
| `Open-Cowork-<version>-x64-setup.exe` | Windows NSIS installer |
| `Open-Cowork-<version>-x64.AppImage` / `.deb` | Linux packages |
| `latest-mac.yml`, `latest.yml`, `*.blockmap` | electron-updater feed metadata (signed macOS/Windows builds only) |
| `SHA256SUMS.txt` | SHA-256 checksums for every asset |
| `SHA256SUMS.txt.asc` | Detached GPG signature of the checksum file (signed releases) |
| `sbom.cdx.json`, `sbom.spdx.json` | CycloneDX and SPDX software bill of materials |
| `THIRD_PARTY_NOTICES.md`, `THIRD_PARTY_LICENSES.tar.gz` | Third-party attribution |

## 1. Verify the checksum

Download your installer plus `SHA256SUMS.txt` into the same directory, then:

=== "macOS / Linux"

    ```bash
    shasum -a 256 -c SHA256SUMS.txt --ignore-missing
    ```

=== "Windows (PowerShell)"

    ```powershell
    $expected = (Select-String 'Open-Cowork-.*-setup.exe' SHA256SUMS.txt).Line.Split(' ')[0]
    $actual = (Get-FileHash .\Open-Cowork-<version>-x64-setup.exe -Algorithm SHA256).Hash.ToLower()
    if ($expected -eq $actual) { "OK" } else { throw "checksum mismatch" }
    ```

## 2. Verify the checksum signature (signed releases)

When `SHA256SUMS.txt.asc` is present, verify it before trusting the
checksums. Import the project's release GPG public key (published in the
release notes / `SECURITY.md`), then:

```bash
gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt
```

A good signature from the expected key means the checksum manifest — and by
extension every asset it lists — is authentic.

## 3. Verify GitHub build provenance

Release assets carry a signed provenance attestation tying them to this
repository's release workflow. With the GitHub CLI:

```bash
gh attestation verify ./Open-Cowork-<version>-x64-setup.exe \
  --repo joe-broadhead/open-cowork
```

Repeat for any asset (`.dmg`, `.zip`, `.AppImage`, `.deb`, `.exe`,
`SHA256SUMS.txt`, the SBOMs). The signed `latest.yml` / `latest-mac.yml`
update-feed metadata is attested too.

## 4. Verify the platform code signature

=== "macOS"

    Gatekeeper checks this automatically on first launch. To verify
    manually that the app is signed, notarized, and stapled:

    ```bash
    codesign --verify --deep --strict --verbose=2 /Applications/Open\ Cowork.app
    spctl -a -vv -t exec /Applications/Open\ Cowork.app
    xcrun stapler validate /Applications/Open\ Cowork.app
    ```

=== "Windows"

    Confirm the installer's Authenticode signature is valid and note the
    publisher:

    ```powershell
    Get-AuthenticodeSignature .\Open-Cowork-<version>-x64-setup.exe |
      Format-List Status, SignerCertificate
    ```

    `Status` must be `Valid`. The same publisher is what electron-updater
    checks before applying an in-app update.

=== "Linux"

    Linux packages are not OS-code-signed. Trust is established by the
    checksum, its detached GPG signature, and GitHub provenance (steps
    1–3). Verify all three before running the `.AppImage` or installing the
    `.deb`.

## In-app updates

On macOS and Windows, signed builds can check for, download, and install
updates from within the app (Settings → check for updates). The updater
verifies the download against the sha512 in the feed metadata and, on
Windows, against the code-signing publisher — so an update is only applied
if it matches the same signing identity as the installed build. Linux uses
the verified manual-download path above.

Downstream forks that host their own feed follow the identical steps against
their own signing key and provenance; see
[Packaging and Releases](packaging-and-releases.md#downstream-self-host).
