# Minternet: Performance and Dashboard

## Architecture and scope
Desktop Minternet continues to use Rust and Tauri 2, with a shared lightweight HTML/CSS/JavaScript chrome and separate native website WebViews. This update does not migrate the application to Svelte or add a database. Those changes would require a separately tested migration and would not guarantee lower interaction latency.

## Changes in this revision
- Default new-tab mode is Dashboard: the tab is lightweight browser metadata and does not instantiate a website WebView until navigation.
- The existing configured homepage is retained as an optional Website new-tab mode.
- Tabless Dashboard is a command hub with no widgets initially, only an inert dotted CSS background. Grid spacing and snapping preferences are stored in a separate small local record.
- Closing the selected tab returns to Dashboard without activating a suspended page.
- User-entered addresses retain their displayed value while navigation begins. Late load events from the old homepage are ignored.
- Native Find in Page gets a 22 px search row below Bookmark Bar; Ctrl+F is forwarded from website WebViews without a general native IPC bridge.
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

## November 10 compact UI and unrequested download protection
- Find appears in a 22-pixel row, right aligned and without a separate text label.
- Tab row buttons and toolbar actions are aligned; new tabs show the Minternet icon.
- Windows shortcut artwork is enlarged 10% inside the .ico output.
- Balanced/Strict Shield now deny unapproved cross-site popups and about:blank popunders. Some legitimate third-party popup experiences may require a user site exception.
- Windows website downloads require a native Yes/No confirmation with No as the default. Unapproved downloads are canceled before saving. Potentially executable formats are explicitly flagged; PE executables disguised as non-EXE files are removed on completion.
- Native login popups cannot download files. Non-Windows site-initiated downloads fail closed until trusted OS consent UI is implemented.
- Chrome Web Store and Firefox Add-ons can be browsed, but their browser-specific install buttons are not working Minternet installers. Supporting full Chrome/Firefox ecosystems requires a distinct browser engine or additional safe extension hosting architecture.

Windows users can still intentionally open cross-origin links using Ctrl+click. Popup URLs that merely resemble OAuth endpoints on unknown domains no longer bypass the privacy shield; common recognized identity providers and same-origin OAuth handlers retain their related-window support.
