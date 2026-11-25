# Minternet Android — Native WebView app

This APK uses Android System WebView rather than bundling Chromium. Websites such as Google open **inside the app** in a top-level WebView, not in Chrome/Firefox or an iframe.

Features: compact tab strip, address/search, back/forward/reload, multiple web tabs, popup-created tabs, HTTPS-only and certificate-error cancellation, Android Safe Browsing, no Javascript bridge exposed to sites, no general file/content access.

**Isolated private window (Android 9+):** The ◈ control launches a dedicated Android process with a separate WebView data directory, then returns to normal browsing when closed. Private cookies and site storage receive best-effort cleanup. This is NOT a guarantee of zero disk traces, forensic erasure, crash cleanup, or network anonymity. It opens a separate window rather than converting the original WebView in place; normal-session data is not retroactively deleted.

**Known limitations:** No Tor, extensions, downloads, file uploads, DRM guarantees, or cross-platform security audit. Long-press a tab to close it. Debug APKs are emulator-only; distribution APKs require the persistent signing configuration below.

GitHub Actions builds the APK and checks its **actual file size** is below 50 MiB. The Android WebView engine itself is already installed as part of the OS and is not counted as Minternet's APK size.

This native Android implementation is deliberately separate from the Tauri multi-webview desktop app because Tauri child webviews are desktop-only.

## Android update signing (distribution)

The public APK workflow now fails closed without an owner-controlled persistent key. Emulator tests continue to use disposable debug signing, which must never be distributed as an update.

To preserve an existing installation, recover the **original private signing key** used for that installation, and compare its SHA-256 certificate fingerprint against `apksigner verify --print-certs original.apk`. An APK contains the public certificate, not the private signing key. A new key cannot sign an in-place update to an APK signed by an unrelated key. If the old ephemeral debug key cannot be recovered, back up the old profile before migrating once to a new signing identity.

Configure repository Actions secrets (never commit the keystore or passwords):
- `MINTERNET_ANDROID_KEYSTORE_B64`: base64 of the original persistent keystore.
- `MINTERNET_ANDROID_STORE_PASSWORD`: keystore password.
- `MINTERNET_ANDROID_KEY_PASSWORD`: key password (same as store password if applicable).

Configure repository Actions variables:
- `MINTERNET_ANDROID_KEY_ALIAS`: signing alias.
- `MINTERNET_ANDROID_CERT_SHA256`: independently recorded SHA-256 certificate fingerprint (hex, colons allowed).

Keep an offline encrypted backup of the keystore. Do not rotate the pinned certificate to bypass an update failure. For a fresh signing identity only after migration is accepted, use Android Studio's Generate Signed Bundle/APK or `keytool -genkeypair -keystore minternet-release.jks -alias minternet -keyalg RSA -keysize 3072 -validity 10000`.

Run Native Minternet Android APK (< 50 MB) from Actions after configuration. The workflow signs the release APK, checks its certificate against the pinned fingerprint, checks its package and versionCode, and archives it. Distribution versionCode is 100000000 + the workflow run number; the application ID remains app.minternet.browser. Re-running the same workflow run keeps its versionCode; a new run increments it. Never distribute emulator or local debug APKs as updates.

The verified APK is also published to the permanent **android-latest** release, which only ever moves forward to a higher versionCode:
https://github.com/marcusdhaynes/Minternet/releases/download/android-latest/Minternet-Android.apk

**Existing installs from the old debug builds:** the ephemeral debug keys are unrecoverable, so a one-time migration is required — see [MIGRATION.md](MIGRATION.md) for the verified root cause and the step-by-step procedure. After that single migration, all updates install in place with data preserved.


## Shared desktop interface on Android

Android bundles the canonical `ui/index.html`, CSS and JavaScript at build time. It no longer needs a separate recreation of desktop tabs, settings, bookmark folders, tab groups, dropdowns or browser-owned chrome context menus. A separate transparent trusted WebView hosts the desktop chrome above the existing native website WebViews. Its message bridge is limited to the bundled HTTPS asset origin and the main frame; websites are not granted the bridge. Android system bars and window controls are host-specific. The legacy native controls remain an emergency fallback if the system WebView does not support the bridge or its renderer fails.

The shared interface does not itself implement every desktop engine capability. Android has native handlers for navigation, tab lifecycle, dashboard, pinning, homepage and tab limit, search engine URL routing, inactive-tab settings and existing Google account setup. The existing desktop frontend supplies local bookmark and group presentation/storage. Desktop-only encrypted vault, extension, Tor, downloads, split-view, amplified audio, secret bookmark and other native commands still require Android implementations. Unsupported commands return explicit errors instead of simulated success; existing Android private-process isolation and signing are unchanged. Link/image context menus use Android hit-test information and the desktop renderer; native editable text selection still uses the Android engine. Full feature parity and Android/iOS visual parity require additional validation and work.
