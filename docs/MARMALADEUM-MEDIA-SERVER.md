# Marmaladeum Media Server — installable Minternet add-on

**Format:** `Marmaladeum-Media-Server.mext` (a ZIP container with an MV3 `manifest.json`).
The add-on declares the Minternet-only `minternet.nativeMediaServer: true` capability.
It is activated **only while the user-installed Minternet extension is enabled**.

## Install
1. Download `Marmaladeum-Media-Server.mext`.
2. In the **Windows Minternet native desktop app**, open **Extensions → Minternet → Import**.
3. Choose the `.mext` file and **restart Minternet**.
4. Open **Extensions → Marmaladeum Media Server → Add Folder** and choose your local folder.
5. Press **Open Marmaladeum** or open `https://marcusdhaynes.github.io/MarmaladePlayer/` in a normal Minternet tab.
6. Enable **Media Library** in Marmaladeum settings if it was hidden. Your indexed videos should appear. Use **Rescan** after changes.

## Architecture and privacy
An ordinary WebExtension cannot host a native HTTP server or read arbitrary
user filesystem paths persistently. To satisfy the importable-file requirement
without executing untrusted binaries from add-on ZIPs, Minternet includes a native
capability host. The installed `.mext` gates access to the host: when absent or
disabled, Minternet does not start the server or inject its page bridge.

The host stores the paths explicitly chosen in a native folder dialog, performs
recursive scans on the same computer, and streams listed video files over a
token-protected loopback-only HTTP endpoint with Range support. The page bridge
is limited to the Marmaladeum origin and the MarmaladePlayer GitHub Pages path,
and is not injected into private/Tor tabs. No media files are uploaded to any
cloud service.

The native engine also supplies optional folder management under Minternet
Settings, only visible with the add-on installed. In the Extensions panel, the
add-on offers **Add Folder**, **Rescan**, and **Open Marmaladeum**.

## Limitations
- The **extension importer is currently Windows WebView2 only**. The Rust native
  host also targets macOS/Linux but their installation workflows need support.
- This requires a **Minternet EXE built after the native-media capability was
  implemented**; a .mext cannot install a native executable into older browsers.
- Chrome/Firefox/Safari cannot use this Minternet-native capability.
- Unsupported video codecs may still fail playback (no FFmpeg transcoding).
- This is a minimal local Plex-like media source, not Plex's streaming ecosystem,
  automatic matching, user accounts, transcoding, or remote access.
- Actual Windows install, native build, and real video playback **are not yet
  independently verified**. Passing ZIP validation alone does not prove them.
