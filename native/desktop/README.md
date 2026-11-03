# Minternet native desktop

Tauri 2 + the operating system web engine, not bundled Chromium. Windows builds use WebView2 runtime with a zero-extra-MB installer bootstrapper and generate an NSIS EXE. Browser tabs display sites as native child webviews **inside** the app, not iframes or Firefox/Chrome. The browser shell is the shared compact `ui/` frontend, with native Rust commands accessible **only** to the local `chrome` webview.

Build: `cd native/desktop && npm install && npm run build`. CI checks the resulting NSIS installer is below **50,000,000 bytes**. Other platforms require additional packaging and testing. On Windows, WebView2 is an existing system component or downloaded separately; its disk size is **not** counted toward Minternet's package.

Private tabs use `WebviewBuilder::incognito`, where supported by the OS. Switching modes recreates the tab; it does not retroactively erase the old normal browsing profile. Tor, full Chrome/Firefox extension support, downloads, website permissions, auto-update signing and audit certification are not finished. External webpages have no Tauri capability or IPC permissions, and only HTTPS top-level navigation is allowed.
