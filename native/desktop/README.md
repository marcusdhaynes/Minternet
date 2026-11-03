# Minternet for Windows — Portable 0.3

**No installer. No Program Files writes. One executable:** `Minternet-Portable-x64.exe`.

The Tauri 2 Windows GUI and the entire local frontend are compiled into the EXE. Run it directly from any writable location. No adjacent application folders or unpacking are required. It uses Microsoft's *existing* Windows WebView2 runtime, so the total operating-system footprint (including WebView2 itself and browser profile/cache files) is **not** under 50MB. Windows with no WebView2 runtime cannot run it without that OS component.

## In-app browsing
The local navigation chrome occupies the full window on a blank tab, then shrinks to a **52-pixel top toolbar** when navigating to a website. Website tabs are independent native WebView2 child views drawn below that bar. External websites are not iframes and do not need permission to be embedded. The local chrome CSP permits only the Tauri IPC origins required for the trusted address bar to invoke native navigation, while remote pages are excluded from the Tauri capabilities.

## Build + smoke
`cd native/desktop && npm install && npm run build` produces `src-tauri/target/release/minternet_native.exe`. The [portable Windows GitHub Actions workflow](../../.github/workflows/native-windows.yml) renames that binary `Minternet-Portable-x64.exe`, copies it to an empty standalone test directory, and launches it with `--minternet-smoke`. The smoke checks whether the local chrome IPC successfully navigates to `https://example.com` and whether the native child webview observes the page title `Example Domain`. This is more meaningful than merely checking the window opened, but it is not hardware testing, exhaustive browsing QA, or a penetration test.

## Limitations
Normal browsing persists cookies/cache under Windows app data; no browser can operate fully without the OS web engine and its runtime dependencies. No Tor anonymity, full Chrome/Firefox add-on support, independent security audit or verified signed auto-updates yet.

## Turbo responsiveness (0.4 preview)

- Cached layout signature avoids resizing 35 potential website views on every navigation.
- Tab visibility switches operate on only the previous and next view.
- Identical browser-state snapshots are suppressed before the native-to-UI IPC channel.
- Focusing the address/search input on an empty tab warms one browser control **without fetching any web address**; Enter navigates using the already-created control.
- Existing WebView2 caching, persistent normal-session storage, GPU acceleration and process isolation are preserved. Nothing disables TLS, certificate validation, browser safety features or site privacy protections.

These optimizations reduce Minternet's overhead, not the destination site's network latency or JavaScript workload. Automated smoke tests verify real in-app navigation, but do not yet quantify a universal page-load speedup.

- Back/Forward now uses WebView2's native navigation history and back-forward cache where available, preserving page state and avoiding forced reloads. Suspended tabs have an HTTPS navigation fallback.
  On the pinned Tauri version this uses the existing webview's JavaScript History API, not unsupported Rust history methods. The destination site may limit back-forward caching.


## Compact bookmarks and settings (0.5)
- The Settings gear is the rightmost address-row control; toggle the 22px optional Bookmark Bar.
- Star a HTTPS page with ☆ or Ctrl+D. Click the saved star again to remove it; right-click the star to edit it.
- Create nested folders (including unnamed folders), right-click a bar item to edit its name, move it between folders, or set an emoji or image icon.
- Images are converted into small 32×32 PNG thumbnails and kept as data URLs, with no remote icon fetches or arbitrary SVG scripting.
- Bookmarks live in the trusted local Tauri/WebView2 chrome profile under `minternet.bookmark-tree.v1` in localStorage; they are NOT uploaded to Supabase or exposed to untrusted page webviews.
- When Settings/Folder/Manager opens, the local chrome temporarily expands and hides (but does not destroy) the current website view. Closing the panel restores the page immediately.
- Keeping bookmarks stored locally means clearing Minternet's application data may erase them; export/import and optional encrypted synchronization are future work.

## Native bookmark folders & tab groups

- Click a bookmark-bar folder to open a **native OS popup** positioned at the folder's lower-left edge. Nested folders cascade on hover, with platform-native keyboard navigation, screen-edge flipping and dismissal. The website's WebView2 stays on screen and alive behind the popup.
- Right-click the Bookmark Bar to open a context menu with **Tab Groups**. Each group displays an eye on the right; click its row to show/hide its group chip and tabs above.
- The new overlapping-tabs icon beside the + button opens tab group controls. Right-click a tab to add it to a group, move it between groups or ungroup it.
- Click a group chip to collapse/expand its tabs. Hiding a group does not close the tabs; if it contained the active tab, Minternet selects another visible tab or creates a new one.
- Tab group definitions, names, colors and visibility persist locally. Membership is session-only to avoid accidentally applying old tab IDs to unrelated pages after restart.
- Bookmark icons remain emoji or uploaded images on the bar; native popup menu entries show emojis and safe folder labels (image-backed entries use a folder symbol).
- No remote website has access to Minternet's native popup-menu APIs.

## Rapid chrome fixes
- Double-click empty title/tab-bar space to maximize or restore prior window size. Window dragging begins only after actual pointer movement, so the second click is not consumed.
- Group button is at the far left, even when the bookmark bar is hidden.
- Tabs have a stable 71px width; drag to a group chip or a grouped tab to add, beside an ungrouped tab to remove, and to either side of a tab to reorder.
- Bookmark folders/subfolders no longer offer a redundant Bookmark This Page menu action. Context menus use the dark OS window theme when supported, with polished compact fallback styling.
- The Home button and keyboard shortcut label at the address-bar end are removed; Favorites star sits at the right edge.
- Normal and Tor controls are always visibly labeled. **Tor is still only an informational control; Tor routing has not been implemented.**

## Pointer tabs and search settings (v0.6 preview)
- Move a tab onto a group header or another group's tab to join it; move onto an ordinary tab or blank tab-strip area to ungroup. A floating, pointer-tracked tab chip and insertion markers replace HTML5 drag-and-drop, avoiding WebView2's prohibited-drop cursor. Native tabs stay alive during reordering.
- The Minternet M logo is farthest left. Bookmark Bar items are adjacent, the status footer is gone, and only the Tor information icon remains alongside the settings gear. The eye-icon new-private-tab feature remains available.
- Tor itself is not connected or advertised as an anonymizing mode.
- Plain text entered in the address bar or home search is routed inside the native WebView2 to Google by default; ordinary HTTPS websites remain direct website navigations.
- Settings > Default Search Engine supports Google, DuckDuckGo, Bing, Brave Search, Startpage, and Ecosia. The trusted chrome stores this under `minternet.search-engine.v1`. Each navigation includes the selected enum, validated by the native backend against its allowlist.
- The GitHub Pages UI companion is not a fully functional browser and never auto-launches restricted websites in the OS browser.

## Pinned tabs and tabless home (v0.7.0)
- Pinned tabs are compact, first in the tab strip, and kept out of tab groups. Pin/Unpin are in the tab's new dark-purple custom context menu, with Duplicate and Close options. Dragging across the pinned/ordinary tab boundary pins/unpins without destroying the WebView.
- Only non-private, valid HTTPS pinned URLs persist locally as `pinned-tabs.v1.json` in Minternet's application data directory. Normal browsing tabs and private tab URLs are not restored. This file is separate from the EXE, as are normal WebView2 profile data.
- A browser session can have zero tabs. Closing the last tab never creates a replacement. Navigating on the unselected homepage creates a new tab only at that moment.
- Hiding or collapsing the selected group chooses another pinned tab first, then any visible ordinary tab; if none exists, it deselects rather than synthesizing a tab. All group tabs remain alive.
- The Manage Bookmarks button is right-docked. Toolbar's 22px tab row / 30px address row now give equal 3px vertical clearance above and below the 24px address bar.
- Tab/group menus use custom glass styling; folder menus keep Windows-native cascading behavior. Opening a custom tab menu temporarily covers the website without reloading or closing its WebView.
