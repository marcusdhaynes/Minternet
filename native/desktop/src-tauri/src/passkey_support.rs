//! Windows passkey capability and OS-owned management.
//! Never store, export or sync WebAuthn private keys through Minternet's
//! password vault. Site WebAuthn calls belong to the browser engine, not JS
//! injection into untrusted origins.
use serde_json::{json, Value};

// Dynamically discover the OS WebAuthn API. A static link to webauthn.dll
// would prevent Minternet from starting on Windows builds without that DLL.
#[cfg(windows)]
#[link(name="kernel32")]
extern "system" {
    fn LoadLibraryW(name: *const u16) -> *mut std::ffi::c_void;
    fn GetProcAddress(module: *mut std::ffi::c_void, name: *const u8)
        -> *mut std::ffi::c_void;
    fn FreeLibrary(module: *mut std::ffi::c_void) -> i32;
}

#[cfg(windows)]
fn windows_authenticator_probe() -> Option<(u32,bool,i32)> {
    let dll:Vec<u16>="webauthn.dll\0".encode_utf16().collect();
    let module=unsafe{LoadLibraryW(dll.as_ptr())};
    if module.is_null(){return None;}
    let version_address=unsafe{
        GetProcAddress(module,b"WebAuthNGetApiVersionNumber\0".as_ptr())
    };
    let authenticator_address=unsafe{
        GetProcAddress(module,
            b"WebAuthNIsUserVerifyingPlatformAuthenticatorAvailable\0".as_ptr())
    };
    let value=if version_address.is_null() || authenticator_address.is_null(){
        None
    }else{
        // The prototypes match Win32 WebAuthNGetApiVersionNumber (DWORD)
        // and WebAuthNIsUserVerifyingPlatformAuthenticatorAvailable (HRESULT,
        // BOOL*). No website-controlled arguments cross this boundary.
        let version:unsafe extern "system" fn()->u32=
            unsafe{std::mem::transmute(version_address)};
        let check:unsafe extern "system" fn(*mut i32)->i32=
            unsafe{std::mem::transmute(authenticator_address)};
        let mut available=0i32;
        let v=unsafe{version()};
        let result=unsafe{check(&mut available)};
        Some((v,available!=0,result))
    };
    let _=unsafe{FreeLibrary(module)};
    value
}

pub fn status() -> Value {
    #[cfg(windows)]
    {
        let outcome=windows_authenticator_probe();
        let (version,available,result)=outcome.unwrap_or((0,false,-1));
        return json!({
            "platform":"windows",
            "nativeWebAuthnApiVersion":if outcome.is_some(){Some(version)}else{None},
            "windowsHelloAvailable":result==0 && available,
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
            .arg("ms-settings:savedpasskeys")
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
