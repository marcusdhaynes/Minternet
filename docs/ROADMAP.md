# Minternet roadmap

## Desktop prototype
- [x] Compact Firefox-inspired multi-tab interface and HTTPS navigation
- [x] Normal/Private tab recreation with separate session partitions
- [x] Chromium unpacked extension loader (limited support)
- [x] GitHub CI, security checks, unsigned desktop packaging
- [x] Optional Supabase SQL schema, currently unconnected

## Desktop beta
- [ ] Bookmarks, settings, downloads, profile management, per-site permissions
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
