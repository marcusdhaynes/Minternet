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

## Tor session controls
Right-click the Tor toolbar button to open the browser-owned menu. **New Tor Tab** creates a separately isolated Tor tab. **Open Site in Fresh Tor Tab** duplicates the current Tor page into a new private profile with a separate circuit context; it leaves the original tab open. **New Identity** closes all existing Tor tabs and their connections, then opens a fresh Tor tab. Normal tabs are unchanged. New Identity intentionally loses the old Tor tabs' page/session state. A different exit IP is not guaranteed, and this does not match every Tor Browser identity-erasure guarantee.

Arti's **live** `bootstrap_status()` readiness and rough progress are exposed in Tor Connection Status. A past successful bootstrap no longer causes the status to appear ready after Arti reports that it is no longer ready. This is informational and does not prove Tor exit connectivity, DNS safety or identity protection.

## Onion navigation

Bare `.onion` addresses entered inside a Tor tab now default to `http://` over the authenticated onion-service circuit. Explicit `https://...onion` addresses remain unchanged. Ordinary tabs, site redirects and separate ordinary Minternet windows refuse `.onion` destinations to avoid direct DNS requests. HTTP onion URLs can also be duplicated into another isolated Tor tab. Runtime onion-service verification remains necessary.


## Live network and browser tests (November 16, 2026)

Native Minternet has two independent opt-in probes:

1. --minternet-tor-transport-smoke starts the embedded Arti client, rejects direct IP-literal SOCKS CONNECT, requests https://check.torproject.org/api/ip through its real SOCKS5h listener, requires IsTor=true, and separately connects over HTTPS to the verified DuckDuckGo v3 onion service. Failing any part exits nonzero. This validates the transport, not the browser.

2. --minternet-tor-browser-smoke starts the real Windows native UI, creates a Tor tab through trusted chrome commands, navigates its actual WebView2 child to the Tor Project endpoint, and accepts a success marker only if the page reports IsTor=true and the WebRTC peer-connection constructors are unavailable. A failed bootstrap or bad verdict cannot produce a passing marker.

The new GitHub Actions workflow is https://github.com/marcusdhaynes/Minternet/actions/workflows/tor-live-security.yml . Windows checks both probes and the DNS client cache before/after browsing. Linux checks the actual Arti SOCKS transport and v3 onion service. These jobs fail independently when a required test fails; no failures are silently ignored. They run on relevant source pushes, manually, and weekly. The Windows DNS cache check is only one indicator, not packet-capture proof or comprehensive DNS safety.

### Tor Browser parity gate

| Dimension | Current status |
| --- | --- |
| Transport exit verified in real runtime | Live CI probe added; result requires a successful run |
| V3 onion service access | Live Tor transport probe added; actual embedded-browser access remains unverified |
| Direct IPv4 SOCKS refusal and remote hostname resolution | Implemented with runtime test |
| WebRTC browser API exposure | WebView2 runtime test added; broader UDP leaks remain unverified |
| Real packet capture and DNS leaks across browsers and system processes | Not completed |
| Separate storage/circuit per first-party site | Not implemented: current design isolates by tab |
| Standardized fingerprint, letterboxing, fonts, canvas, audio, WebGL and worker policies | Not implemented |
| Full Tor Browser bridges, identity management and hardened Firefox patches | Not implemented |
| Independent professional audit and cross-platform real-device testing | Not completed |

**Security architecture:** A normal WebView2 browser cannot achieve Tor Browser's hardened Gecko protections simply by using an Arti SOCKS proxy and injecting JavaScript. Tor Browser's own maintainers discourage conventional browsers with Tor. Full parity requires actually integrating or launching a verified Tor Browser engine, with its matching first-party isolation, fingerprint defenses and security patch cadence. Until that architecture is implemented and independently tested, Minternet Tor remains experimental. Even official Tor Browser cannot promise perfect anonymity.

Reference: https://support.torproject.org/tor-browser/security/using-tor-with-other-browsers/
