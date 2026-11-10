# Minternet: Performance and Dashboard

## Architecture and scope
Desktop Minternet continues to use Rust and Tauri 2, with a shared lightweight HTML/CSS/JavaScript chrome and separate native website WebViews. This update does not migrate the application to Svelte or add a database. Those changes would require a separately tested migration and would not guarantee lower interaction latency.

## Changes in this revision
- Default new-tab mode is Dashboard: the tab is lightweight browser metadata and does not instantiate a website WebView until navigation.
- The existing configured homepage is retained as an optional Website new-tab mode.
- Tabless Dashboard is a command hub with no widgets initially, only an inert dotted CSS background. Grid spacing and snapping preferences are stored in a separate small local record.
- Closing the selected tab returns to Dashboard without activating a suspended page.
- User-entered addresses retain their displayed value while navigation begins. Late load events from the old homepage are ignored.
- Native Find in Page gets a 31 px search row below Bookmark Bar; Ctrl+F is forwarded from website WebViews without a general native IPC bridge.
- Bookmarks and encrypted Logins have local search; display names are derived from URLs when none is supplied.
- Chrome tab nodes and group chips are reused using keyed DOM reconciliation to avoid reconstructing the tab bar on every state change.

## Feature and privacy compatibility
Existing tabs, pinned tabs, groups, history, settings, bookmark imports, encrypted vaults, private tabs, downloads, audio, sync, and undo remain in their existing codepaths. No data migration is required for the Dashboard preference; legacy preferences continue to load. The dashboard contains no network calls, timers, third-party fonts, or embedded websites.

## Verification boundaries
- JavaScript files have passed syntax checks; this is not equivalent to runtime or Windows integration testing.
- Automated Node and Rust tests, Windows smoke, live tab-stress testing, and distribution build must pass before a specific EXE is described as verified.
- Measure tab-switch latency (median/p95), cold startup-to-address-focus, first render, CPU and RAM at 1/10/35/100 tabs before claiming any performance number.
- Check password autofill, site popup/video playback, ChatGPT route recovery, secret tab isolation, tab groups, and new-tab focus in real WebView2 sessions.
- Rollback builds are published by a separate per-build GitHub release workflow when a native build completes successfully and the release upload is accepted by GitHub.

Current limitation: Find uses WebView2 page JavaScript window.find as a first pass; this is not a complete native match-count/highlight engine across every platform.
