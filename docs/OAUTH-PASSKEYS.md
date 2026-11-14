# OAuth and Passkey Compatibility

## Authentication popup behavior

Normal `target=_blank` HTTP(S) requests open Minternet tabs. Authentication
requests are the exception: a managed, HTTPS-only native WebviewWindow is
created through Tauri's `NewWindowResponse::Create` and
`window_features(features)`, retaining the opener's WebView2 environment.
This preserves the actual `WindowProxy` and `postMessage` relationship that
OAuth and federated sign-in SDKs need. Authentication popup titles display the
navigated HTTPS **host**, not a site-controlled `<title>`.

Safety boundaries: non-HTTPS navigation and downloads are rejected in these
managed popup windows; only browser-managed identity permission requests use
the WebView2 default; all other popup permissions are denied. These popup
windows cannot issue Tauri commands from untrusted website content. Other
new-window requests remain in Minternet tabs. No browser user-agent spoofing,
credential scraping, OAuth token extraction, or cookie copy is performed.

**Important limitation:** Google and some other identity providers can reject
embedded webviews under their OAuth security policies. Preserving an opener
fixes one class of login failures, but cannot override a provider restriction.
A Windows WebView2-based shell is not automatically equivalent to a normal
Edge, Brave or Chrome browser for all authentication providers.

## Passkeys

Open **User Data → Logins → Passkeys** to:
- **Check Compatibility:** query Windows WebAuthn API version and user-verifying
  platform authenticator presence. The DLL is loaded dynamically so older
  Windows installations still start the browser.
- **Manage In Windows:** open Windows Settings → Accounts → Passkeys.
- **Test WebAuthn:** open https://webauthn.io/ in a regular Minternet tab.
  Create a *test-site-only* passkey, sign out and sign in with it again;
  remove any test credential afterwards using the site's account settings
  and your chosen passkey provider.

The browser does not store, export, sync, or impersonate WebAuthn private keys.
The website, browser engine and Windows Hello / OS passkey provider perform the
WebAuthn ceremony. Minternet's encrypted password vault is not a passkey store.
Do **not** implement a JavaScript replacement for `navigator.credentials`
which accepts website-claimed origins or returns synthetic assertions; that
would subvert WebAuthn phishing protections.

## Automated regression coverage

- Rust unit tests: identity popup classification, non-auth link routing, and
  non-storage of passkey private keys.
- Node test: native opener delegation, origin restrictions, User Data Logins
  controls, and CI probe presence.
- Windows GitHub Actions: starts the portable EXE and checks a real WebView2
  `about:blank` child posts a message to its original
  `https://example.com` opener via `window.opener`. Merely opening a tab
  or window is **not** sufficient to pass.
- Windows GitHub Actions: runs `navigator.credentials`,
  `PublicKeyCredential` and user-verifying platform authenticator availability
  checks in a real HTTPS website WebView2, and interrogates native Windows
  WebAuthn. Reports unsupported capabilities rather than claiming compatibility.

The automated WebAuthn readiness probe is **not a successful FIDO2/passkey
registration and authentication**. A functional test requires user consent,
a real site's relying-party challenge/verification server and an authenticator.

## Device acceptance matrix (manual)

| Scenario | Expected result |
| --- | --- |
| Normal `target=_blank` website link | New Minternet tab |
| Google/Microsoft/OIDC popup login | HTTPS-only native sign-in popup; valid opener messaging and callback |
| Sign-in via full-page redirect | Browser retains site session and returns to correct callback |
| Windows Hello registration on webauthn.io | Windows prompts for permitted PIN/biometric verification and the site registers the key |
| Windows Hello authentication | Site verifies signed challenge and completes login |
| USB/NFC security key | Authentic FIDO2 prompt and successful assertion where supported |
| Phone/tablet passkey (hybrid) | Cross-device flow where WebView2 and OS support it |
| Private tab | No sharing of private login session with normal tabs |
| Windows passkey denied by privacy setting | Failure is reported; user can review Windows Passkey Access privacy setting |
| Repeated browser updates and restarts | Ordinary profile cookies remain intact; no account data destroyed |

If a WebView2 platform does not expose working WebAuthn APIs or a provider
disallows embedded OAuth, this matrix is **not passed**. Such a failure
requires a supported native browser engine or the provider's authorized
system-browser / OS-broker flow; a capability indicator or JavaScript shim
alone cannot fix it.

Reference: Microsoft Learn's Windows WebAuthn APIs and WebView2 platform
documentation, Web Authentication specification, and the provider's OAuth
embedded-user-agent policy.
