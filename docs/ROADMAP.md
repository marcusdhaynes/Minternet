# Minternet roadmap

## Desktop prototype
- [x] Ultra-compact interface; HTTPS-first navigation with explicit HTTP confirmation
- [x] Normal/Private tab recreation with separate session partitions
- [x] Lazy blank tabs, manual inactive-tab memory release, safe site permission prompts
- [x] Sandboxed HTTPS popups for standard website login flows
- [x] Chromium unpacked extension loader (limited support)
- [x] GitHub CI, security checks, unsigned desktop packaging
- [x] Optional Supabase SQL schema, currently unconnected

## Desktop beta
- [ ] Bookmarks, settings, safe downloads, profiles, persistent per-site permission controls
- [ ] Test video streaming, OAuth popups, WebRTC, passkeys, accessibility and hardware support on each platform
- [ ] Memory/RAM/CPU and installer-size benchmarks (baseline versus Chrome/Firefox)
- [ ] Signed auto-updates, repeatable builds and security monitoring
- [ ] Independent security review, integration tests and engine patch policy

## Add-on and engine compatibility
- [ ] Evaluate Gecko/Firefox desktop engine for Firefox extension ecosystem
- [ ] Evaluate Chromium extension APIs separately
- [ ] Design extension sandboxing, content scripts, trust and permissions

## Omni-platform and Tor
- [ ] Android and iOS native engine / platform policy adaptation
- [ ] Tor Project architecture evaluation, fingerprint defenses, DNS/WebRTC, session isolation and circuits
- [ ] Independent audit before anonymity or "highest security" claims

## Sync
- [ ] Client-side E2EE key management, authentication, device pairing
- [ ] Supabase encrypted-only data sync with RLS
- [ ] No sync of private/Tor session data
