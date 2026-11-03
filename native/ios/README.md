# Minternet iOS / iPadOS

SwiftUI + system WKWebView, not a bundled browser engine. Supports native in-app HTTPS browsing, multiple tabs, search, navigation and separate nonpersistent private WKWebsiteDataStore per private tab. Switching normal ↔ private recreates the webview at the same URL and does not retroactively erase normal mode data.

The GitHub Actions workflow builds a **simulator .app** without Apple signing credentials. A real iPhone/iPad **.ipa** requires Apple provisioning/signing and a distribution workflow; the simulator artifact cannot be sideloaded onto an ordinary iPhone. Production security review, Tor, cross-browser extensions and hardware device testing are incomplete.

SwiftUI front end in [Sources/MinternetApp.swift](Sources/MinternetApp.swift). The complete system-webview engine lives in iOS and is not counted in the under-50MB package.