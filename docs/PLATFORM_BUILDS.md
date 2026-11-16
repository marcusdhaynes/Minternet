# Minternet — Every-Commit Platform Build Contract

Every push to the canonical `main` branch must trigger **all** independent
platform pipelines. A shared Git commit identifies the source used for each
build. Jobs run concurrently as GitHub-hosted runners become available;
they do **not** necessarily finish or become downloadable at the same moment.

| Platform | Workflow | Output on successful job | Delivery / limitation |
|---|---|---|---|
| Web | `pages.yml` | Live GitHub Pages **UI preview**, plus per-commit web artifact | Not a full-featured browser or a standalone installable application |
| Windows | `native-windows.yml` | Portable, versioned Windows EXE and SHA-256 sums | Published GitHub Release only after native startup/update tests pass |
| macOS (Apple Silicon & Intel) | `native-unix.yml` | DMG artifacts | Unsigned development packages; may require signing/notarization |
| Linux | `native-unix.yml` | DEB package artifact | Debian/Ubuntu distribution format; not a universal Linux installer |
| Android | `native-android.yml` | Development APK, with `versionCode` and source-revision version name | **Debug signing only**; durable in-place updates require a persistent protected signing identity |
| iOS / iPhone / iPad | `native-ios.yml` | Simulator ZIP and unsigned physical-device build ZIP | **Neither is an installable iPhone IPA** without Apple signing and provisioning |

The Android emulator workflow also runs on every push. All successful binary
artifacts have their exact source revision in their artifact name or build
metadata. The build archiver attempts to preserve successful builds under
per-run GitHub Release tags, without overwriting old rollback artifacts.

**Important:** These are currently *different platform-specific applications*
(Windows/macOS/Linux Tauri, Android native WebView, iOS Swift/WebKit, and a Web
UI preview). Rebuilding from the same Git revision does not itself prove
feature parity; each platform needs its own implementation and tests.

## Update check vs source commits

`Check for Updates` on Windows compares the **installed compiled version**
to the **newest verified published Windows Release**. Uncompiled commits and
incomplete GitHub Actions runs are never installable updates. An in-app update
must download the verified EXE, preserve the browser profile, replace the EXE
at its current path, relaunch, and roll back if startup confirmation fails.

Do not label an Actions job as a published release while it is queued, running,
cancelled, or failing. Never claim a device build is installable until it is
signed for that platform and actually distributed.

## Release publishing permissions

GitHub Actions can compile and upload Actions artifacts even when creating a
permanent GitHub Release is blocked. Recent release-archive job logs reported
`HTTP 403: Resource not accessible by integration` on release creation.

Inspect repository **Settings → Actions → General → Workflow permissions**,
and verify whether the workflow token can receive **Read and write
permissions**. If repository or account policy prohibits it, an authorized
repository administrator must resolve that policy; do not bypass protections
or place long-lived tokens in source code. Once permitted, rerun the failed
archive job to publish validated artifacts.

Apple Developer signing/provisioning and a consistent protected Android
release-signing key are separate deployment prerequisites.
