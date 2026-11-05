# Google Account Sync and Verification Codes

Minternet's Google integration is **opt-in**, never reads Google browser cookies, and does not connect automatically to Gmail accounts that happen to be logged into a website.

## Required Google Cloud configuration

1. In Google Cloud Console, create/configure an OAuth consent screen and enable the **Google Drive API**. Enable the **Gmail API** only if Gmail verification-code reading is offered.
2. Create an **OAuth client ID** of type **Desktop app**, add authorized test users while in testing status, and configure the app's publishing/verification requirements.
3. In Minternet **Settings → Google Account** (first option), paste that public Desktop OAuth Client ID and select **Continue to Google**. The user signs into Google using their external system browser, with PKCE and a localhost callback.
4. After authenticating, choose **No, Keep Local** to avoid sync, or **Yes, Sync**, then enter a shared sync encryption passphrase of at least 12 characters. Use the same Google account, OAuth application, and passphrase on each desktop device.
5. To detect Gmail sign-in codes, explicitly click **Connect Gmail For Verification Codes** for each account. Google requests separate read-only Gmail permission. The Gmail client scope is restricted and may require production verification.

No client secret belongs in this public source repository or the app. A missing/invalid client ID leaves sign-in unavailable rather than faking an account connection.

## Security and storage

- Normal HTTPS tabs, group definitions/membership, bookmark folders, and encrypted password/payment vault backups are encrypted locally using PBKDF2-SHA256 and AES-256-GCM before upload.
- Google Drive stores the encrypted blob in its appDataFolder, not a user-visible public file.
- Passwords and payment card numbers remain inside their original Argon2id/ChaCha20-Poly1305 encrypted vault; the sync envelope adds another layer. Cards never store CVV.
- **Private tabs and private-only groups, Tor/.onion URLs, and data entered into private tabs are not exported.** The native sync import only creates normal, dormant HTTPS tabs.
- A locally existing vault is never overwritten. If both vaults use the same master key and the local vault is unlocked, new entries can merge; conflicting entries remain local. Distinct master-key vaults require manual reconciliation.
- The encryption passphrase and OAuth tokens exist in memory for the active app session only. Sign-in/unlock are necessary again after restart. This intentionally avoids writing Google refresh tokens or sync passphrases to an insecure file.
- Drive updates are polled on a timer (about 45 seconds); this is **not instant cross-device realtime**. Concurrent edits suspend automatic overwrites rather than silently discarding data.
- Deletions and divergent vault updates are not yet fully reconciled. Do not treat this version as a guaranteed lossless multi-device backup or a production password-manager replacement.
- The minimal Gmail code checker polls at most six **explicitly connected** Gmail accounts, including Inbox, Spam, and Trash, for recent messages. It requires authenticated sender-domain checks, a recent 4–8-digit verification code and a matching normal HTTPS open-tab host. It does not submit forms. Native clipboard copying is triggered on a newly matched code, and a badge next to the bookmark star lets the user copy manually. Background tab fill applies to existing loaded WebViews only; suspended tabs must load before their fields exist.
- Gmail API `gmail.readonly` is a restricted OAuth permission. Public distribution may require verification and a security/privacy assessment under Google's policies.

## Platform coverage

The implementation in this revision is integrated with Minternet's native **Windows/macOS/Linux Tauri** application. Android and iOS currently have separate native UIs and are **not yet connected to the common Google sync code**. They require native platform OAuth client IDs and supported Android/iOS authentication redirect flows before universal cross-platform sync can be claimed.

This is a functional desktop integration gated on the developer's Google OAuth setup. It is **not** a claim of universal, zero-overhead, real-time syncing.
