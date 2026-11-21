# Marmaladeum Media Library — Extracted from Minternet

**Status:** The previous Minternet-native Marmaladeum media library and loopback media server have been removed from the browser core.

Marmaladeum now uses the standalone, cross-browser Marmalade Library WebExtension. The shared extension source and seven-file browser packages live in [MarmaladePlayer/extension](https://github.com/marcusdhaynes/MarmaladePlayer/tree/main/extension).

The former native media_library.rs and media_server.rs modules are no longer compiled. Minternet no longer injects the media-library bridge, starts a Marmaladeum-only local server, stores Marmaladeum folders, or rescans Marmaladeum catalogues on startup.

Minternet's **separate built-in floating audio/video mini-player is unchanged**. Its media picker, FFmpeg codec path, playback and docking/snap features are unrelated to the extracted Marmaladeum library server.

## How to use

Install the independently packaged Chromium-family extension using Minternet's generic extension mechanism **if the current Minternet extension runtime supports the necessary WebExtension APIs**. Alternatively, use Marmaladeum in Chrome, Edge, Firefox or Safari with the appropriate standalone extension. The ordinary website's Add Videos/Folder file chooser works even without an extension, subject to the browser's normal permissions.

A browser extension retains the catalog independently of website storage. Files are not copied, and Firefox/Safari may require reselecting local files after a browser restart. No extension can silently override protected-system-folder restrictions.

## Rollback

The former native implementation is recoverable from the pre-extraction commit:
9ef64162c7a10dc1776e12338f1044d3a834b9c8

The repository's keep-only-main branch policy automatically removes temporary backup branches, so use the immutable historical commit instead. The removed Rust files remain in Git history and can be restored without reintroducing the native server into current builds.

Do not reintroduce native Marmaladeum-only code into Minternet's browser core. Future library improvements belong in the shared browser extension.
