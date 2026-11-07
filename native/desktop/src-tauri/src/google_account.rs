//! Opt-in Google Drive appData sync and separately consented Gmail OTP retrieval.
//! No Google OAuth tokens or plaintext mail are written to disk.
use std::{collections::{HashMap,HashSet},io::{Read,Write},net::TcpListener,process::Command,
          sync::Mutex,time::{Duration,Instant,SystemTime,UNIX_EPOCH}};
use serde_json::{json,Value};
use serde::{Serialize,Deserialize};
use zeroize::Zeroize;
use rand::{rngs::OsRng,RngCore};
use base64::{Engine as _,engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Sha256,Digest};

const DRIVE_SCOPE:&str="https://www.googleapis.com/auth/drive.appdata";
const MAIL_SCOPE:&str="https://www.googleapis.com/auth/gmail.readonly";
const FILE_NAME:&str="minternet-sync.v1.enc";
const MAX_SYNC:usize=6_000_000;
const ACCOUNT_INDEX_KEY:&str="Minternet.GoogleOAuth.AccountIndex.v1";
const ACCOUNT_KEY_PREFIX:&str="Minternet.GoogleOAuth.Refresh.v1:";

// Persist only OAuth refresh credentials, and only in the current OS user's
// protected Credential Manager. Never put access/ID tokens, refresh tokens,
// passwords or the Secret Bookmarks vault in localStorage or a plaintext file.
#[cfg(target_os="windows")]
mod secure_store {
    use windows::core::{PCWSTR,PWSTR};
    use windows::Win32::Security::Credentials::{
        CREDENTIALW,CRED_TYPE_GENERIC,CRED_PERSIST_LOCAL_MACHINE,
        CredWriteW,CredReadW,CredFree
    };
    use zeroize::Zeroize;
    fn wide(text:&str)->Vec<u16>{
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }
    pub fn write(name:&str,value:&[u8])->Result<(),String>{
        if value.is_empty()||value.len()>2300{return Err("Google session exceeds secure storage limit".into());}
        let mut target=wide(name);
        let mut bytes=value.to_vec();
        let credential=CREDENTIALW{
            Type:CRED_TYPE_GENERIC,
            TargetName:PWSTR(target.as_mut_ptr()),
            CredentialBlobSize:bytes.len() as u32,
            CredentialBlob:bytes.as_mut_ptr(),
            Persist:CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };
        let result=unsafe{CredWriteW(&credential,0)}
            .map_err(|_|"Windows Credential Manager could not save Google session".to_string());
        bytes.zeroize();
        result
    }
    pub fn read(name:&str)->Option<Vec<u8>>{
        let target=wide(name);
        let mut credential:*mut CREDENTIALW=std::ptr::null_mut();
        if unsafe{CredReadW(PCWSTR(target.as_ptr()),CRED_TYPE_GENERIC,None,&mut credential)}.is_err(){
            return None;
        }
        if credential.is_null(){return None;}
        let result=unsafe{
            let saved=&*credential;
            let len=saved.CredentialBlobSize as usize;
            let bytes=if len>0&&len<=2300&&!saved.CredentialBlob.is_null(){
                Some(std::slice::from_raw_parts(saved.CredentialBlob,len).to_vec())
            }else{None};
            CredFree(credential.cast());
            bytes
        };
        result
    }
}
#[cfg(not(target_os="windows"))]
mod secure_store {
    pub fn write(_name:&str,_value:&[u8])->Result<(),String>{
        Err("Persistent Google tokens require an OS secure credential store".into())
    }
    pub fn read(_name:&str)->Option<Vec<u8>>{None}
}
#[derive(Serialize,Deserialize)]
struct StoredAccount{email:String,gmail:bool}
#[derive(Serialize,Deserialize)]
struct StoredIndex{version:u8,primary:Option<String>,accounts:Vec<StoredAccount>}
#[derive(Serialize,Deserialize)]
struct StoredRefresh{version:u8,client_id:String,refresh:String}

fn session_key(email:&str,gmail:bool)->String{
    format!("{}:{email}",if gmail{"gmail"}else{"drive"})
}
fn saved_credential_key(email:&str,gmail:bool)->String{
    format!("{ACCOUNT_KEY_PREFIX}{}",session_key(email,gmail))
}
fn valid_email(email:&str)->bool{
    email.len()<=254&&email.contains('@')&&!email.bytes().any(|c|
        c<=32||c==127||c==b'/'||c==b'\\')
}
fn persist_sessions(state:&GoogleState)->Result<(),String>{
    let mut accounts=Vec::new();
    for (key,session) in &state.sessions {
        if session.refresh.is_empty()||!valid_client_id(&session.client_id){continue;}
        let Some((kind,email))=key.split_once(':') else{continue};
        let gmail=kind=="gmail";
        if (!gmail&&kind!="drive")||!valid_email(email)||accounts.len()>=10{continue;}
        let refresh=StoredRefresh{version:1,client_id:session.client_id.clone(),
            refresh:session.refresh.clone()};
        let mut bytes=serde_json::to_vec(&refresh).map_err(|e|e.to_string())?;
        let outcome=secure_store::write(&saved_credential_key(email,gmail),&bytes);
        bytes.zeroize();
        outcome?;
        accounts.push(StoredAccount{email:email.to_owned(),gmail});
    }
    if accounts.is_empty(){return Err("Google did not issue a renewable authorization".into());}
    let index=StoredIndex{version:1,primary:state.primary.clone(),accounts};
    let mut bytes=serde_json::to_vec(&index).map_err(|e|e.to_string())?;
    let result=secure_store::write(ACCOUNT_INDEX_KEY,&bytes);
    bytes.zeroize();
    result
}
pub fn restore()->GoogleState{
    let mut state=GoogleState::default();
    let Some(mut index_bytes)=secure_store::read(ACCOUNT_INDEX_KEY) else{return state};
    let decoded=serde_json::from_slice::<StoredIndex>(&index_bytes);
    index_bytes.zeroize();
    let Ok(index)=decoded else{return state};
    if index.version!=1{return state;}
    for account in index.accounts.into_iter().take(10){
        if !valid_email(&account.email){continue;}
        let Some(mut bytes)=secure_store::read(&saved_credential_key(&account.email,account.gmail))
            else{continue};
        let decoded=serde_json::from_slice::<StoredRefresh>(&bytes);
        bytes.zeroize();
        let Ok(saved)=decoded else{continue};
        if saved.version!=1||!valid_client_id(&saved.client_id)||
           saved.refresh.is_empty()||saved.refresh.len()>2048{continue;}
        state.sessions.insert(session_key(&account.email,account.gmail),Session{
            access:String::new(),refresh:saved.refresh,
            expires:Instant::now(),gmail:account.gmail,client_id:saved.client_id,
            id_token:String::new()
        });
    }
    state.primary=index.primary.filter(|email|
        state.sessions.contains_key(&session_key(email,false)));
    state
}


#[derive(Clone)]
struct Session {
    access:String,
    refresh:String,
    expires:Instant,
    gmail:bool,
    client_id:String,
    id_token:String,
}
#[derive(Default)]
pub struct GoogleState {
    pub primary:Option<String>,
    sessions:HashMap<String,Session>,
    pub sync_enabled:bool,
    seen_codes:HashSet<String>,
}
pub fn status(state:&Mutex<GoogleState>)->Result<Value,String>{
    let b=state.lock().map_err(|e|e.to_string())?;
    let mut mail=b.sessions.iter().filter(|(_,s)|s.gmail)
        .filter_map(|(key,_)|key.strip_prefix("gmail:").map(str::to_owned)).collect::<Vec<_>>();
    mail.sort();
    Ok(json!({"email":b.primary,"connected":b.primary.is_some(),
       "syncEnabled":b.sync_enabled,"gmailAccounts":mail}))
}
fn random(len:usize)->String {
    let mut buf=vec![0u8;len];OsRng.fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}
fn valid_client_id(id:&str)->bool{
    id.len()<240 && id.ends_with(".apps.googleusercontent.com") &&
    id.split_once('-').is_some_and(|(a,b)| !a.is_empty() &&
        a.bytes().all(|c|c.is_ascii_digit()) &&
        b.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'-'||c==b'.'))
}
fn browser_open(uri:&str)->Result<(),String>{
    #[cfg(target_os="windows")]
    let mut cmd={let mut c=Command::new("rundll32.exe");c.arg("url.dll,FileProtocolHandler").arg(uri);c};
    #[cfg(target_os="macos")]
    let mut cmd={let mut c=Command::new("open");c.arg(uri);c};
    #[cfg(not(any(target_os="windows",target_os="macos")))]
    let mut cmd={let mut c=Command::new("xdg-open");c.arg(uri);c};
    cmd.spawn().map_err(|e|format!("Unable to open Google sign-in: {e}"))?;
    Ok(())
}
fn token_reply(url:&str,params:&[(&str,&str)])->Result<Value,String>{
    let response=ureq::post(url).timeout(Duration::from_secs(20))
        .send_form(params).map_err(|e|match e{
            ureq::Error::Status(status,response)=>{
                // Display Google's actual error reason, not an opaque HTTP 400.
                // Never include authorization codes, verifiers or tokens.
                let body=response.into_json::<Value>().unwrap_or(Value::Null);
                let kind=body.get("error").and_then(Value::as_str).unwrap_or("request_rejected");
                let description=body.get("error_description").and_then(Value::as_str)
                    .unwrap_or("Check the Google OAuth client and permission settings.");
                format!("Google authorization rejected ({status}, {}): {}",
                    kind.chars().take(55).collect::<String>(),
                    description.chars().take(180).collect::<String>())
            },
            other=>format!("Could not reach Google's authorization service: {other}")
        })?;
    response.into_json::<Value>().map_err(|_|"Google returned an invalid token response".into())
}
fn userinfo(access:&str)->Result<String,String>{
    let info=ureq::get("https://openidconnect.googleapis.com/v1/userinfo")
        .set("Authorization",&format!("Bearer {access}"))
        .timeout(Duration::from_secs(20)).call().map_err(|e|e.to_string())?
        .into_json::<Value>().map_err(|e|e.to_string())?;
    let email=info.get("email").and_then(Value::as_str).ok_or("Google did not provide an email address")?;
    if info.get("email_verified").and_then(Value::as_bool)!=Some(true){
        return Err("An unverified Google email cannot be used".into());
    }
    Ok(email.to_ascii_lowercase())
}
/// Desktop PKCE authorization uses an OS browser and a random loopback port.
/// The app cannot read Google website cookies, and no password enters Minternet.
pub fn login(state:&Mutex<GoogleState>,client_id:&str,mail:bool)->Result<Value,String>{
    if !valid_client_id(client_id){
        return Err("Enter the Desktop OAuth Client ID registered for Minternet in Google Cloud".into());
    }
    let listener=TcpListener::bind("127.0.0.1:0").map_err(|e|e.to_string())?;
    listener.set_nonblocking(true).map_err(|e|e.to_string())?;
    let port=listener.local_addr().map_err(|e|e.to_string())?.port();
    let redirect=format!("http://127.0.0.1:{port}");
    let verifier=random(48);
    let challenge=URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let nonce=random(24);
    let scopes=if mail {
        format!("openid email {MAIL_SCOPE}")
    } else {
        format!("openid email {DRIVE_SCOPE}")
    };
    // Existing authorization is renewed via the stored refresh credential;
    // do not force a new consent and invalidate older grants on every login.
    let existing_grant=state.lock().ok().is_some_and(|b|
        !mail&&b.sessions.values().any(|s|!s.gmail&&s.client_id==client_id&&!s.refresh.is_empty()));
    let prompt=if existing_grant{"select_account"}else{"consent select_account"};
    let mut authorize=tauri::Url::parse("https://accounts.google.com/o/oauth2/v2/auth")
        .map_err(|e|e.to_string())?;
    authorize.query_pairs_mut()
        .append_pair("client_id",client_id).append_pair("redirect_uri",&redirect)
        .append_pair("response_type","code").append_pair("scope",&scopes)
        .append_pair("state",&nonce).append_pair("code_challenge",&challenge)
        .append_pair("code_challenge_method","S256")
         .append_pair("access_type","offline").append_pair("prompt",prompt);
    browser_open(authorize.as_str())?;
    let started=Instant::now();
    let code=loop {
        if started.elapsed()>Duration::from_secs(120){
            return Err("Google login timed out; sign in again from Settings".into());
        }
        match listener.accept(){
            Ok((mut socket,addr))=>{
                if !addr.ip().is_loopback(){continue;}
                socket.set_read_timeout(Some(Duration::from_secs(3))).ok();
                let mut buf=[0u8;8192];
                let read=socket.read(&mut buf).unwrap_or(0);
                let req=String::from_utf8_lossy(&buf[..read]);
                let url=req.lines().next().and_then(|s|s.split_whitespace().nth(1));
                let parsed=url.and_then(|path|tauri::Url::parse(&format!("{redirect}{path}")).ok());
                let status=parsed.as_ref().and_then(|u|u.query_pairs().find(|(k,_)|k=="state")
                    .map(|(_,v)|v.to_string()));
                let authorized=status.as_deref()==Some(nonce.as_str());
                let value=parsed.as_ref().and_then(|u|u.query_pairs().find(|(k,_)|k=="code")
                    .map(|(_,v)|v.to_string()));
                let failure=parsed.as_ref().and_then(|u|u.query_pairs().find(|(k,_)|k=="error")
                    .map(|(_,v)|v.to_string()));
                let response=if authorized&&value.is_some(){
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n<html><body>Minternet received Google's authorization. Return to Minternet to confirm the account is connected.</body></html>"
                }else{
                    "HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nConnection: close\r\n\r\nGoogle authorization was not completed. Return to Minternet for details."
                };
                let _=socket.write_all(response.as_bytes());
                if authorized {
                    if let Some(reason)=failure {
                        return Err(format!("Google denied authorization: {}",
                            reason.chars().take(110).collect::<String>()));
                    }
                    if let Some(code)=value {break code;}
                }
            },
            Err(e) if e.kind()==std::io::ErrorKind::WouldBlock=>{
                std::thread::sleep(Duration::from_millis(100));
            },
            Err(e)=>return Err(e.to_string())
        }
    };
    let auth=token_reply("https://oauth2.googleapis.com/token",&[
        ("client_id",client_id),("code",&code),("code_verifier",&verifier),
        ("redirect_uri",&redirect),("grant_type","authorization_code")
    ])?;
    let access=auth.get("access_token").and_then(Value::as_str).ok_or("No Google access token")?;
    let refresh=auth.get("refresh_token").and_then(Value::as_str).unwrap_or_default();
    let verified=userinfo(access)?;
    let granted=auth.get("scope").and_then(Value::as_str).unwrap_or("");
    let required=if mail{MAIL_SCOPE}else{DRIVE_SCOPE};
    if !granted.split_whitespace().any(|s|s==required){
        return Err("Google did not grant the requested permission".into());
    }
    let mut b=state.lock().map_err(|e|e.to_string())?;
    let old=b.sessions.get(&session_key(&verified,mail));
    let retained=if refresh.is_empty(){
        old.filter(|s|s.client_id==client_id).map(|s|s.refresh.clone()).unwrap_or_default()
    }else{refresh.to_owned()};
    let token=Session{access:access.to_owned(),refresh:retained,
        expires:Instant::now()+Duration::from_secs(auth.get("expires_in").and_then(Value::as_u64)
            .unwrap_or(3600).saturating_sub(60)),
        gmail:mail,client_id:client_id.to_owned(),
        id_token:auth.get("id_token").and_then(Value::as_str).unwrap_or("").to_owned()};
    if !mail {b.primary=Some(verified.clone());b.sync_enabled=false;}
    b.sessions.insert(session_key(&verified,mail),token);
    // If the OS secure store is unavailable, keep this login only in RAM
    // rather than silently writing a plaintext refresh token to disk.
    let session_saved=persist_sessions(&b).is_ok();
    Ok(json!({"email":verified,"gmail":mail,"authorized":true,
        "sessionSaved":session_saved}))
}
/// Trade a Google ID token for an app-specific, short-lived Supabase Auth JWT.
/// This does not grant access to any other user's records; the database RLS
/// rules authenticate the Supabase user id, never the client-provided email.
pub fn live_auth(state:&Mutex<GoogleState>,project:&str,publishable:&str)
    ->Result<Value,String>{
    let project_url=tauri::Url::parse(project).map_err(|_|"Invalid Minternet backend URL")?;
    let host=project_url.host_str().ok_or("Missing Supabase project hostname")?;
    if project_url.scheme()!="https" || !host.ends_with(".supabase.co") ||
       host.len()<16 || project_url.port().is_some() ||
       project_url.path()!="/" || !project_url.username().is_empty() ||
       project_url.password().is_some(){
        return Err("Only your dedicated HTTPS Supabase project may host Minternet sync".into());
    }
    if !publishable.starts_with("sb_publishable_") || publishable.len()>256 {
        return Err("Enter the Supabase project's publishable client key, never the secret key".into());
    }
    // ID tokens expire too. Renew the Google grant before exchanging the ID
    // token for Supabase auth; never reuse an hour-old token.
    let _=bearer(state,None)?;
    let token={
        let state=state.lock().map_err(|e|e.to_string())?;
        let email=state.primary.as_ref().ok_or("Sign in to Google first")?;
        let session=state.sessions.get(&format!("drive:{email}"))
            .ok_or("Google session missing")?;
        if session.id_token.is_empty(){return Err("Google ID token unavailable: sign in again".into());}
        session.id_token.clone()
    };
    let endpoint=format!("{project}/auth/v1/token?grant_type=id_token");
    let response=ureq::post(&endpoint).set("apikey",publishable)
        .set("Content-Type","application/json")
        .timeout(Duration::from_secs(20))
        .send_json(json!({"provider":"google","id_token":token}))
        .map_err(|_|"Supabase Google provider not configured or token expired".to_string())?
        .into_json::<Value>().map_err(|e|e.to_string())?;
    let user=response["user"]["id"].as_str().ok_or("Missing validated Supabase account ID")?;
    if !user.chars().all(|c|c.is_ascii_hexdigit()||c=='-')||user.len()!=36{
        return Err("Supabase returned invalid user identity".into());
    }
    let access=response["access_token"].as_str().ok_or("Supabase access missing")?;
    let refresh=response["refresh_token"].as_str().ok_or("Supabase refresh missing")?;
    Ok(json!({"accessToken":access,"refreshToken":refresh,
        "userId":user,"expiresIn":response["expires_in"].as_u64().unwrap_or(3600)}))
}

fn bearer(state:&Mutex<GoogleState>,mail_for:Option<&str>)->Result<String,String>{
    let mut b=state.lock().map_err(|e|e.to_string())?;
    let email=match mail_for {Some(name)=>name.to_owned(),None=>b.primary.clone().ok_or("Connect Google in Settings first")?};
    let session_key=format!("{}:{email}",if mail_for.is_some(){"gmail"}else{"drive"});
    let token=b.sessions.get_mut(&session_key).ok_or("Google account is not signed in")?;
    if mail_for.is_some()&&!token.gmail{return Err("Gmail permission is not authorized".into());}
    if Instant::now()<token.expires{return Ok(token.access.clone());}
    if token.refresh.is_empty(){return Err("Google session expired; sign in again".into());}
    let reply=token_reply("https://oauth2.googleapis.com/token",&[
        ("client_id",&token.client_id),("refresh_token",&token.refresh),
        ("grant_type","refresh_token")
    ])?;
    token.access=reply.get("access_token").and_then(Value::as_str)
        .ok_or("Could not refresh Google access")?.to_owned();
    if let Some(new_id)=reply.get("id_token").and_then(Value::as_str){
        token.id_token=new_id.to_owned();
    }
    if let Some(next)=reply.get("refresh_token").and_then(Value::as_str){
        if !next.is_empty(){token.refresh=next.to_owned();}
    }
    token.expires=Instant::now()+Duration::from_secs(
        reply.get("expires_in").and_then(Value::as_u64).unwrap_or(3600).saturating_sub(60));
    let access=token.access.clone();
    // Preserve rotated refresh grants in Windows Credential Manager.
    let _=persist_sessions(&b);
    Ok(access)
}
fn drive_file(access:&str)->Result<Option<String>,String>{
    let mut url=tauri::Url::parse("https://www.googleapis.com/drive/v3/files")
        .map_err(|e|e.to_string())?;
    url.query_pairs_mut().append_pair("spaces","appDataFolder")
        .append_pair("fields","files(id,name),nextPageToken")
        .append_pair("pageSize","100")
        .append_pair("q",&format!("name = '{FILE_NAME}' and trashed = false"));
    let list=ureq::get(url.as_str()).set("Authorization",&format!("Bearer {access}"))
        .timeout(Duration::from_secs(20)).call().map_err(|e|e.to_string())?
        .into_json::<Value>().map_err(|e|e.to_string())?;
    Ok(list["files"].as_array().and_then(|f|f.iter()
        .find(|f|f["name"]==FILE_NAME).and_then(|f|f["id"].as_str()).map(str::to_owned)))
}
pub fn pull(state:&Mutex<GoogleState>)->Result<Value,String>{
    if !state.lock().map_err(|e|e.to_string())?.sync_enabled {
        return Err("Choose Yes to enable Google sync first".into());
    }
    let access=bearer(state,None)?;
    let Some(id)=drive_file(&access)? else {return Ok(json!({"exists":false}));};
    let url=format!("https://www.googleapis.com/drive/v3/files/{id}?alt=media");
    let content=ureq::get(&url).set("Authorization",&format!("Bearer {access}"))
        .timeout(Duration::from_secs(30)).call().map_err(|e|e.to_string())?
        .into_string().map_err(|e|e.to_string())?;
    if content.len()>MAX_SYNC{return Err("Sync data exceeds 6 MB limit".into());}
    Ok(json!({"exists":true,"data":content}))
}
pub fn push(state:&Mutex<GoogleState>,data:&str)->Result<Value,String>{
    if data.len()>MAX_SYNC||data.len()<50{return Err("Invalid encrypted sync payload".into());}
    let parsed:Value=serde_json::from_str(data).map_err(|_|"Sync must be encrypted JSON")?;
    if parsed["version"]!=1 || !parsed["salt"].is_string() ||
       !parsed["iv"].is_string()||!parsed["ciphertext"].is_string(){
        return Err("Refusing to upload unencrypted sync data".into());
    }
    if !state.lock().map_err(|e|e.to_string())?.sync_enabled{
        return Err("Sync has not been enabled".into());
    }
    let access=bearer(state,None)?;
    let id=match drive_file(&access)? {
        Some(id)=>id,
        None=>{
            let metadata=json!({"name":FILE_NAME,"parents":["appDataFolder"],"mimeType":"application/octet-stream"});
            let response=ureq::post("https://www.googleapis.com/drive/v3/files?fields=id")
                .set("Authorization",&format!("Bearer {access}"))
                .set("Content-Type","application/json")
                .timeout(Duration::from_secs(20))
                .send_string(&metadata.to_string()).map_err(|e|e.to_string())?
                .into_json::<Value>().map_err(|e|e.to_string())?;
            response["id"].as_str().ok_or("Google Drive did not return a file ID")?.to_owned()
        }
    };
    let url=format!("https://www.googleapis.com/upload/drive/v3/files/{id}?uploadType=media");
    let result=ureq::request("PATCH",&url).set("Authorization",&format!("Bearer {access}"))
        .set("Content-Type","application/octet-stream")
        .timeout(Duration::from_secs(30)).send_string(data)
        .map_err(|e|e.to_string())?;
    if !(200..300).contains(&result.status()){return Err("Drive sync upload failed".into());}
    Ok(json!({"ok":true}))
}
pub fn set_enabled(state:&Mutex<GoogleState>,enabled:bool)->Result<Value,String>{
    let mut b=state.lock().map_err(|e|e.to_string())?;
    if enabled&&b.primary.is_none(){return Err("Connect Google first".into());}
    b.sync_enabled=enabled;
    Ok(json!({"ok":true,"syncEnabled":enabled}))
}
#[derive(Clone,serde::Serialize)]
#[serde(rename_all="camelCase")]
pub struct CodeResult { pub email:String,pub code:String,pub host:String,pub message_id:String }
fn otp(text:&str)->Option<String>{
    let lower=text.to_ascii_lowercase();
    if !["verification","security code","confirmation","passcode","one-time","login code","sign-in code","otp"]
        .iter().any(|v|lower.contains(v)){return None;}
    let bytes=text.as_bytes();
    for (i,c) in bytes.iter().enumerate(){
        if !c.is_ascii_digit() || (i>0&&bytes[i-1].is_ascii_alphanumeric()){continue;}
        let mut end=i;
        while end<bytes.len()&&bytes[end].is_ascii_digit(){end+=1;}
        if (4..=8).contains(&(end-i)) &&
           (end==bytes.len()||!bytes[end].is_ascii_alphanumeric()){
            return Some(text[i..end].to_owned());
        }
    }
    None
}
fn sender_domain(input:&str)->Option<String>{
    let addr=input.split('<').nth(1).unwrap_or(input).split('>').next()?;
    let host=addr.rsplit('@').next()?.trim().to_ascii_lowercase();
    if !host.contains('.')||host.chars().any(|c|!c.is_ascii_alphanumeric()&&c!='.'&&c!='-'){return None;}
    Some(host)
}
pub fn codes(state:&Mutex<GoogleState>,hosts:&[String])->Result<Vec<CodeResult>,String>{
    if hosts.is_empty(){return Ok(Vec::new());}
    let hosts=hosts.iter().filter_map(|s|tauri::Url::parse(s).ok())
        .filter(|u|u.scheme()=="https").filter_map(|u|u.host_str().map(str::to_owned))
        .collect::<Vec<_>>();
    if hosts.is_empty(){return Ok(Vec::new());}
    let mailboxes={
        let b=state.lock().map_err(|e|e.to_string())?;
        b.sessions.iter().filter(|(_,s)|s.gmail)
            .filter_map(|(key,_)|key.strip_prefix("gmail:").map(str::to_owned)).collect::<Vec<_>>()
    };
    let mut results=Vec::new();
    for email in mailboxes.into_iter().take(6){
        let access=bearer(state,Some(&email))?;
        // Gmail provider-side filter and small cap minimize reading and CPU.
        // includeSpamTrash=true covers Inbox, Spam, and Trash without a broad
        // "all mail" download.
        let mut list=tauri::Url::parse("https://gmail.googleapis.com/gmail/v1/users/me/messages")
            .map_err(|e|e.to_string())?;
        list.query_pairs_mut().append_pair("maxResults","6")
            .append_pair("q","newer_than:5m {verification confirmation otp passcode}")
            .append_pair("includeSpamTrash","true");
        let response=ureq::get(list.as_str()).set("Authorization",&format!("Bearer {access}"))
            .timeout(Duration::from_secs(20)).call().map_err(|e|e.to_string())?
            .into_json::<Value>().map_err(|e|e.to_string())?;
        for msg in response["messages"].as_array().into_iter().flatten().take(6){
            let Some(id)=msg["id"].as_str() else{continue;};
            let mut detail=tauri::Url::parse(&format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}"))
                .map_err(|e|e.to_string())?;
            detail.query_pairs_mut().append_pair("format","metadata")
                .append_pair("metadataHeaders","From").append_pair("metadataHeaders","Subject")
                .append_pair("metadataHeaders","Authentication-Results");
            let response=ureq::get(detail.as_str()).set("Authorization",&format!("Bearer {access}"))
                .timeout(Duration::from_secs(15)).call().map_err(|e|e.to_string())?
                .into_json::<Value>().map_err(|e|e.to_string())?;
            let received=response["internalDate"].as_str().and_then(|v|v.parse::<u128>().ok())
                .unwrap_or(0);
            let now=SystemTime::now().duration_since(UNIX_EPOCH)
                .unwrap_or_default().as_millis();
            // Never replay stale codes, even if the sender still exists in Inbox.
            if received==0||now.saturating_sub(received)>180_000 {continue;}
            let headers=response["payload"]["headers"].as_array().cloned().unwrap_or_default();
            let value=|name:&str|headers.iter().find(|v|v["name"].as_str()
                .is_some_and(|s|s.eq_ignore_ascii_case(name)))
                .and_then(|v|v["value"].as_str()).unwrap_or("").to_owned();
            let Some(sender)=sender_domain(&value("From")) else{continue;};
            // From: is user-controlled. Accept codes only after Gmail reports
            // successful DKIM or SPF for the matching sender domain.
            let verified=value("Authentication-Results").to_ascii_lowercase();
            let dkim=verified.contains("dkim=pass") &&
                verified.contains(&format!("header.d={sender}"));
            let spf=verified.contains("spf=pass") &&
                verified.contains(&format!("smtp.mailfrom={sender}"));
            if !dkim&&!spf {continue;}
            let matched=hosts.iter().find(|host|*host==&sender||
                host.ends_with(&format!(".{sender}")));
            let Some(host)=matched else{continue;};
            let combined=format!("{} {}",value("Subject"),response["snippet"].as_str().unwrap_or(""));
            if let Some(code)=otp(&combined){
                results.push(CodeResult{email:email.clone(),code,host:host.clone(),message_id:id.to_owned()});
            }
        }
    }
    let mut state=state.lock().map_err(|e|e.to_string())?;
    if state.seen_codes.len()>300{state.seen_codes.clear();}
    results.retain(|hit|state.seen_codes.insert(format!("{}:{}",hit.email,hit.message_id)));
    Ok(results)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]fn codes_require_context_and_digits(){
        assert_eq!(otp("Your verification code is 123456."),Some("123456".into()));
        assert_eq!(otp("Invoice 123456"),None);
        assert_eq!(otp("security code 123456789"),None);
        assert_eq!(sender_domain("Support <noreply@example.com>"),Some("example.com".into()));
        assert!(sender_domain("User <bad@localhost>").is_none());
    }
    #[test]fn oauth_id_validation(){
        assert!(valid_client_id("123456-minternet.apps.googleusercontent.com"));
        assert!(!valid_client_id("not-a-client"));
    }
}
