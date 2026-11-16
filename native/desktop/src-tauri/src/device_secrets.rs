//! Optional Windows-user-scoped unlock secrets. This never stores passwords in
//! app JSON, localStorage, or a repository. User must explicitly opt in; the
//! default keeps the master-password prompt. The Windows Credential Manager
//! protects generic credentials with the signed-in Windows user's credentials.
//! Anyone with full access to that Windows account can unlock these records.
use zeroize::Zeroize;

fn target(kind:&str)->Result<&'static str,String>{
    match kind{
        "vault"=>Ok("Minternet:BrowserVaultAutoUnlock:v1"),
        "bookmarks"=>Ok("Minternet:SecretBookmarksAutoUnlock:v1"),
        _=>Err("Unsupported credential area".into()),
    }
}

#[cfg(windows)]
pub fn write(kind:&str,secret:&str)->Result<(),String>{
    use windows::core::PWSTR;
    use windows::Win32::Security::Credentials::{
        CREDENTIALW,CRED_TYPE_GENERIC,CRED_PERSIST_LOCAL_MACHINE,CredWriteW
    };
    if secret.is_empty()||secret.len()>1024{return Err("Invalid unlock secret".into());}
    let name=target(kind)?;
    let mut wide=name.encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
    let mut identity="Minternet".encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
    let mut payload=secret.as_bytes().to_vec();
    let mut record=CREDENTIALW::default();
    record.Type=CRED_TYPE_GENERIC;
    record.Persist=CRED_PERSIST_LOCAL_MACHINE;
    record.TargetName=PWSTR(wide.as_mut_ptr());
    record.UserName=PWSTR(identity.as_mut_ptr());
    record.CredentialBlob=payload.as_mut_ptr();
    record.CredentialBlobSize=payload.len() as u32;
    let result=unsafe{CredWriteW(&record,0)}
        .map_err(|_|"Windows Credential Manager could not store the unlock key".to_string());
    payload.zeroize();
    result
}

#[cfg(windows)]
pub fn read(kind:&str)->Result<Option<String>,String>{
    use std::{ffi::c_void,ptr};
    use windows::core::PCWSTR;
    use windows::Win32::Security::Credentials::{
        CREDENTIALW,CRED_TYPE_GENERIC,CredReadW,CredFree
    };
    let name=target(kind)?;
    let wide=name.encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
    let mut record:*mut CREDENTIALW=ptr::null_mut();
    if unsafe{CredReadW(PCWSTR(wide.as_ptr()),CRED_TYPE_GENERIC,0,&mut record)}.is_err(){
        return Ok(None);
    }
    if record.is_null(){return Ok(None);}
    let result=unsafe{
        let details=&*record;
        let size=details.CredentialBlobSize as usize;
        if size==0||size>1024||details.CredentialBlob.is_null(){
            Err("Device unlock credential was invalid".to_string())
        }else{
            std::str::from_utf8(std::slice::from_raw_parts(details.CredentialBlob,size))
                .map(|value|Some(value.to_owned()))
                .map_err(|_|"Device unlock credential was invalid".to_string())
        }
    };
    unsafe{CredFree(record.cast::<c_void>())};
    result
}

#[cfg(windows)]
pub fn remove(kind:&str)->Result<(),String>{
    use windows::core::PCWSTR;
    use windows::Win32::Security::Credentials::{
        CRED_TYPE_GENERIC,CredDeleteW
    };
    let wide=target(kind)?.encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
    // Deleting an absent credential is harmless; caller changes the policy to
    // locked regardless of whether the opt-in existed on this machine.
    let _=unsafe{CredDeleteW(PCWSTR(wide.as_ptr()),CRED_TYPE_GENERIC,0)};
    Ok(())
}
#[cfg(not(windows))]
pub fn write(_kind:&str,_secret:&str)->Result<(),String>{
    Err("Persistent unlock requires Windows Credential Manager".into())
}
#[cfg(not(windows))]
pub fn read(_kind:&str)->Result<Option<String>,String>{Ok(None)}
#[cfg(not(windows))]
pub fn remove(_kind:&str)->Result<(),String>{Ok(())}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn only_named_unlock_secrets_are_allowed(){
        assert!(target("vault").is_ok());
        assert!(target("bookmarks").is_ok());
        assert!(target("http://some.website").is_err());
    }
}
