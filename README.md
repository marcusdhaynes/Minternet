# Minternet — Native, lightweight browser

Minternet is transitioning from a bundled Electron/Chromium proof of concept to small native applications that use the browser engines already installed on each operating system. This approach avoids shipping Chromium again, but **does not** make the operating system's browser runtime disappear.

## Download the native builds

- **Android (APK):** [verified build — below 50 MB](https://github.com/marcusdhaynes/Minternet/actions/runs/41562500606) → Artifacts → `minternet-android-debug-apk`. This development-signed APK uses Android System WebView. It navigates to Google and other HTTPS sites **inside** Minternet, in a top-level WebView rather than an iframe. It has not yet been tested on a physical device.
- **Windows (.exe):** [native Tauri/WebView2 installer build and strict <50 MB gate](https://github.com/marcusdhaynes/Minternet/actions/workflows/native-windows.yml). View the latest successful run's Artifacts for `minternet-native-windows-exe`. Source is in [native/desktop](native/desktop/). Until a successful run, don't claim the Windows installer has passed.
- **GitHub Pages:** [web preview](https://marcusdhaynes.github.io/Minternet/) is **not** an installed browser and cannot display Google or other sites that forbid iframe embedding. It is an interface preview with links to open such sites externally.
- **Legacy Electron:** Root `npm start` remains available as a larger prototype for comparison, but its bundled Chromium footprint fails the requested small-installation target.

## Architecture

| Platform | Engine | Engine included in Minternet package? | Browsing |
| --- | --- | --- | --- |
| Windows native | Microsoft Edge WebView2 (Tauri 2) | No | Native child webview inside Minternet |
| Android native | Android System WebView (Java) | No | Native WebView inside Minternet |
| macOS and Linux | Planned native Tauri system webviews | No | Additional builds/testing required |
| iOS | Not yet implemented | N/A | Native WKWebView design required |
| Web | Browser iframe | N/A | Only embeddable third-party sites |

The existing WebView2 runtime and Android System WebView may themselves occupy significant disk space but are typically shared OS components; <50 MB refers to the **Minternet package**, not the total device footprint including the existing engine.

## Security and functional limitations

HTTPS-only top-level navigation, no JavaScript-to-native bridge on Android websites, Tauri ACL restricted to the local `chrome` webview, and no special permission grants to untrusted pages. **Neither native version is independently audited.** Google sign-in, DRM, camera, downloads, advanced web permissions, malicious-site protections, update signing and exhaustive cross-site compatibility need more work.

The Windows native prototype supports incognito child views where supported; switching a normal tab into private mode does not erase the prior normal profile. The Android build explicitly **does not** claim private mode; Android WebView isolation is not implemented. Tor, Firefox XPI extensions and the complete Chrome extension ecosystem are not implemented. A small OS-webview application cannot promise exact compatibility with both Firefox and Chrome.

The [legacy Electron architecture](docs/SECURITY.md) has additional functionality but bundles Chromium. No credentials or Supabase private keys should be committed.

## Developer links

- [Android source](native/android/)
- [Desktop native source](native/desktop/)
- [Android build](.github/workflows/native-android.yml)
- [Windows native build](.github/workflows/native-windows.yml)
- [Web-only preview details](docs/WEB-PREVIEW.md)

No redistribution license selected yet.
