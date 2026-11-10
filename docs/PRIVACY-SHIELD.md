# Minternet Privacy Shield — Initial Implementation and Limitations

## Shipped in this revision

- A toolbar shield menu with three profiles: Off, Balanced and Strict.
- A global enabled switch plus a per-website exception, persisted in Minternet's own native app-data directory.
- Browser-native popup denials for configured domains and known ad-popunder hosts.
- Balanced: blocks unsolicited cross-site popup tabs even when a click initiates them, as well as known ad-network windows. Strict additionally blocks blank popup windows that can be navigated to third-party ads. Validated OAuth popup windows and per-site exceptions remain available.
- Document-start defenses against selected advertising/tracking \`fetch\`, XHR and \`sendBeacon\` requests, plus a limited list of named ad/tracking hosts.
- Cosmetic hiding of identifiable advertisement slots, tracking frames, newsletter annoyances and (if explicitly enabled) subscription overlays.
- Experimental YouTube Skip Ad button detection and ad-slot hiding.
- Custom hostname blocklist, site allowlist, transparent first-party permission behavior, and a count of *native* popup denials.
- All normal website data, sessions and permissions are still managed by their original WebView2 profiles. No new external service or user browsing-data upload is introduced by Privacy Shield.

## Important constraints

**This is not a complete ad-blocking extension or a promise of ad-free video.** Document-start JavaScript and CSS filtering can be evaded and cannot consistently block advertising embedded in first-party video streams. It does not implement the complete EasyList/uBlock filter syntax, scriptlets, CNAME resolution, native engine-level URL interception, dynamic maintained filter-list subscriptions, per-element picker, anti-adblock defenses or request-type-specific third-party rules. Modern YouTube delivery changes frequently. Sites can also interfere with or replace page-context JavaScript APIs, unlike isolated content scripts.

Subscription-overlay removal hides only recognized *local visual overlays* on pages the user can already access; it does not fetch, decrypt, authenticate into, or unlock subscriber-only content. Some publisher layouts and authentication workflows can break under aggressive visual removal, so this option defaults off.

For production-grade blocking comparable to uBlock Origin, prioritize:

1. A portable filter engine implementing EasyList, EasyPrivacy and trusted malware/tracker lists with audited update and rollback validation (including correct exception rules).
2. Native WebView2 **WebResourceRequested** interception for appropriate resource types on Windows, with equivalent WKWebView/WebKitGTK request-blocking support for macOS/Linux; measure resource-response overhead on large websites.
3. Cosmetic CSS and scriptlet matching with origin-isolated injection, user-controlled element hiding and filter exception handling.
4. Browser-aware YouTube ad handling; avoid blindly altering the user's media playback or circumventing paid access.
5. Verified compatibility regressions across Google login, GitHub, ChatGPT, YouTube playback, banking, download flows, split tabs and private browsing.

## Recovery for blank content

The layout refresh reasserts visible WebView2 bounds after a completed page load and focus event without discarding the current route or the renderer. For \`chatgpt.com\`, a separate guarded check after 20 seconds retries the same URL at most once in the current tab session only when its DOM remains textless and noninteractive. This is a recovery mechanism, not proof of the root cause of the pictured blank frame. If it persists, record WebView2 runtime version, GPU information, page-load status, and the circumstances of minimization / focus / tab activation.

## Sources and design guidance

- [uBlock Origin](https://github.com/gorhill/uBlock) and its [Firefox addon information](https://addons.mozilla.org/firefox/addon/ublock-origin/)
- [Brave blocking policy](https://github.com/brave/brave-browser/wiki/Blocking-goals-and-policy)
- [WebView2 request interception](https://learn.microsoft.com/microsoft-edge/webview2/how-to/webresourcerequested)
- [Tauri WebviewBuilder](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html)

## Example popup regression (November 2026)

On `ww8.123moviesfree.net`, clicking the player can launch ad pages as user-activated `window.open` calls or start with `about:blank` and redirect. The WebView2 `NewWindowRequested` path must apply filtering **before** auth popup construction and before forwarding new-tab events; page JavaScript interception alone is insufficient. This rule uses host-based suspicion for blank-window requests and an origin policy for unrelated cross-site windows in Balanced mode. It intentionally does not intercept ordinary in-tab video playback. Some legitimate third-party windows may require adding the site to the allowlist.

## Video playback regression fix (November 2026)

The early popup blocker replaced `window.open` in the page's JavaScript and returned `null` for filtered popups. Some video player scripts treat the missing return value as a fatal error and never start playback. We removed this page-level override: the native WebView2 `NewWindowRequested` handler now owns popup blocking so rejected popups get the native dummy `WindowProxy` behavior without loading a separate ad window.

The default Balanced profile continues to block built-in ad-network popup hosts and configured user block rules, but it no longer rejects arbitrary third-party popup URLs merely because they cross origins. Some legitimate third-party video players need those windows. Strict still blocks third-party popup windows. Blank popups from designated high-risk sources may remain blocked natively, preserving the safe proxy behavior. If video playback still fails on a specific provider, collect the popup URL and whether its player must open a separate window before changing site-wide policy.

Native and JavaScript policies must not each deny the same popup separately. Test with an in-page video player and a native popup advertisement on Windows WebView2.
