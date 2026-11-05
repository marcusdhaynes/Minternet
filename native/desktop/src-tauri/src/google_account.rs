//! Opt-in Google Drive appData sync and separately consented Gmail OTP retrieval.
//! No Google OAuth tokens or plaintext mail are written to disk.
use std::{collections::{HashMap,HashSet},io::{Read,Write},net::TcpListener,process::Command,
          sync::Mutex,time::{Duration,Instant,SystemTime,UNIX_EPOCH}};
use serde_json::{json,Value};
use rand::{rngs::OsRng,RngCore};
use base64::{Engine as _,engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Sha256,Digest};

const DRIVE_SCOPE:&str="https://www.googleapis.com/auth/drive.appdata";
const MAIL_SCOPE:&str="https://www.googleapis.com/auth/gmail.readonly";
const FILE_NAME:&str="minternet-sync.v1.enc";
const MAX_SYNC:usize=6_000_000;

#[derive(Clone)]
struct Session {
    access:String,
    refresh:String,
    expires:Instant,
    gmail:bool,
    client_id:String,
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
        .send_form(params).map_err(|e|format!("Google authorization failed: {e}"))?;
    response.into_json::<Value>().map_err(|e|e.to_string())
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
    let mut authorize=tauri::Url::parse("https://accounts.google.com/o/oauth2/v2/auth")
        .map_err(|e|e.to_string())?;
    authorize.query_pairs_mut()
        .append_pair("client_id",client_id).append_pair("redirect_uri",&redirect)
        .append_pair("response_type","code").append_pair("scope",&scopes)
        .append_pair("state",&nonce).append_pair("code_challenge",&challenge)
        .append_pair("code_challenge_method","S256")
        .append_pair("access_type","offline").append_pair("prompt","consent select_account");
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
                let response=if authorized&&value.is_some(){
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n<html><body>Minternet Google sign-in received. Return to Minternet.</body></html>"
                }else{
                    "HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nConnection: close\r\n\r\nAuthorization was not completed."
                };
                let _=socket.write_all(response.as_bytes());
                if authorized { if let Some(code)=value {break code;} }
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
    let token=Session{access:access.to_owned(),refresh:refresh.to_owned(),
        expires:Instant::now()+Duration::from_secs(auth.get("expires_in").and_then(Value::as_u64)
            .unwrap_or(3600).saturating_sub(60)),
        gmail:mail,client_id:client_id.to_owned()};
    let mut b=state.lock().map_err(|e|e.to_string())?;
    if !mail {b.primary=Some(verified.clone());b.sync_enabled=false;}
    b.sessions.insert(format!("{}:{verified}",if mail{"gmail"}else{"drive"}),token);
    Ok(json!({"email":verified,"gmail":mail,"authorized":true}))
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
    token.expires=Instant::now()+Duration::from_secs(
        reply.get("expires_in").and_then(Value::as_u64).unwrap_or(3600).saturating_sub(60));
    Ok(token.access.clone())
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
    let result=ureq::put(&url).set("Authorization",&format!("Bearer {access}"))
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
        list.query_pairs_mut().append_pair("maxResults","12")
            .append_pair("q","newer_than:1d {verification confirmation otp passcode}")
            .append_pair("includeSpamTrash","true");
        let response=ureq::get(list.as_str()).set("Authorization",&format!("Bearer {access}"))
            .timeout(Duration::from_secs(20)).call().map_err(|e|e.to_string())?
            .into_json::<Value>().map_err(|e|e.to_string())?;
        for msg in response["messages"].as_array().into_iter().flatten().take(12){
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
