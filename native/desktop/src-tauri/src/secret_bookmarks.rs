//! Secret Bookmarks are isolated from ordinary localStorage, Sync and Undo.
//! No bookmark URL or true title is stored outside authenticated ciphertext.
//! The user-approved visible labels/folder layout remain available when locked.
use std::{fs,path::PathBuf,time::{Duration,Instant}};
use argon2::{Argon2,Algorithm,Version,Params};
use chacha20poly1305::{XChaCha20Poly1305,XNonce,KeyInit,aead::{Aead,Payload}};
use rand::{rngs::OsRng,RngCore};
use serde::{Serialize,Deserialize};
use serde_json::{Value,json};
use tauri::Manager;
use zeroize::Zeroize;
use sha2::Sha256;
use hmac::{Hmac,Mac};

const MAX_ITEMS:usize=1800;
const MAX_BYTES:usize=1_900_000;
const MAX_DEPTH:usize=12;
const AAD:&[u8]=b"Minternet.SecretBookmarks.v1|XChaCha20Poly1305|Argon2id";
const ITEM_AAD:&[u8]=b"Minternet.SecretBookmarks.Item.v2|XChaCha20Poly1305|Argon2id";
#[derive(Serialize,Deserialize,Clone,PartialEq,Eq)]
#[serde(rename_all="camelCase")]
pub struct PublicItem{
    id:String, parent:Option<String>, kind:String, visible_name:String,
}
#[derive(Serialize,Deserialize,Clone)]
struct SealedEntry {
    salt:[u8;16], nonce:[u8;24], ciphertext:Vec<u8>,
    // Blind index only inside the outer authenticated encrypted vault.
    #[serde(default)] fingerprint:String,
}
#[derive(Serialize,Deserialize,Clone)]
struct Entry{
    id:String,parent:Option<String>,kind:String,visible_name:String,
    #[serde(default,skip_serializing_if="String::is_empty")] true_title:String,
    #[serde(default,skip_serializing_if="Option::is_none")] url:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")] sealed:Option<SealedEntry>,
}
#[derive(Serialize,Deserialize)]
struct SensitiveLink { title:String, url:String }
impl Drop for SensitiveLink {
    fn drop(&mut self){self.title.zeroize();self.url.zeroize();}
}
impl Drop for Entry{fn drop(&mut self){self.true_title.zeroize();if let Some(u)=self.url.as_mut(){u.zeroize();}}}
#[derive(Serialize,Deserialize)]
struct Disk{
    version:u8,salt:[u8;16],nonce:[u8;24],ciphertext:Vec<u8>,
    #[serde(default,skip_serializing_if="Vec::is_empty")] visible:Vec<PublicItem>,
}
#[derive(Default)]
pub struct SecretVault{
    key:Option<[u8;32]>,salt:Option<[u8;16]>,entries:Vec<Entry>,
    failed_attempts:u32, retry_after:Option<Instant>,
}
impl Drop for SecretVault{fn drop(&mut self){self.lock();}}
fn passcode_valid(code:&str)->bool{
    // Characters are counted as Unicode scalars; JSON never interpolates the
    // code into commands/URLs/SQL, so punctuation needs no escaping.
    let len=code.chars().count();
    (1..=16).contains(&len) && !code.contains('\0')
}
fn derive(code:&str,salt:&[u8;16])->Result<[u8;32],String>{
    if !passcode_valid(code){return Err("Secret code must be 1–16 characters".into());}
    let p=Params::new(64*1024,3,1,Some(32)).map_err(|e|e.to_string())?;
    let argon=Argon2::new(Algorithm::Argon2id,Version::V0x13,p);
    let mut key=[0u8;32];
    argon.hash_password_into(code.as_bytes(),salt,&mut key)
        .map_err(|_|"Secret key derivation failed".to_string())?;
    Ok(key)
}
pub fn file(app:&tauri::AppHandle)->Result<PathBuf,String>{
    Ok(app.path().app_data_dir().map_err(|e|e.to_string())?
        .join("secret-bookmarks.v1.enc"))
}
fn load(path:&PathBuf)->Result<Disk,String>{
    let bytes=fs::read(path).map_err(|_|"No Secret Bookmarks vault exists".to_string())?;
    if bytes.len()>MAX_BYTES+500_000{return Err("Secret vault exceeds storage limit".into());}
    let d:Disk=serde_json::from_slice(&bytes).map_err(|_|"Invalid Secret Bookmarks vault".to_string())?;
    if !matches!(d.version,1|2)||d.visible.len()>MAX_ITEMS{return Err("Unsupported secret vault".into());}
    Ok(d)
}
fn visible(entry:&Entry)->PublicItem{
    PublicItem{id:entry.id.clone(),parent:entry.parent.clone(),
        kind:entry.kind.clone(),visible_name:entry.visible_name.clone()}
}
fn visible_json(items:&[Entry])->Vec<PublicItem>{items.iter().map(visible).collect()}
fn url_valid(raw:&str)->bool{
    if raw.len()>4096{return false;}
    let Ok(url)=tauri::Url::parse(raw)else{return false};
    matches!(url.scheme(),"https"|"http") && url.host_str().is_some()
        && url.username().is_empty() && url.password().is_none()
}
fn id()->String{
    let mut bytes=[0u8;16];OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b|format!("{b:02x}")).collect()
}
fn item_aad(id:&str)->Vec<u8>{
    let mut bytes=ITEM_AAD.to_vec();
    bytes.extend_from_slice(id.as_bytes());
    bytes
}
// This key-separated digest is only inside the outer encrypted vault. It
// detects duplicate URLs without keeping the URL available to a folder unlock.
fn blind_fingerprint(index_key:&[u8;32],url:&str)->String{
    let mut mac=<Hmac<Sha256> as Mac>::new_from_slice(index_key)
        .expect("HMAC-SHA256 accepts 32-byte secret keys");
    mac.update(b"Minternet Secret URL equality v2");
    mac.update(url.as_bytes());
    mac.finalize().into_bytes().iter().map(|x|format!("{x:02x}")).collect()
}
fn encrypted_link(id:&str,title:&str,url:&str,code:&str,
    fingerprint:String)->Result<SealedEntry,String>{
    let mut salt=[0u8;16];OsRng.fill_bytes(&mut salt);
    let mut key=derive(code,&salt)?;
    let mut nonce=[0u8;24];OsRng.fill_bytes(&mut nonce);
    let payload=SensitiveLink{title:title.to_owned(),url:url.to_owned()};
    let mut clear=serde_json::to_vec(&payload).map_err(|e|e.to_string())?;
    let cipher=XChaCha20Poly1305::new_from_slice(&key).map_err(|_|"Cipher init failed")?;
    let result=cipher.encrypt(XNonce::from_slice(&nonce),
        Payload{msg:&clear,aad:&item_aad(id)}).map_err(|_|"Bookmark encryption failed".to_string());
    key.zeroize();clear.zeroize();
    Ok(SealedEntry{salt,nonce,ciphertext:result?,fingerprint})
}
fn decrypt_item(id:&str,sealed:&SealedEntry,key:&[u8;32])->Result<SensitiveLink,String>{
    let cipher=XChaCha20Poly1305::new_from_slice(key)
        .map_err(|_|"Cipher init failed")?;
    let mut clear=cipher.decrypt(XNonce::from_slice(&sealed.nonce),
        Payload{msg:&sealed.ciphertext,aad:&item_aad(id)})
        .map_err(|_|"Wrong bookmark code or encrypted entry authentication failed".to_string())?;
    let parsed=serde_json::from_slice::<SensitiveLink>(&clear)
        .map_err(|_|"Encrypted bookmark payload is damaged".to_string());
    clear.zeroize();
    parsed
}

impl SecretVault{
    pub fn unlocked(&self)->bool{self.key.is_some()}
    pub fn lock(&mut self){
        if let Some(mut key)=self.key.take(){key.zeroize();}
        self.entries.clear();
        self.salt=None;
    }
    fn bad_code(&mut self){
        self.failed_attempts=self.failed_attempts.saturating_add(1);
        // Delays accidental/in-app guessing, not offline dictionary attacks.
        let seconds=2u64.pow(self.failed_attempts.min(8));
        self.retry_after=Some(Instant::now()+Duration::from_secs(seconds));
    }
    pub fn status(&self,path:&PathBuf)->Result<Value,String>{
        if !path.exists(){return Ok(json!({"exists":false,"unlocked":false,"items":[],"legacyCount":0}));}
        if !self.unlocked(){
            // Never disclose optional labels or hierarchy from disk or UI
            // while the outer folder is locked.
            return Ok(json!({"exists":true,"unlocked":false,"items":[],"legacyCount":0}));
        }
        Ok(json!({"exists":true,"unlocked":true,
            "items":visible_json(&self.entries),
            "legacyCount":self.entries.iter().filter(|e|e.kind=="link"&&e.sealed.is_none()).count()}))
    }
    pub fn open(&mut self,path:&PathBuf,code:&str,create:bool)->Result<Value,String>{
        if let Some(deadline)=self.retry_after{
            if Instant::now()<deadline{return Err("Too many attempts; try again shortly".into());}
        }
        if create{
            if path.exists(){return Err("Secret vault already exists".into());}
            let mut salt=[0u8;16];OsRng.fill_bytes(&mut salt);
            let key=derive(code,&salt)?;
            self.lock();self.key=Some(key);self.salt=Some(salt);
            if let Err(e)=self.save(path){self.lock();return Err(e);}
            self.failed_attempts=0;self.retry_after=None;
            return self.status(path);
        }
        let disk=load(path)?;
        let mut key=derive(code,&disk.salt)?;
        let cipher=XChaCha20Poly1305::new_from_slice(&key).map_err(|_|"Cipher init failed")?;
        let mut clear=match cipher.decrypt(XNonce::from_slice(&disk.nonce),
            Payload{msg:disk.ciphertext.as_slice(),aad:AAD}){
            Ok(v)=>v,Err(_)=>{key.zeroize();self.lock();self.bad_code();
                return Err("Wrong secret code or vault authentication failed".into());}
        };
        let parsed=serde_json::from_slice::<Vec<Entry>>(&clear);
        clear.zeroize();
        let entries=parsed.map_err(|_|"Secret vault payload invalid".to_string())?;
        if entries.len()>MAX_ITEMS ||
            (disk.version==1 && visible_json(&entries)!=disk.visible) {
            key.zeroize();return Err("Secret vault metadata failed integrity validation".into());
        }
        self.lock();self.key=Some(key);self.salt=Some(disk.salt);self.entries=entries;
        self.failed_attempts=0;self.retry_after=None;
        // Legacy format exposed optional display aliases in a cleartext
        // sidecar. Rewrite immediately under the authenticated folder key,
        // even before the separate entry-code migration is performed.
        if disk.version==1{
            if let Err(error)=self.save(path){self.lock();return Err(error);}
        }
        self.status(path)
    }
    pub fn save(&self,path:&PathBuf)->Result<(),String>{
        let key=self.key.as_ref().ok_or("Unlock Secret Bookmarks first")?;
        let salt=self.salt.ok_or("Missing secret vault salt")?;
        let mut clear=serde_json::to_vec(&self.entries).map_err(|e|e.to_string())?;
        if clear.len()>MAX_BYTES{clear.zeroize();return Err("Secret vault full".into());}
        let mut nonce=[0u8;24];OsRng.fill_bytes(&mut nonce);
        let cipher=XChaCha20Poly1305::new_from_slice(key).map_err(|_|"Cipher init failed")?;
        let encrypted=cipher.encrypt(XNonce::from_slice(&nonce),
            Payload{msg:clear.as_slice(),aad:AAD});
        clear.zeroize();
        // New format never stores even the visible labels unencrypted.
        // Legacy v1 files remain readable and are upgraded on next write.
        let disk=Disk{version:2,salt,nonce,ciphertext:encrypted
            .map_err(|_|"Secret encryption failed".to_string())?,
            visible:Vec::new()};
        let bytes=serde_json::to_vec(&disk).map_err(|e|e.to_string())?;
        if let Some(dir)=path.parent(){fs::create_dir_all(dir).map_err(|e|e.to_string())?;}
        let tmp=path.with_extension("tmp");
        fs::write(&tmp,bytes).map_err(|e|e.to_string())?;
        if fs::rename(&tmp,path).is_err(){
            fs::copy(&tmp,path).map_err(|e|e.to_string())?;
            let _=fs::remove_file(&tmp);
        }
        Ok(())
    }
    pub fn put(&mut self,path:&PathBuf,kind:&str,parent:Option<&str>,
        label:&str,url:Option<&str>,true_title:Option<&str>,entry_code:Option<&str>)
        ->Result<Value,String>{
        if !self.unlocked(){return Err("Unlock Secret Bookmarks first".into());}
        if self.entries.len()>=MAX_ITEMS{return Err("Secret Bookmarks is full".into());}
        if !matches!(kind,"folder"|"link"){return Err("Invalid bookmark type".into());}
        let label=label.chars().take(100).collect::<String>();
        let mut depth=0;
        if let Some(parent)=parent{
            let mut current=Some(parent);
            while let Some(pid)=current{
                let entry=self.entries.iter().find(|entry|entry.id==pid)
                    .ok_or("Parent folder missing")?;
                if entry.kind!="folder"{return Err("Only folders can contain bookmarks".into());}
                depth+=1;if depth>=MAX_DEPTH{return Err("Too many nested secret folders".into());}
                current=entry.parent.as_deref();
            }
        }
        let id=id();
        let mut entry=Entry{
            id:id.clone(),parent:parent.map(str::to_owned),kind:kind.into(),
            visible_name:label,true_title:String::new(),url:None,sealed:None,
        };
        if kind=="link"{
            let target=url.ok_or("Missing website URL")?;
            if !url_valid(target){return Err("Enter a valid HTTP(S) bookmark URL".into());}
            let canonical=tauri::Url::parse(target).map_err(|_|"Invalid website URL")?.to_string();
            let code=entry_code.ok_or("Set a separate code for this Secret Bookmark")?;
            self.ensure_distinct(code)?;
            let fingerprint=blind_fingerprint(self.key.as_ref().ok_or("Folder locked")?,&canonical);
            if self.entries.iter().any(|e|e.sealed.as_ref().is_some_and(|x|x.fingerprint==fingerprint)
                ||e.url.as_deref()==Some(canonical.as_str())){
                return Err("Bookmark already exists in Secret Bookmarks".into());
            }
            entry.sealed=Some(encrypted_link(&id,true_title.unwrap_or(""),&canonical,code,fingerprint)?);
        }
        let new_id=entry.id.clone();
        self.entries.push(entry);
        if let Err(e)=self.save(path){self.entries.pop();return Err(e);}
        Ok(json!({"id":new_id,"items":visible_json(&self.entries)}))
    }
    pub fn delete(&mut self,path:&PathBuf,id:&str)->Result<Value,String>{
        if !self.unlocked(){return Err("Unlock Secret Bookmarks first".into());}
        if !self.entries.iter().any(|e|e.id==id){return Err("Bookmark not found".into());}
        let mut removed=vec![id.to_string()];
        loop{
            let mut added=false;
            for e in &self.entries{
                if e.parent.as_ref().is_some_and(|p|removed.contains(p))
                    && !removed.contains(&e.id){
                    removed.push(e.id.clone());added=true;
                }
            }
            if !added{break;}
        }
        self.entries.retain(|entry|!removed.contains(&entry.id));
        self.save(path)?;
        Ok(json!({"items":visible_json(&self.entries)}))
    }
    /// Return a genuine authenticated-encryption preview without storing
    /// plaintext or returning the key. Preview nonces are independent of those
    /// used on save, so the final ciphertext intentionally differs.
    pub fn preview(&self,title:&str,url:&str,code:&str)->Result<Value,String>{
        if !self.unlocked(){return Err("Unlock Secret Bookmarks first".into());}
        self.ensure_distinct(code)?;
        let mut salt=[0u8;16];OsRng.fill_bytes(&mut salt);
        let mut key=derive(code,&salt)?;
        if title.len()>512||url.len()>4096{return Err("Secret preview too large".into());}
        if !url.is_empty()&&!url_valid(url){return Err("Invalid secret website URL".into());}
        let cipher=XChaCha20Poly1305::new_from_slice(&key)
            .map_err(|_|"Cipher initialization failed")?;
        fn encode_preview(cipher:&XChaCha20Poly1305,plain:&[u8])->Result<String,String>{
            let mut nonce=[0u8;24];OsRng.fill_bytes(&mut nonce);
            let bytes=cipher.encrypt(XNonce::from_slice(&nonce),
                Payload{msg:plain,aad:AAD})
                .map_err(|_|"Encryption preview failed".to_string())?;
            // Ciphertext, not a fake random label. The 128-bit Poly1305 tag
            // is included, and every preview uses a fresh random nonce.
            Ok(bytes.iter().take(28).map(|b|format!("{b:02x}")).collect())
        }
        let name=encode_preview(&cipher,title.as_bytes())?;
        let link=encode_preview(&cipher,url.as_bytes())?;
        key.zeroize();
        Ok(json!({
            "scrambledName":name,"scrambledLink":link,"ephemeral":true
        }))
    }
    fn ensure_distinct(&self,code:&str)->Result<(),String>{
        let salt=self.salt.ok_or("Folder not unlocked")?;
        let mut derived=derive(code,&salt)?;
        let outer=self.key.as_ref().ok_or("Folder not unlocked")?;
        let mut difference=0u8;
        for i in 0..32{difference|=derived[i]^outer[i];}
        derived.zeroize();
        if difference==0{return Err("Bookmark entry code must differ from the folder password".into());}
        Ok(())
    }
    pub fn legacy_count(&self)->usize{
        self.entries.iter().filter(|e|e.kind=="link"&&e.sealed.is_none()).count()
    }
    /// Older Minternet builds protected URLs only with the folder password.
    /// Rewrap them under an independent item code, preserving IDs and folders.
    /// Do not auto-upgrade without a user-supplied, distinct second code.
    pub fn migrate(&mut self,path:&PathBuf,code:&str)->Result<Value,String>{
        if !self.unlocked(){return Err("Unlock Secret Bookmarks first".into());}
        self.ensure_distinct(code)?;
        let mut replacement=self.entries.clone();
        let outer=self.key.as_ref().ok_or("Folder locked")?;
        for entry in replacement.iter_mut().filter(|e|e.kind=="link"&&e.sealed.is_none()){
            let url=entry.url.as_deref().ok_or("Legacy secret URL missing")?;
            let fingerprint=blind_fingerprint(outer,url);
            entry.sealed=Some(encrypted_link(&entry.id,&entry.true_title,url,code,fingerprint)?);
            if let Some(url)=entry.url.as_mut(){url.zeroize();}
            entry.url=None;entry.true_title.zeroize();entry.true_title.clear();
        }
        let old=std::mem::replace(&mut self.entries,replacement);
        if let Err(e)=self.save(path){self.entries=old;return Err(e);}
        // old plaintext is zeroized as the old entries are dropped here.
        drop(old);
        self.status(path)
    }
    /// A successful folder unlock never authorizes access to link contents.
    /// Each entry has its own salt and authentication tag. The same entry code
    /// can authorize a batch, but wrong/different codes fail the entire batch.
    pub fn authorize(&mut self,ids:&[String],code:&str)->Result<Vec<[u8;32]>,String>{
        if !self.unlocked(){return Err("Unlock the Secret Bookmarks folder first".into());}
        if self.retry_after.is_some_and(|deadline|Instant::now()<deadline){
            return Err("Too many incorrect attempts; try again shortly".into());
        }
        if ids.is_empty()||ids.len()>35{return Err("Select 1–35 bookmarks".into());}
        let mut keys:Vec<[u8;32]>=Vec::with_capacity(ids.len());
        for id in ids{
            let entry=self.entries.iter().find(|e|e.id==*id&&e.kind=="link")
                .ok_or("Secret Bookmark not found")?;
            let sealed=entry.sealed.as_ref()
                .ok_or("This older bookmark needs an independent entry code before it can open")?;
            let mut key=derive(code,&sealed.salt)?;
            if decrypt_item(id,sealed,&key).is_err(){
                key.zeroize();
                for value in &mut keys {value.zeroize();}
                self.bad_code();
                return Err("Incorrect bookmark entry code or encrypted data failed authentication".into());
            }
            keys.push(key);
        }
        self.failed_attempts=0;self.retry_after=None;
        Ok(keys)
    }
    pub fn link_with_key(&self,id:&str,key:&[u8;32])->Result<String,String>{
        if !self.unlocked(){return Err("Unlock the Secret Bookmarks folder first".into());}
        let entry=self.entries.iter().find(|e|e.id==id&&e.kind=="link")
            .ok_or("Secret bookmark not found")?;
        let sealed=entry.sealed.as_ref().ok_or("Bookmark still requires migration")?;
        let decrypted=decrypt_item(id,sealed,key)?;
        if !url_valid(&decrypted.url){return Err("Decrypted bookmark URL is invalid".into());}
        Ok(decrypted.url.clone())
    }
    pub fn edit(&mut self,path:&PathBuf,id:&str,label:&str)->Result<Value,String>{
        if !self.unlocked(){return Err("Unlock Secret Bookmarks first".into());}
        let entry=self.entries.iter_mut().find(|entry|entry.id==id)
            .ok_or("Secret bookmark not found")?;
        entry.visible_name=label.chars().take(100).collect();
        self.save(path)?;
        Ok(json!({"items":visible_json(&self.entries)}))
    }
    pub fn move_inside(&mut self,path:&PathBuf,id:&str,parent:Option<&str>)->Result<Value,String>{
        if !self.unlocked(){return Err("Unlock Secret Bookmarks first".into());}
        let idx=self.entries.iter().position(|e|e.id==id).ok_or("Bookmark missing")?;
        if let Some(pid)=parent{
            if pid==id{return Err("Cannot move folder into itself".into());}
            let mut cursor=Some(pid);
            let mut depth=0;
            while let Some(c)=cursor{
                let p=self.entries.iter().find(|e|e.id==c).ok_or("Folder missing")?;
                if p.kind!="folder"{return Err("Destination must be a folder".into());}
                if p.id==id{return Err("Cannot move folder into a descendant".into());}
                depth+=1;if depth>=MAX_DEPTH{return Err("Too many folder levels".into());}
                cursor=p.parent.as_deref();
            }
        }
        self.entries[idx].parent=parent.map(str::to_owned);
        self.save(path)?;
        Ok(json!({"items":visible_json(&self.entries)}))
    }
}
#[cfg(test)]
mod tests{
    use super::*;
    fn temporary()->PathBuf{
        std::env::temp_dir().join(format!("secret-bookmarks-test-{}.enc",id()))
    }
    const FOLDER:&str="~!@#$%^&*()_+あ🪐";
    const ENTRY:&str="<>[]{}!@#$%-_++?";
    #[test]
    fn independent_code_keeps_urls_secret_even_after_folder_unlock(){
        let path=temporary();
        let mut vault=SecretVault::default();
        vault.open(&path,FOLDER,true).unwrap();
        let folder=vault.put(&path,"folder",None,"Public Alias",None,None,None).unwrap();
        let folder_id=folder["id"].as_str().unwrap().to_string();
        // The folder code must NOT be accepted as the second layer's code.
        assert!(vault.put(&path,"link",Some(&folder_id),"Visible",
            Some("https://secret.example/private"),Some("Real Sensitive Title"),Some(FOLDER)).is_err());
        let a=vault.put(&path,"link",Some(&folder_id),"Visible",
            Some("https://secret.example/private"),Some("Real Sensitive Title"),Some(ENTRY)).unwrap();
        let first=a["id"].as_str().unwrap().to_owned();
        let b=vault.put(&path,"link",Some(&folder_id),"Another",
            Some("https://secret.example/other"),Some("Second Secret"),Some(ENTRY)).unwrap();
        let second=b["id"].as_str().unwrap().to_owned();
        assert!(vault.put(&path,"link",Some(&folder_id),"Duplicate",
            Some("https://secret.example/private"),Some("Dup"),Some(ENTRY)).is_err());
        assert_eq!(vault.legacy_count(),0);
        let first_entry=vault.entries.iter().find(|x|x.id==first).unwrap();
        assert!(first_entry.url.is_none());
        assert!(first_entry.true_title.is_empty());
        assert!(first_entry.sealed.is_some());
        // Neither the nested, decrypted outer vault nor raw disk bytes
        // expose the actual title and link.
        let inner=serde_json::to_string(&vault.entries).unwrap();
        let raw=fs::read_to_string(&path).unwrap();
        for data in [&inner,&raw]{
            assert!(!data.contains("secret.example"));
            assert!(!data.contains("Real Sensitive Title"));
        }
        vault.lock();
        assert!(vault.status(&path).unwrap()["items"].as_array().unwrap().is_empty());
        vault.open(&path,FOLDER,false).unwrap();
        assert!(vault.authorize(&[first.clone()],"Wrong Entry Code").is_err());
        vault.retry_after=None;
        let codes=vault.authorize(&[first.clone(),second.clone()],ENTRY).unwrap();
        assert!(vault.link_with_key(&first,&codes[0]).unwrap().ends_with("/private"));
        assert!(vault.link_with_key(&second,&codes[1]).unwrap().ends_with("/other"));
        assert!(vault.link_with_key(&first,&codes[1]).is_err());
        vault.lock();
        let _=fs::remove_file(&path);
    }
    #[test]
    fn legacy_bookmarks_require_explicit_second_code_migration(){
        let path=temporary();
        let mut vault=SecretVault::default();
        vault.open(&path,FOLDER,true).unwrap();
        let entry=Entry{id:id(),parent:None,kind:"link".into(),
            visible_name:"Alias".into(),true_title:"Old Title".into(),
            url:Some("https://legacy.example/private".into()),sealed:None};
        let old_id=entry.id.clone();
        vault.entries.push(entry);
        vault.save(&path).unwrap();
        vault.lock();
        vault.open(&path,FOLDER,false).unwrap();
        assert_eq!(vault.legacy_count(),1);
        assert!(vault.authorize(&[old_id.clone()],ENTRY).is_err());
        assert!(vault.migrate(&path,FOLDER).is_err());
        let outcome=vault.migrate(&path,ENTRY).unwrap();
        assert_eq!(outcome["legacyCount"],0);
        assert!(vault.entries.iter().all(|x|x.url.is_none()&&x.true_title.is_empty()));
        let keys=vault.authorize(&[old_id.clone()],ENTRY).unwrap();
        assert_eq!(vault.link_with_key(&old_id,&keys[0]).unwrap(),"https://legacy.example/private");
        vault.lock();
        let _=fs::remove_file(&path);
    }
    #[test]
    fn unicode_punctuation_is_key_material_not_code_or_path_syntax(){
        assert!(passcode_valid("<>{}[];:|=?!@#$"));
        assert!(passcode_valid("🪐✨?&/#*_+-!"));
        assert!(!passcode_valid(""));
        assert!(!passcode_valid("12345678901234567"));
        let path=temporary();
        let mut vault=SecretVault::default();
        vault.open(&path,r#"<>{}[];:|=?!@#$"#,true).unwrap();
        let a=vault.put(&path,"link",None,"",
            Some("https://example.org/"),Some(""),
            Some("🪐✨?&/#*_+-!")).unwrap();
        let id=a["id"].as_str().unwrap().to_owned();
        let keys=vault.authorize(&[id.clone()],"🪐✨?&/#*_+-!").unwrap();
        assert_eq!(vault.link_with_key(&id,&keys[0]).unwrap(),"https://example.org/");
        let _=fs::remove_file(path);
    }
}