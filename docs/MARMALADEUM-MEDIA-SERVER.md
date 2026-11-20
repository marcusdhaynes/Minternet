# Marmaladeum Media Server — Minternet .mext extension

**Current format:** `Marmaladeum-Media-Server-v1.1.0.mext` (Manifest V3 ZIP).
**Minternet integration:** `minternet.nativeMediaServer = true`. The extension
is user-installed; without an enabled extension the native local server does not
start and Minternet does not inject its catalog bridge.

## Install

1. Update to a Minternet Windows desktop EXE that includes the native media
   server integration. An old EXE cannot execute native code from an .mext ZIP.
2. In Minternet open **Extensions → Minternet → Import** and select the
   **.mext** file. Remove or disable the older Marmaladeum Media Server
   add-on first if present.
3. **Restart Minternet** so the extension capability can activate.
4. Open [Marmaladeum](https://marcusdhaynes.github.io/MarmaladePlayer/)
   in a normal (not private or Tor) Minternet tab.
5. In **Marmaladeum → Settings → Video → Media Library**, enable the library
   if it is hidden. Use **Create Library** to name a Movies/TV/Other library.
6. Use **Add Folder in Marmaladeum**, select the directory once in Minternet's
   native picker, and view its video cards in Marmaladeum. Use **Edit Library**,
   **Scan Library Files**, item menus and **Delete Library** in Marmaladeum.

## Settings hierarchy

Minternet has a reusable, dynamically generated accordion hierarchy:

```text
Settings
  Extensions
    Marmaladeum
      Media Library
        Version / Enabled
        Indexed-video, library, folder totals
        Saved libraries (read-only)
        Open Marmaladeum
        Refresh Status
    Other Extension Name
      Extension-specific settings or status
```

The Minternet extension panel is installation/activation/navigation only.
There are **no competing Add Folder or Rescan Library controls** inside
Minternet settings. Extension settings use manifest `settingsGroup` and
`settingsSection` fields, with generic fallbacks for future add-ons.

## Why the native host is necessary

Minternet uses Windows WebView2 rather than Chrome or Firefox and web pages
cannot permanently enumerate arbitrary filesystem folders without permission
re-prompts. The .mext file declares a capability that activates a
**Minternet-native extension host** using an operating-system directory picker.
The native host saves folder paths, named libraries, catalog metadata,
watched/favorite/playlist changes and other edits in local app data
(`media-library.v1.json`) independently of Marmaladeum's IndexedDB cache.
This gives one-way ownership: **Marmaladeum edits → extension host saves →
Marmaladeum reads from the saved host catalog**. A missing external drive
retains its registered folder and last-known library cards. Files remain local.

The host serves approved video files over a loopback-only HTTP server with
byte-range support, a random per-process secret and an origin-gated page bridge.
Native folder operations report an explicit success, cancellation or error,
rather than guessing a folder-count increment.

## Limitations and verification

- The **.mext importer is Windows WebView2 only** at present. The native Rust
  host could be brought to macOS/Linux, but the native add-on installation flow
  is not yet supported on those systems; Android/iOS require separate adapters.
- The current server does **not transcode** unsupported formats and is not a
  complete Plex replacement: no DLNA, remote-user accounts, remote access or
  server-side metadata agents.
- A successful GitHub commit or valid ZIP is **not proof** of a working EXE,
  real folder picker, or playable MP4. Check the Windows Actions build, run the
  actual installed EXE and verify Create Library → Add Folder →
  indexed cards → Play → restart → cards remain.
- Minternet only injects the bridge into its allowlisted Marmaladeum origins.
  The GitHub Pages path is a convenience, not a separate security origin from
  other projects on the same GitHub Pages hostname; a dedicated domain gives
  stronger origin isolation.
