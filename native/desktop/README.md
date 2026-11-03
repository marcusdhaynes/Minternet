# Minternet for Windows — Portable 0.3

**No installer. No Program Files writes. One executable:** `Minternet-Portable-x64.exe`.

The Tauri 2 Windows GUI and the entire local frontend are compiled into the EXE. Run it directly from any writable location. No adjacent application folders or unpacking are required. It uses Microsoft's *existing* Windows WebView2 runtime, so the total operating-system footprint (including WebView2 itself and browser profile/cache files) is **not** under 50MB. Windows with no WebView2 runtime cannot run it without that OS component.

## In-app browsing
The local navigation chrome occupies the full window on a blank tab, then shrinks to a **52-pixel top toolbar** when navigating to a website. Website tabs are independent native WebView2 child views drawn below that bar. External websites are not iframes and do not need permission to be embedded. The local chrome CSP permits only the Tauri IPC origins required for the trusted address bar to invoke native navigation, while remote pages are excluded from the Tauri capabilities.

## Build + smoke
`cd native/desktop && npm install && npm run build` produces `src-tauri/target/release/minternet_native.exe`. The [portable Windows GitHub Actions workflow](../../.github/workflows/native-windows.yml) renames that binary `Minternet-Portable-x64.exe`, copies it to an empty standalone test directory, and launches it with `--minternet-smoke`. The smoke checks whether the local chrome IPC successfully navigates to `https://example.com` and whether the native child webview observes the page title `Example Domain`. This is more meaningful than merely checking the window opened, but it is not hardware testing, exhaustive browsing QA, or a penetration test.

## Limitations
Normal browsing persists cookies/cache under Windows app data; no browser can operate fully without the OS web engine and its runtime dependencies. No Tor anonymity, full Chrome/Firefox add-on support, independent security audit or verified signed auto-updates yet.