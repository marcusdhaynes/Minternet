# Minternet security boundaries

**Prototype only. Do not use for sensitive browsing.** Electron / Chromium is not Tor Browser and Minternet has not been independently security-audited.

## Implemented
- Sandboxed external web views, with Node integration disabled and no app IPC exposed to websites.
- HTTPS-first top-level navigation. Explicit `http://` entry requires a warning/confirmation; non-HTTPS redirects remain blocked except within that tab's explicitly approved origin.
- Site camera/microphone, location, notifications and clipboard-read permissions require an origin-specific, in-memory grant. Other privileged APIs default to denial; fullscreen and ordinary clipboard writes are permitted.
- HTTPS-only sandboxed popup windows for conventional authentication; downloads remain blocked pending a secure implementation.
- Per-private-tab, nonpersistent session partitions and a new renderer when switching private state.
- Switching from Normal to Private **does not** erase cookies or data previously created in Normal mode.
- Opt-in unpacked Chromium extension loading; extensions run in normal session only.
- No Supabase connection or transmission of visited pages.

## Not implemented or guaranteed
- Tor transport, circuit isolation, fingerprint protection, DNS/WebRTC leak guarantees.
- Firefox XPI compatibility, full Chrome Web Store API compatibility, extension safety audit.
- Automatic verified security updates, signed installers, phishing protection, native Android/iOS engines, penetration tests.
- End-to-end encrypted sync; only a proposed ciphertext schema is included.
- HTTPS-first navigation does not guarantee all subresources are secure or anonymous; explicit HTTP exceptions are unencrypted.
- Popup/login compatibility, camera/microphone, DRM streaming, passkeys and protected media need integration tests on each OS.
- Manual inactive-tab release may discard unsaved forms, running scripts and page state. Background audio tabs are skipped.
- The GitHub Pages demo is UI-only; browser engine settings apply only to the desktop application.

## Production security checklist
1. Maintain browser-engine security patch SLA and verified signed updates.
2. Independent privacy/security audit of process sandbox, session partitions, extension integration and network stack.
3. Add site permission controls, safe downloads, anti-phishing and network tests.
4. Design full engine strategy for add-on compatibility and mobile.
5. Use vetted Tor Browser architecture; **never** claim that proxying Chromium via Tor is equivalent to Tor Browser.

Never expose Supabase service role keys, signing keys, tokens or user browsing content in GitHub.
