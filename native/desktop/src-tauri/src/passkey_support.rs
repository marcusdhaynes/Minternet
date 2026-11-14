//! Windows passkey capability and OS-owned management.
//! Never store, export or sync WebAuthn private keys through Minternet's
//! password vault. Site WebAuthn calls belong to the browser engine, not JS
//! injection into untrusted origins.
use serde_json::{json, Value};

#[cfg(windows)]
#[link(name="webauthn")]
extern "system" {
    fn WebAuthNGetApiVersionNumber() -> u32;
    fn WebAuthNIsUserVerifyingPlatformAuthenticatorAvailable(
        available: *mut i32,
    ) -> i32;
}

pub fn status() -> Value {
    #[cfg(windows)]
    {
        let version=unsafe{WebAuthNGetApiVersionNumber()};
        let mut available=0i32;
        let result=unsafe{
            WebAuthNIsUserVerifyingPlatformAuthenticatorAvailable(&mut available)
        };
        return json!({
            "platform":"windows",
            "nativeWebAuthnApiVersion":version,
            "windowsHelloAvailable":result==0 && available!=0,
            "nativeProbeSucceeded":result==0,
            "probeHresult":format!("0x{:08X}",result as u32),
            // This is OS capability, not evidence that WebView2 supports
            // website navigator.credentials.create/get on the current device.
            "websiteWebAuthn":"Requires live site registration and sign-in test",
            "keyStorage":"Windows Hello or a user-selected OS passkey provider",
            "keysInMinternetVault":false
        });
    }
    #[cfg(not(windows))]
    json!({
        "platform":std::env::consts::OS,
        "nativeWebAuthnApiVersion":null,
        "windowsHelloAvailable":false,
        "nativeProbeSucceeded":false,
        "websiteWebAuthn":"Requires a platform browser WebAuthn test",
        "keyStorage":"Operating system / passkey provider",
        "keysInMinternetVault":false
    })
}

pub fn open_settings() -> Result<Value,String> {
    #[cfg(windows)]
    {
        // OS Settings owns credential enumeration/deletion; Minternet must
        // never impersonate an authenticator or ask for private-key material.
        std::process::Command::new("explorer.exe")
            .arg("ms-settings:accounts-passkeys")
            .spawn()
            .map_err(|e|format!("Could not open Windows Passkeys settings: {e}"))?;
        return Ok(json!({"ok":true}));
    }
    #[cfg(not(windows))]
    Err("Open your operating system's passkey settings to manage passkeys".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn reports_no_credential_export_path(){
        let info=status();
        assert_eq!(info["keysInMinternetVault"],false);
        assert!(info.get("websiteWebAuthn").is_some());
    }
}
