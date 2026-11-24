# Minternet Android — one-time signing migration

## Why a migration is needed (root cause, verified)

Every Android build published before 2026-11-24 was a **debug build**
(`gradle :app:assembleDebug`) signed with the Android Debug key that the
GitHub Actions runner generated on that machine. GitHub runners are
disposable, so each build was signed by a **different** debug certificate:

- Build 414 (commit `1e68bcf`): debug cert SHA-256
  `9ed072c3fc0fa098a4378ff7f8b0e7957d4c153200c4ab2357ebacb3eb34ca3f`
- Build 415 (commit `7c40b36`): debug cert SHA-256
  `2fa7fa84dcbc9d232511a9cadd0b74a28b5a2141fe8466b456fafafe76ee1166`

Android requires an update to be signed with the **same** certificate as
the installed app. With a different certificate on every build, Android
refuses the in-place update (`INSTALL_FAILED_UPDATE_INCOMPATIBLE` /
"App not installed"). The version codes (414, 415, …) and the application
ID (`app.minternet.browser`) were never the problem.

The original debug private keys existed only inside those disposable
runners and were never stored anywhere. **They are unrecoverable**, and
an APK contains only the public certificate, not the private key. No
tool can extract a private signing key from a published APK.

Android does **not** permit an in-place update between unrelated signing
certificates. There is no legitimate way around this, and Minternet does
not weaken Android security checks to bypass it. A **one-time migration**
is therefore required for installs made from the old debug builds. After
that single migration, every future update installs in place normally.

## The permanent signing identity

All distribution APKs from the `android-latest` release onward are signed
with one permanent key that is stored only as GitHub Actions secrets
(`MINTERNET_ANDROID_KEYSTORE_B64`, `MINTERNET_ANDROID_STORE_PASSWORD`,
`MINTERNET_ANDROID_KEY_PASSWORD`), with the alias and public certificate
pinned as repository variables (`MINTERNET_ANDROID_KEY_ALIAS`,
`MINTERNET_ANDROID_CERT_SHA256`). The build workflow verifies the APK's
certificate against the pinned fingerprint before publishing and fails
closed if signing is missing or mismatched. Debug signing is never used
for a distributed APK.

- Alias: `minternet`
- Certificate SHA-256:
  `042708c6777ab8bb470df42c01e8f261bb3acea64365908cab6e3c7b3efff9f4`
  (verify with `apksigner verify --print-certs Minternet-Android.apk`)
- Certificate SHA-1: `8007243aaa2ab44ed23c09648944eacd1d7a5a20`

## One-time migration procedure (old debug install → permanent build)

Do these steps **in order**. Do not uninstall anything until step 3.

1. **Sync first.** Open the currently installed Minternet, make sure you
   are signed in, and let Minternet Sync finish uploading (bookmarks,
   settings and other synced data live in the Supabase `app_minternet`
   schema). Anything that syncs will come back after the migration.
2. **Note what does not sync.** Data that exists only inside the old
   app's private storage — for example WebView cookies and site sessions
   that were never synced — cannot be carried across an uninstall:
   the old build sets `android:allowBackup="false"`, its signing key is
   gone, and Android blocks another signature from reading its data.
   Expect to sign back in to websites after migrating. If a site session
   matters, use it or save what you need from it before step 3.
3. **Uninstall the old debug build** (Settings → Apps → Minternet →
   Uninstall). This is the one and only uninstall this migration needs.
4. **Install the permanent APK** from the permanent download link:
   https://github.com/marcusdhaynes/Minternet/releases/download/android-latest/Minternet-Android.apk
5. **Sign back in and let sync restore** your bookmarks and settings.
6. **From now on, updates are normal.** Every later APK from
   `android-latest` (or any per-build archive produced by the same
   workflow) is signed with the same permanent certificate and a higher
   version code, so it installs over the existing app and preserves all
   local data — bookmarks, secret bookmarks, saved logins, settings,
   tabs, history, cookies and sessions — with no further migration.

## Verifying an APK before installing

```sh
apksigner verify --verbose --print-certs Minternet-Android.apk
# Signer #1 certificate SHA-256 digest must equal the pinned fingerprint above.
aapt dump badging Minternet-Android.apk | head -n1
# package: name='app.minternet.browser' versionCode must be higher than the installed build.
sha256sum Minternet-Android.apk   # compare with SHA256SUMS.txt on the release
```
