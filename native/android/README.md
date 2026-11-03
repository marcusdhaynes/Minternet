# Minternet Android — Native WebView app

This APK uses Android System WebView rather than bundling Chromium. Websites such as Google open **inside the app** in a top-level WebView, not in Chrome/Firefox or an iframe.

Features: compact tab strip, address/search, back/forward/reload, multiple web tabs, popup-created tabs, HTTPS-only and certificate-error cancellation, Android Safe Browsing, no Javascript bridge exposed to sites, no general file/content access.

**Known limitations:** private tabs are deliberately unavailable because ordinary Android WebViews share storage. No Tor, extensions, downloads, file uploads, DRM guarantees, or cross-platform security audit. Long-press a tab to close it. The debug APK is development-signed and not a production release.

GitHub Actions builds the APK and checks its **actual file size** is below 50 MiB. The Android WebView engine itself is already installed as part of the OS and is not counted as Minternet's APK size.

This native Android implementation is deliberately separate from the Tauri multi-webview desktop app because Tauri child webviews are desktop-only.