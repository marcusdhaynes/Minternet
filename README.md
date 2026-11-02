# Minternet

**Minternet** is a compact desktop browser prototype inspired by Firefox's layout density. It currently uses Electron / Chromium; it is **not** a Firefox fork, Tor Browser replacement, production security product, or full omni-platform release.

## Start

Requires Node.js 24+.

```sh
npm install
npm start
```

Run `npm run check && npm test`. Unsigned desktop previews are available via the manual GitHub Actions packaging workflow.

## Current capabilities

- Compact tabs, search/address bar, navigation, dark browser chrome and keyboard shortcuts.
- Per-tab **Normal / Private** switching: recreates the tab with a fresh session, preserving only the URL. It does **not** erase data that normal mode previously stored.
- HTTPS-only navigation, sandboxed web contents, default-denied permissions, blocked downloads and popup windows.
- Experimental opt-in **unpacked Chromium extension** loading; many APIs and Firefox XPI addons are unsupported.
- Tor button explains limits and opens Tor Browser's official site. **Tor is not embedded**.
- Optional Supabase encrypted-sync **schema only**. Client-side encryption, authentication, and sync are not yet connected.

## Planned

See `docs/ROADMAP.md` for Firefox-compatible engine options, integrated Tor research, Android/iOS builds, extension compatibility, independent security testing, and signed updates.

See `docs/SECURITY.md` for the exact threat-model limitations. Do **not** use this prototype for sensitive or anonymous browsing.

## Repository visibility

This source repository can be public, but do not commit credentials or private keys. Supabase service-role/secret keys must never ship in client applications.

## License

No redistribution license selected.
