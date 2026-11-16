# Experimental Tor transport in Minternet
_Last updated November 15, 2026._

**Security status: development-only, not Tor Browser, not independently audited.** Tor Project warns against using normal browsers with Tor as a substitute for Tor Browser. This integration offers network routing, not a verified anonymity browser.

## Implemented on Windows / Linux desktop
- A Tor button opens a separate private tab. If Arti cannot bootstrap and set up its proxy, no website WebView is created for that tab.
- Arti is embedded in the Rust desktop executable, using its real Tor directory client and circuits (not a remote Tor proxy service or shell command).
- Every Tor tab obtains an `isolated_client()` and a distinct random loopback SOCKS5 listener. The SOCKS handler accepts only domain-form CONNECT requests and asks Arti to connect; it does not perform OS DNS resolution for destination hosts.
- Every Tor page WebView is supplied its own Tor proxy URL, separate profile data directory, and incognito mode. Chrome/Firefox extension loading is disabled in that profile.
- Popups that could escape into an ordinary authentication environment are rejected. Context-menu new tabs, background tabs and duplicates inherit the Tor mode. Ordinary new-window actions from Tor are blocked rather than sent over the direct network.
- Tor tabs are marked in the UI, excluded from history/session persistence and cloud synchronization, cannot be pinned, and cannot be toggled back to ordinary private browsing without closing.
- Tor tabs deny camera and microphone requests.

## Not supported / not proven
- The implementation **does not** make Minternet behave exactly like Tor Browser. It does not implement Tor Browser's standardized fingerprinting resistance, first-party isolation guarantees, letterboxing, cryptographic identity model, browser telemetry review or full WebRTC protections.
- `.onion` access and destination DNS behavior must be validated in a real Windows WebView2 and Linux WebKitGTK network environment. Per-WebView proxy settings are not proof of leak freedom.
- Browser-wide helper services, direct native network operations, and cross-process WebRTC or QUIC need network capture tests on multiple OS/browser-engine versions.
- The implementation is desktop-only for Windows/Linux; macOS, iOS and Android do not yet have a supported embedded Arti routing path. Do not expose the Tor button as functional on those platforms.
- Traffic to Tor guards is normally direct by design. The user's ISP can still observe Tor use even when destinations are hidden. Tor does not protect against malicious browser extensions, malware, endpoint compromise, unsafe logins or correlation.
- Circuit isolation by tab is a baseline; Tor Browser's site-context isolation semantics and protection from timing/fingerprinting correlation are not replicated.
- A 50 MB native EXE budget and reproducible builds require validation with embedded Arti and its libraries.

## Ten verification gates before recommending this for sensitive use
1. Compile and package Windows and Linux native applications with all Arti dependencies; verify the resulting binaries and size limits.
2. Bootstrap Arti successfully on an unrestricted network and on a network requiring bridges.
3. Confirm Tor exit addresses and `.onion` connectivity from inside the actual child WebView.
4. Packet-capture DNS: no destination hostname resolved by system DNS during Tor tab navigation.
5. Test browser WebRTC ICE candidates, QUIC, speculative connections, and prefetch behavior for IP leaks.
6. Unplug Tor or kill the listener during a page load; no fallback/direct retry is allowed.
7. Verify separately isolated circuit/exit behavior for concurrent Tor tabs and duplicated/context-opened pages.
8. Compare cookies, storage, cache, downloads, authentication windows and extension exposure with normal/private profiles, including browser crash/restart.
9. Run Tor Project fingerprinting and browser privacy diagnostics; document every remaining difference from Tor Browser.
10. Repeat on supported Windows/WebView2 and Linux/WebKitGTK versions, test long-lived connections, and commission an independent security audit.

Automated source assertions in `tests/tor-integration.test.cjs` run in the full JavaScript test suite and ten repeated CI regression cycles; Rust unit tests are separate development checks. They are development regression checks only. They do **not** satisfy the real network/security gates above.

## Additional hardening (November 15, round 2)
- Chromium has implicit proxy bypass rules for localhost and link-local destinations. The Windows Tor WebView now passes both an explicit SOCKS5 proxy and the `<-loopback>` bypass subtraction, and the Tor transport rejects local/IP-literal destinations. These settings need a real WebView2 network-capture test; source inspection alone cannot establish enforcement.
- Each Minternet process and Tor tab has a randomly scoped WebView profile directory. On Tor tab close, the listener and active sessions are signaled to stop and the app attempts to delete that profile. OS file locks or a crash can prevent deletion; this is not an anti-forensic promise.
- Tor-only document-start restrictions aim to disable WebRTC peer creation and selected sensitive APIs. These are best-effort mitigations; they do not replace Tor Browser's engine-level fingerprint defenses.
