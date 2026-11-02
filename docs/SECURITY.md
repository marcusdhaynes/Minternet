# Minternet security boundaries

**Prototype only. Do not use for sensitive browsing.** Electron / Chromium is not Tor Browser and Minternet has not been independently security-audited.

## Implemented
- Sandboxed external web views, with Node integration disabled and no app IPC exposed to websites.
- HTTPS-only top-level addresses/navigation; requests for site permissions default to denial.
- Browser-initiated popup windows and downloads blocked.
- Per-private-tab, nonpersistent session partitions and a new renderer when switching private state.
- Switching from Normal to Private **does not** erase cookies or data previously created in Normal mode.
- Opt-in unpacked Chromium extension loading; extensions run in normal session only.
- No Supabase connection or transmission of visited pages.

## Not implemented or guaranteed
- Tor transport, circuit isolation, fingerprint protection, DNS/WebRTC leak guarantees.
- Firefox XPI compatibility, full Chrome Web Store API compatibility, extension safety audit.
- Automatic verified security updates, signed installers, phishing protection, native Android/iOS engines, penetration tests.
- End-to-end encrypted sync; only a proposed ciphertext schema is included.
- HTTPS-only top-level navigation does not guarantee all subresources are secure or anonymous.

## Production security checklist
1. Maintain browser-engine security patch SLA and verified signed updates.
2. Independent privacy/security audit of process sandbox, session partitions, extension integration and network stack.
3. Add site permission controls, safe downloads, anti-phishing and network tests.
4. Design full engine strategy for add-on compatibility and mobile.
5. Use vetted Tor Browser architecture; **never** claim that proxying Chromium via Tor is equivalent to Tor Browser.

Never expose Supabase service role keys, signing keys, tokens or user browsing content in GitHub.
