# Minternet Privacy Shield (Popup Blocker Removed)

## Popup windows

The popup blocker has been completely removed. On Windows, every website-created WebView2 `window.open` request gets a real related popup window, including cross-site requests and `about:blank` starters. There is no popup hostname blacklist, origin restriction, click-gesture requirement, popup count limit, or popup deduplication.

Android allows JavaScript-created windows without a gesture test. iOS now returns a related WKWebView created using WebKit's original configuration, preserving opener context.

## Separate security protections

Popup blocking and file-download protection are different features. Main-window downloads still require explicit user approval on Windows; website-created popup windows cannot automatically save files. Unsafe non-browser URL schemes and browser permission restrictions remain independently enforced.

## Optional content filters

The Privacy Shield's optional ad/tracker request filtering, domain-based *ordinary navigation* rules, and cosmetic controls remain available. These are not popup-window blockers. Neither Balanced nor Strict can suppress the creation of popup windows.

## Trade-offs

Websites may now open promotional, nuisance, advertising, or multiple windows during video playback and browsing. This behavior is intentionally allowed. Native browser errors or invalid URL schemes can still prevent a specific window from loading, but there is no popup-blocker policy.

## Rendering recovery

Minternet's existing compositor recovery continues restoring WebView2 bounds and visibility after window restoration and other lifecycle changes without reloading the tab. It does not guarantee that all white-screen causes have been eliminated.
