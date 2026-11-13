# Updates — uniform auto-update spec (all Marcus apps)

Spec version: 1.0 · 2026-11-13 · Repo: marcusdhaynes/Minternet

## Flow
1. The app checks `https://api.github.com/repos/marcusdhaynes/Minternet/releases/latest`.
2. The release `tag_name` (semver `vX.Y.Z`) is compared with the app's current
   version (see "Current version" below). A strictly newer tag is an update.
3. When an update exists:
   - A thin ribbon appears at the TOP CENTER of the app — very low height, just
     enough for short text: `Update available · vX.Y.Z`. It is styled neutrally
     (theme-aware / subtle) so it does not clash with the app's own theme.
     (This ribbon supersedes the earlier full-width banner with Update/Later
     buttons from the first mockup.)
   - The ribbon itself is the button: clicking it executes the update.
   - The × on its right side dismisses it PERMANENTLY for that version — it
     does not come back on the next launch. Dismissal is persisted per
     version in localStorage under the key `updates:dismissed:<version>`.
     Full update information remains available in Settings.
   - The ribbon has NO Update/Later buttons: the ribbon itself is the
     button, and clicking it executes the update.
   - Settings (bottom, see below) shows the full details and an Update button.
4. On Update: download the release asset, close the current version,
   install/swap, and reopen. Web apps simply refresh to the new deployed
   version; Android APKs still require the user's install tap.

## Placement
- Ribbon: top center, identical in every app, shown only when a newer
  release exists and that version was not dismissed.
- Updates section: permanently at the very BOTTOM of the app's Settings —
  current version, available version, What's New (release notes),
  "Check for updates" button, and an Update button. It stays there until
  the app is updated.

## Future-proof rule (standing rule, Marcus, Nov 13, 2026)
- If the app ALREADY has a Settings menu: the Updates section is implemented
  LIVE now, at the bottom of Settings, and the ribbon is wired at the app root.
- If the app has NO Settings menu anywhere: the update code is added
  PREPARED / DORMANT only — the shared Updates component/module and this spec
  live in the repo but are NOT imported or displayed anywhere, and there is
  no visible UI change. When a Settings menu is added later, the Updates
  section is then implemented at the bottom of that Settings menu.
- Honest fallback: if a future Settings menu is built in a way that does not
  automatically pick up the Updates block, Marcus will ask Muse to set it
  up — the app is not expected to magically know in every possible case.
- This repo's category: A — LIVE (Settings menu exists)

## Release format
- Proper GitHub Releases — commits alone are not enough.
- Tag: semver `vX.Y.Z`. Title: the same version. Body: release notes
  (shown as "What's New"). Assets: the installable/deployable files for
  the app's platforms attached to the release.

## Current version
- package.json: version 0.1.0.
