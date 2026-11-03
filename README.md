# Minternet — ultra-lightweight native browsers

Minternet is transitioning away from a bundled Electron/Chromium browser toward small native system-webview applications. Windows uses WebView2; Android uses Android System WebView; macOS and iOS use WKWebView; Linux uses WebKitGTK.

**All installers are prototypes. Package size under 50 MB does not mean total disk usage under 50 MB: the operating system's existing web engine is a separate shared dependency.**

## Native artifacts (GitHub Actions)

| Platform | Latest workflow | Engine | Status |
|---|---|---|---|
| Windows portable EXE | [Portable Windows build](https://github.com/marcusdhaynes/Minternet/actions/workflows/native-windows.yml) | WebView2 | One EXE with embedded frontend; no installer or Program Files writes; in-app navigation smoke test |
| Android APK | [Native Android](https://github.com/marcusdhaynes/Minternet/actions/workflows/native-android.yml) | Android System WebView | APK compiled + size checked, with separate-process private-window implementation; emulator smoke is being validated |
| macOS DMG | [Native macOS/Linux](https://github.com/marcusdhaynes/Minternet/actions/workflows/native-unix.yml) | WKWebView | Bundle compiled + size checked; unsigned |
| Linux DEB | [Native macOS/Linux](https://github.com/marcusdhaynes/Minternet/actions/workflows/native-unix.yml) | WebKitGTK | Bundle compiled + size checked; unsigned |
| iPhone/iPad | [iOS simulator](https://github.com/marcusdhaynes/Minternet/actions/workflows/native-ios.yml) | WKWebView | Simulator app compiled + size checked; physical-device IPA requires Apple signing |

For Windows, download **Minternet-Portable-Windows-x64** from a successful run, extract its single EXE, and run it directly. **Do not run the older Minternet Setup installer.** The portable EXE contains the app code and UI but depends on the operating system's WebView2 runtime, which is normally present on modern Windows; browser profile/cache data is stored by Windows as needed. Open other platform artifacts from successful runs. The packaged native apps are designed to navigate and render websites **inside Minternet** as native top-level webviews; the [GitHub Pages live UI](https://marcusdhaynes.github.io/Minternet/) is only a web companion and must open sites such as Google in a real browser because of iframe policies.

## Browse / build

- [Android Java source](native/android) — compact tabs, address/search, in-app HTTPS navigation, separate-process private Activity using an isolated WebView directory on Android 9+.
- [Windows, macOS, Linux Rust/Tauri 2 source](native/desktop) — multiple child webviews, private views, URL navigation, compact common UI.
- [iOS SwiftUI source](native/ios) — native tabs and ephemeral private WKWebViews; simulator app only so far.
- [Security threat model](docs/THREAT-MODEL.md) — implemented restrictions, unresolved risks and verification boundaries.
- [Source security regression checks](scripts/security_invariants.py) — automated invariants, not a professional audit.

**Navigation:** Top-level pages open in Minternet itself. Sites may still fail because of engine limitations, site restrictions, authentication or unsupported downloads. No browser can guarantee every website and feature works.

## Requested capabilities still not complete

- **Built-in Tor anonymity:** Not provided. Tor's maintainers explicitly warn that sending a normal browser through a Tor SOCKS proxy can leak identifying information. True Tor Browser-like anonymity requires hardened browser-engine and fingerprinting protections, not just a proxy toggle.
- **Full Firefox XPI + Chrome extension compatibility:** Not provided. Standard OS webviews have different extension APIs and cannot run every Firefox and Chrome add-on. WebView2 has limited unpacked Chromium extension capability requiring additional native integration; Firefox XPI is a distinct ecosystem.
- **Security certification:** No independently verified production audit, signed automatic updates, penetration testing, or system-wide leak study has been done.
- **Physical-device cross-platform testing:** Compiler/packaging CI is not hardware testing. Emulator/simulator testing helps but does not prove real-world functionality.
- **Release signing:** Windows/macOS packages are unsigned; Android development APK is debug signed; iOS simulator .app is not a distributable physical-device IPA.

The legacy Electron prototype at the repository root remains for comparison and **does not** meet the strict sub-50 MB footprint because it bundles Chromium.

No redistribution license selected yet.
