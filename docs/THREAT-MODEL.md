# Minternet security review / threat model

**Status: early native-browser prototypes. No independent production security audit, certification, Tor anonymity verification, or physical-device testing has been completed.**

## Trusted boundary
- Trust is limited to local Minternet browser chrome. Untrusted websites run in operating-system webviews, not the privileged Tauri IPC context.
- Windows: local Tauri \`chrome\` capability is scoped to one webview. Remote HTTPS pages receive no native command privileges. Dangerous permission types are default denied.
- Android: no \`addJavascriptInterface\`; file/content access disabled, strict SSL error cancellation, safe browsing enabled, no mixed content; private mode uses a separate Android process and isolated WebView directory.
- iOS: WKWebView, App Transport Security defaults, and per-private-tab \`WKWebsiteDataStore.nonPersistent()\`.
- Tor/extension code execution is **not** silently enabled. A third-party extension with broad host access or a misconfigured Tor SOCKS proxy could undo privacy protections.

## Security practices implemented
- Origin/protocol restrictions at navigation boundaries, restrictive CSP in local desktop chrome, no arbitrary HTTP downgrade.
- OS-managed web engines receive engine patches from OS/vendor channels instead of Minternet shipping an obsolete embedded Chromium copy.
- App package build gates enforce under 50 MB but *do not* include OS engine runtime disk space.
- Automated build/test pipelines, APK and native installer size checks, Android emulator smoke test, explicit security invariant regression checks.

## Unresolved HIGH-priority items
- Signed, notarized, verified automatic updates across Windows/macOS/Android/iOS/Linux; debug / unsigned packages may be tampered with after distribution.
- Independent manual penetration test of navigation, session storage, popup/login flows, downloads, site permissions, process isolation, updater and installed binary supply chain.
- Real hardware browsing, battery, memory and network leak measurements, crash recovery, OAuth, DRM, media, clipboard, camera and file uploads.
- Browsing fingerprint resistance and Tor identity separation. Tor's developers warn that a normal webview routed through Tor is **not** equivalent to Tor Browser, and may disclose identifying information. We refuse to represent proxy-only Tor as safe anonymity.
- Firefox XPI and full Chrome Web Store compatibility cannot be guaranteed by platform system webviews. WebView2 has an unpacked Chrome extension API on supported runtimes, but it is not equivalent to full Chrome/Firefox extension interoperability.
- Android private mode uses a distinct WebView process/directory, but its cleanup is best effort, not an anti-forensic guarantee; crashes may preserve disk traces and private pages may still be fingerprintable.
- Chromium/WebKit engine behavior depends on installed system version and thus cannot guarantee every public website.

## Automated verification is not audit certification
\`scripts/security_invariants.py\` checks important source invariants in CI. These assertions do not check WebView2/WKWebView bugs, network leaks, race conditions, or whether installed browser binaries are code-signed. A production security audit requires independent experts and runtime/hardware testing. Report suspicious findings to the repository's issue tracker, without including real passwords or browsing data.
