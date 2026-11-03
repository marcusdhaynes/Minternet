# Minternet Android — Native WebView app

This APK uses Android System WebView rather than bundling Chromium. Websites such as Google open **inside the app** in a top-level WebView, not in Chrome/Firefox or an iframe.

Features: compact tab strip, address/search, back/forward/reload, multiple web tabs, popup-created tabs, HTTPS-only and certificate-error cancellation, Android Safe Browsing, no Javascript bridge exposed to sites, no general file/content access.

**Isolated private window (Android 9+):** The ◈ control launches a dedicated Android process with a separate WebView data directory, then returns to normal browsing when closed. Private cookies and site storage receive best-effort cleanup. This is NOT a guarantee of zero disk traces, forensic erasure, crash cleanup, or network anonymity. It opens a separate window rather than converting the original WebView in place; normal-session data is not retroactively deleted.

**Known limitations:** No Tor, extensions, downloads, file uploads, DRM guarantees, or cross-platform security audit. Long-press a tab to close it. The debug APK is development-signed and not a production release.

GitHub Actions builds the APK and checks its **actual file size** is below 50 MiB. The Android WebView engine itself is already installed as part of the OS and is not counted as Minternet's APK size.

This native Android implementation is deliberately separate from the Tauri multi-webview desktop app because Tauri child webviews are desktop-only.