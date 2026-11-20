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

- **Tor transport (experimental, Windows/Linux desktop):** The Tor button now creates a private tab with an Arti-powered per-tab isolated SOCKS5 proxy and a separate WebView data directory. **This is not Tor Browser-like anonymity.** Fingerprinting, complete network leak resistance, and browser-engine hardening have not been verified; mobile and macOS Tor modes are not implemented. Do not use this experimental mode for sensitive anonymity. See [Tor integration and validation](docs/TOR.md).
- **Full Firefox XPI + Chrome extension compatibility:** Not provided. Standard OS webviews have different extension APIs and cannot run every Firefox and Chrome add-on. WebView2 has limited unpacked Chromium extension capability requiring additional native integration; Firefox XPI is a distinct ecosystem.
- **Security certification:** No independently verified production audit, signed automatic updates, penetration testing, or system-wide leak study has been done.
- **Physical-device cross-platform testing:** Compiler/packaging CI is not hardware testing. Emulator/simulator testing helps but does not prove real-world functionality.
- **Release signing:** Windows/macOS packages are unsigned; Android development APK is debug signed; iOS simulator .app is not a distributable physical-device IPA.

The legacy Electron prototype at the repository root remains for comparison and **does not** meet the strict sub-50 MB footprint because it bundles Chromium.

No redistribution license selected yet.


### Encrypted password vault (native desktop preview)

The native Tauri browser includes a locally encrypted password vault under
**Settings → Passwords**. Create a unique master password (at least 12
characters), add an HTTPS site's username/password, and opt into automatic
filling on that exact origin. Saved credentials are encrypted at rest with
Argon2id-derived keys and ChaCha20-Poly1305 authenticated encryption, with a
fresh random nonce for each write. Normal and private tabs are kept separate:
private tabs never receive autofill. Lock the vault from its manager; restarting
Minternet requires unlocking it again.

Important limitations: This is a **development preview, not a complete
Chrome/Firefox/Brave-equivalent password manager**. There is currently no
automatic credential-capture/"Save password?" prompt, password import/export,
passkey storage, password breach checking, or independent security audit.
Passkey access is separately available under **User Data → Logins → Passkeys**
through the operating system's credential provider (where supported by the
WebView engine). Native Windows Hello capability detection and a real
WebView2 WebAuthn readiness smoke test are provided, but actual passkey
registration/sign-in on each device is not yet certified. See
[OAuth and passkey compatibility](docs/OAUTH-PASSKEYS.md).
Automatic filling may miss dynamically mounted forms or sites using unusual
login controls. The master password is not recoverable; losing it makes saved
credentials inaccessible. Passwords should not be entrusted to this preview
as their only copy. Remote web pages receive no Tauri capabilities, and
credentials are never written to browser chrome localStorage.

## Marmaladeum Media Server — importable Minternet extension

Install **Marmaladeum-Media-Server-v1.1.0.mext** using
**Extensions → Minternet → Import**, then restart a compatible Windows
Minternet EXE. The installed extension activates Minternet's native local
media-server host; an .mext alone cannot supply missing native code to an old
browser version.

**All library changes take place in Marmaladeum**, not browser Settings:
open Marmaladeum inside Minternet, enable its Media Library, create and name
a Movies/TV/Other library, then select **Add Folder** in Marmaladeum. The
Minternet-native folder picker scans the selected folder and its descendants;
saved folder paths and library metadata remain on this device across restarts.

Settings displays **Extensions → Marmaladeum → Media Library**, with read-only
connection/catalog summaries and **Open Marmaladeum**. Every installed extension
gets its own nested settings accordion using the same generic structure.
All videos remain local; the native host serves registered media over
token-protected loopback HTTP Range requests.

Supported installer today: **Windows native WebView2**. Chrome/Firefox files
are not a substitute for Minternet's native folder access. Unsupported codecs
still require decoding or transcoding not provided by this extension.
Actual successful EXE installation and real video playback still require
end-to-end verification.

See [Marmaladeum Media Server details](docs/MARMALADEUM-MEDIA-SERVER.md)
for setup, security and remaining limitations.
