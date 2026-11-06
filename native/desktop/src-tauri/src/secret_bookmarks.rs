//! Secret Bookmarks are isolated from ordinary localStorage, Sync and Undo.
//! No bookmark URL or true title is stored outside authenticated ciphertext.
//! The user-approved visible labels/folder layout remain available when locked.
use std::{fs,io::{Seek,SeekFrom,Write},path::PathBuf,time::{Duration,Instant}};
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
    bind_visible_name:bool, legacy_code_required:bool,
}
#[derive(Serialize,Deserialize,Clone)]
struct SealedEntry {
    salt:[u8;16], nonce:[u8;24], ciphertext:Vec<u8>,
    // Blind index only inside the outer authenticated encrypted vault.
    #[serde(default)] fingerprint:String,
    // 0: older independent entry-code format; 1: folder-derived key format.
    #[serde(default)] version:u8,
}
#[derive(Serialize,Deserialize,Clone)]
struct Entry{
    id:String,parent:Option<String>,kind:String,visible_name:String,
    #[serde(default)] bind_visible_name:bool,
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
        kind:entry.kind.clone(),visible_name:entry.visible_name.clone(),
        bind_visible_name:entry.bind_visible_name,
        legacy_code_required:entry.kind=="link" && entry.sealed.as_ref().is_some_and(|s|s.version==0)}
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
// Outer Argon2id password key is expanded into an independent, per-item AEAD key.
// The optional visible name is additional authenticated key *context*, not a
// second secret: knowing a visible label does not add password entropy.
fn item_key(master:&[u8;32],salt:&[u8;16],visible_name:&str,bind:bool)->[u8;32]{
    let mut mac=<Hmac<Sha256> as Mac>::new_from_slice(master)
        .expect("HMAC-SHA256 accepts 32-byte keys");
    mac.update(b"Minternet Secret Bookmark Item Key v3");
    mac.update(salt);
    mac.update(&[u8::from(bind)]);
    if bind{
        mac.update(&(visible_name.len() as u32).to_be_bytes());
        mac.update(visible_name.as_bytes());
    }
    let bytes=mac.finalize().into_bytes();
    let mut key=[0u8;32];key.copy_from_slice(&bytes);key
}
fn blind_fingerprint(master:&[u8;32],url:&str)->String{
    let mut mac=<Hmac<Sha256> as Mac>::new_from_slice(master)
        .expect("HMAC-SHA256 accepts 32-byte keys");
    mac.update(b"Minternet Secret URL equality v4");
    mac.update(url.as_bytes());
    mac.finalize().into_bytes().iter().map(|x|format!("{x:02x}")).collect()
}
fn encrypted_link(id:&str,title:&str,url:&str,master:&[u8;32],
    visible_name:&str,bind:bool)->Result<SealedEntry,String>{
    let mut salt=[0u8;16];OsRng.fill_bytes(&mut salt);
    let mut key=item_key(master,&salt,visible_name,bind);
    let mut nonce=[0u8;24];OsRng.fill_bytes(&mut nonce);
    let payload=SensitiveLink{title:title.to_owned(),url:url.to_owned()};
    let mut clear=serde_json::to_vec(&payload).map_err(|e|e.to_string())?;
    let cipher=XChaCha20Poly1305::new_from_slice(&key).map_err(|_|"Cipher init failed")?;
    let result=cipher.encrypt(XNonce::from_slice(&nonce),
        Payload{msg:&clear,aad:&item_aad(id)}).map_err(|_|"Bookmark encryption failed".to_string());
    key.zeroize();clear.zeroize();
    Ok(SealedEntry{salt,nonce,ciphertext:result?,
        fingerprint:blind_fingerprint(master,url),version:1})
}
fn decrypt_item(id:&str,sealed:&SealedEntry,key:&[u8;32])->Result<SensitiveLink,String>{
    let cipher=XChaCha20Poly1305::new_from_slice(key)
        .map_err(|_|"Cipher init failed")?;
    let mut clear=cipher.decrypt(XNonce::from_slice(&sealed.nonce),
        Payload{msg:&sealed.ciphertext,aad:&item_aad(id)})
        .map_err(|_|"Bookmark data failed authentication".to_string())?;
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
            "legacyCount":self.legacy_count()}))
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
        // Migrate old folder-only plaintext links automatically after the
        // authenticated unlock. Old independent-code links remain sealed until
        // their former code is supplied once for migration.
        if let Err(error)=self.migrate_plaintext(path,disk.version==1){
            self.lock();return Err(error);
        }
        self.status(path)
    }
    /// Rewrap every current-format item under the new folder-derived key.
    /// Historical independently coded entries retain their old ciphertext
    /// until the user supplies their former code for one-time migration.
    pub fn change_password(&mut self,path:&PathBuf,current:&str,new_code:&str)->Result<Value,String>{
        if !self.unlocked(){return Err("Unlock the Secret Folder first".into());}
        if self.retry_after.is_some_and(|deadline|Instant::now()<deadline){
            return Err("Too many attempts; try again shortly".into());
        }
        if current==new_code{return Err("Choose a different folder password".into());}
        let disk=load(path)?;
        let salt=self.salt.ok_or("Secret Folder key is unavailable")?;
        if salt!=disk.salt{return Err("The vault changed on disk; lock and reopen it".into());}
        let mut supplied=derive(current,&salt)?;
        let master=self.key.as_ref().ok_or("Unlock Secret Folder first")?;
        let mut difference=0u8;
        for i in 0..32{difference|=supplied[i]^master[i];}
        supplied.zeroize();
        if difference!=0{
            self.bad_code();return Err("Current Secret Folder password is incorrect".into());
        }
        let mut new_salt=[0u8;16];OsRng.fill_bytes(&mut new_salt);
        let mut new_key=derive(new_code,&new_salt)?;
        let mut replacement=self.entries.clone();
        for entry in &mut replacement {
            if let Some(ref sealed)=entry.sealed {
                if sealed.version==0{continue;}
                let mut old_item_key=item_key(master,&sealed.salt,&entry.visible_name,entry.bind_visible_name);
                let clear=decrypt_item(&entry.id,sealed,&old_item_key);
                old_item_key.zeroize();
                let clear=clear?;
                entry.sealed=Some(encrypted_link(&entry.id,&clear.title,&clear.url,
                    &new_key,&entry.visible_name,entry.bind_visible_name)?);
            }
        }
        let old_entries=std::mem::replace(&mut self.entries,replacement);
        let old_salt=self.salt.replace(new_salt).ok_or("Missing original salt")?;
        let mut old_key=self.key.replace(new_key).ok_or("Missing original key")?;
        if let Err(error)=self.save(path){
            if let Some(mut failed)=self.key.replace(old_key){failed.zeroize();}
            self.salt=Some(old_salt);
            self.entries=old_entries;
            return Err(error);
        }
        old_key.zeroize();drop(old_entries);
        self.failed_attempts=0;self.retry_after=None;
        self.status(path)
    }

    /// Best-effort overwrites are complementary to cryptographic erasure.
    /// Filesystem snapshots, SSD wear-leveling, antivirus copies and cloud
    /// backups cannot be overwritten reliably by ordinary app software.
    pub fn reset_without_password(&mut self,path:&PathBuf)->Result<Value,String>{
        // Clear live folder key and decrypted folder index before disk access.
        self.lock();
        self.failed_attempts=0;self.retry_after=None;
        for candidate in [path.to_path_buf(),path.with_extension("tmp")]{
            let metadata=match fs::symlink_metadata(&candidate){
                Ok(meta)=>meta,
                Err(e) if e.kind()==std::io::ErrorKind::NotFound=>continue,
                Err(e)=>return Err(format!("Cannot inspect encrypted vault: {e}")),
            };
            if !metadata.file_type().is_file() || metadata.len()>(MAX_BYTES+500_000) as u64{
                return Err("Refusing to overwrite an unexpected secret-vault file".into());
            }
            let mut file=fs::OpenOptions::new().write(true).open(&candidate)
                .map_err(|e|format!("Cannot open encrypted vault for reset: {e}"))?;
            let mut remaining=metadata.len();
            let mut scratch=[0u8;65536];
            for _ in 0..3 {
                file.seek(SeekFrom::Start(0)).map_err(|e|e.to_string())?;
                remaining=metadata.len();
                while remaining>0{
                    let count=(remaining as usize).min(scratch.len());
                    OsRng.fill_bytes(&mut scratch[..count]);
                    file.write_all(&scratch[..count]).map_err(|e|e.to_string())?;
                    remaining-=count as u64;
                }
                // Request actual file writes before advancing each random pass.
                file.sync_all().map_err(|e|e.to_string())?;
            }
            scratch.zeroize();
            file.set_len(0).map_err(|e|e.to_string())?;
            file.sync_all().map_err(|e|e.to_string())?;
            drop(file);
            fs::remove_file(&candidate).map_err(|e|format!("Vault deletion failed: {e}"))?;
        }
        // No new vault or replacement password is created here. The next
        // operation must explicitly create a fresh vault with a fresh salt.
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
        label:&str,url:Option<&str>,true_title:Option<&str>,bind_visible_name:bool)
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
            visible_name:label,bind_visible_name:kind=="link"&&bind_visible_name,
            true_title:String::new(),url:None,sealed:None,
        };
        if kind=="link"{
            let target=url.ok_or("Missing website URL")?;
            if !url_valid(target){return Err("Enter a valid HTTP(S) bookmark URL".into());}
            let canonical=tauri::Url::parse(target).map_err(|_|"Invalid website URL")?.to_string();
            let master=self.key.as_ref().ok_or("Folder locked")?;
            let fingerprint=blind_fingerprint(master,&canonical);
            if self.entries.iter().any(|e|e.sealed.as_ref().is_some_and(|x|x.version==1&&x.fingerprint==fingerprint)
                ||e.url.as_deref()==Some(canonical.as_str())){
                return Err("Bookmark already exists in Secret Bookmarks".into());
            }
            entry.sealed=Some(encrypted_link(&id,true_title.unwrap_or(""),&canonical,
                master,&entry.visible_name,entry.bind_visible_name)?);
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
    /// Return a genuine authenticated-encryption preview without disclosing
    /// any key or plaintext to the browser chrome.
    pub fn preview(&self,title:&str,url:&str,visible_name:&str,bind:bool)->Result<Value,String>{
        let master=self.key.as_ref().ok_or("Unlock Secret Bookmarks first")?;
        if title.len()>512||url.len()>4096||visible_name.len()>512{
            return Err("Secret preview too large".into());
        }
        if !url.is_empty()&&!url_valid(url){return Err("Invalid secret website URL".into());}
        let mut salt=[0u8;16];OsRng.fill_bytes(&mut salt);
        let mut key=item_key(master,&salt,visible_name,bind);
        let cipher=XChaCha20Poly1305::new_from_slice(&key)
            .map_err(|_|"Cipher initialization failed")?;
        fn encode_preview(cipher:&XChaCha20Poly1305,plain:&[u8])->Result<String,String>{
            let mut nonce=[0u8;24];OsRng.fill_bytes(&mut nonce);
            let bytes=cipher.encrypt(XNonce::from_slice(&nonce),
                Payload{msg:plain,aad:AAD})
                .map_err(|_|"Encryption preview failed".to_string())?;
            Ok(bytes.iter().take(28).map(|b|format!("{b:02x}")).collect())
        }
        let name=encode_preview(&cipher,title.as_bytes())?;
        let link=encode_preview(&cipher,url.as_bytes())?;
        key.zeroize();
        Ok(json!({"scrambledName":name,"scrambledLink":link,"ephemeral":true}))
    }
    fn migrate_plaintext(&mut self,path:&PathBuf,force_save:bool)->Result<(),String>{
        let master=self.key.as_ref().ok_or("Unlock Secret Bookmarks first")?;
        let mut changed=false;
        for entry in &mut self.entries {
            if entry.kind!="link"||entry.sealed.is_some(){continue;}
            let url=entry.url.as_deref().ok_or("Legacy secret URL missing")?;
            entry.bind_visible_name=true;
            entry.sealed=Some(encrypted_link(&entry.id,&entry.true_title,url,
                master,&entry.visible_name,true)?);
            if let Some(url)=entry.url.as_mut(){url.zeroize();}
            entry.url=None;entry.true_title.zeroize();entry.true_title.clear();
            changed=true;
        }
        if changed||force_save{self.save(path)?;}
        Ok(())
    }
    pub fn legacy_count(&self)->usize{
        self.entries.iter().filter(|e|e.kind=="link"&&
            e.sealed.as_ref().is_some_and(|s|s.version==0)).count()
    }
    /// One-time upgrade of older entries that used distinct bookmark codes.
    /// Unmatched entries remain untouched so multiple old codes can migrate
    /// independently, without changing IDs or losing their ciphertext.
    pub fn migrate(&mut self,path:&PathBuf,code:&str)->Result<Value,String>{
        if !self.unlocked(){return Err("Unlock Secret Bookmarks first".into());}
        if self.retry_after.is_some_and(|deadline|Instant::now()<deadline){
            return Err("Too many attempts; try again shortly".into());
        }
        let master=self.key.as_ref().ok_or("Folder locked")?;
        let mut replacement=self.entries.clone();
        let mut count=0;
        for entry in &mut replacement{
            let Some(ref sealed)=entry.sealed else{continue};
            if sealed.version!=0{continue;}
            let mut prior_key=derive(code,&sealed.salt)?;
            let clear=decrypt_item(&entry.id,sealed,&prior_key);
            prior_key.zeroize();
            if let Ok(clear)=clear{
                entry.bind_visible_name=true;
                entry.sealed=Some(encrypted_link(&entry.id,&clear.title,&clear.url,
                    master,&entry.visible_name,true)?);
                count+=1;
            }
        }
        if count==0{
            self.bad_code();
            return Err("No older bookmarks matched that previous entry code".into());
        }
        let old=std::mem::replace(&mut self.entries,replacement);
        if let Err(error)=self.save(path){self.entries=old;return Err(error);}
        drop(old);
        self.failed_attempts=0;self.retry_after=None;
        let mut result=self.status(path)?;
        result["migrated"]=json!(count);
        Ok(result)
    }
    /// Each modern entry's key is deterministically derived from the unlocked
    /// folder password key and optional name. No separate entry code is used.
    pub fn authorize(&self,ids:&[String])->Result<Vec<[u8;32]>,String>{
        let master=self.key.as_ref().ok_or("Unlock the Secret Bookmarks folder first")?;
        if ids.is_empty()||ids.len()>35{return Err("Select 1–35 bookmarks".into());}
        let mut keys=Vec::with_capacity(ids.len());
        for id in ids{
            let entry=self.entries.iter().find(|e|e.id==*id&&e.kind=="link")
                .ok_or("Secret Bookmark not found")?;
            let sealed=entry.sealed.as_ref().ok_or("Secret Bookmark needs migration")?;
            if sealed.version==0{
                return Err("This older bookmark needs a one-time entry-code migration".into());
            }
            let mut key=item_key(master,&sealed.salt,&entry.visible_name,entry.bind_visible_name);
            if decrypt_item(id,sealed,&key).is_err(){
                key.zeroize();
                for value in &mut keys{value.zeroize();}
                return Err("Secret Bookmark ciphertext failed authentication".into());
            }
            keys.push(key);
        }
        Ok(keys)
    }
    pub fn link_with_key(&self,id:&str,key:&[u8;32])->Result<String,String>{
        if !self.unlocked(){return Err("Unlock the Secret Bookmarks folder first".into());}
        let entry=self.entries.iter().find(|e|e.id==id&&e.kind=="link")
            .ok_or("Secret bookmark not found")?;
        let sealed=entry.sealed.as_ref().ok_or("Bookmark needs migration")?;
        let decrypted=decrypt_item(id,sealed,key)?;
        if !url_valid(&decrypted.url){return Err("Decrypted bookmark URL is invalid".into());}
        Ok(decrypted.url.clone())
    }
    pub fn edit(&mut self,path:&PathBuf,id:&str,label:&str,bind:bool)->Result<Value,String>{
        let master=self.key.as_ref().ok_or("Unlock Secret Bookmarks first")?;
        let idx=self.entries.iter().position(|entry|entry.id==id)
            .ok_or("Secret bookmark not found")?;
        let mut next=self.entries[idx].clone();
        let new_label=label.chars().take(100).collect::<String>();
        if next.kind=="link"{
            if let Some(ref sealed)=next.sealed{
                if sealed.version==1{
                    let mut previous_key=item_key(master,&sealed.salt,&next.visible_name,next.bind_visible_name);
                    let clear=decrypt_item(id,sealed,&previous_key);
                    previous_key.zeroize();
                    let clear=clear?;
                    next.sealed=Some(encrypted_link(id,&clear.title,&clear.url,
                        master,&new_label,bind)?);
                }
            }
            next.bind_visible_name=bind;
        }
        next.visible_name=new_label;
        let previous=std::mem::replace(&mut self.entries[idx],next);
        if let Err(error)=self.save(path){self.entries[idx]=previous;return Err(error);}
        drop(previous);
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
    #[test]
    fn password_change_requires_current_and_preserves_independent_bookmarks(){
        let path=temporary();
        let mut vault=SecretVault::default();
        vault.open(&path,FOLDER,true).unwrap();
        let saved=vault.put(&path,"link",None,"Alias",
            Some("https://private.example.org/protected"),
            Some("Encrypted Real Name"),Some(ENTRY)).unwrap();
        let id=saved["id"].as_str().unwrap().to_string();
        let original=fs::read(&path).unwrap();
        assert!(vault.change_password(&path,"wrong!", "new-pass*2026").is_err());
        assert_eq!(fs::read(&path).unwrap(),original);
        vault.retry_after=None;
        assert!(vault.change_password(&path,FOLDER,FOLDER).is_err());
        let updated=vault.change_password(&path,FOLDER,"new-pass*2026").unwrap();
        assert_eq!(updated["items"].as_array().unwrap().len(),1);
        vault.lock();
        assert!(vault.open(&path,FOLDER,false).is_err());
        vault.retry_after=None;
        vault.open(&path,"new-pass*2026",false).unwrap();
        let keys=vault.authorize(&[id.clone()],ENTRY).unwrap();
        assert_eq!(vault.link_with_key(&id,&keys[0]).unwrap(),
            "https://private.example.org/protected");
        vault.lock();
        let _=fs::remove_file(path);
    }
    #[test]
    fn password_reset_deletes_every_secret_and_requires_fresh_creation(){
        let path=temporary();
        let mut vault=SecretVault::default();
        vault.open(&path,FOLDER,true).unwrap();
        vault.put(&path,"link",None,"Alias",Some("https://secret.example.org/"),
            Some("Hidden"),Some(ENTRY)).unwrap();
        let old_bytes=fs::read(&path).unwrap();
        assert!(old_bytes.len()>100);
        // Simulate a forgotten password: the reset does not supply the old one.
        vault.lock();
        let result=vault.reset_without_password(&path).unwrap();
        assert_eq!(result["exists"],false);
        assert!(!path.exists());
        assert!(!path.with_extension("tmp").exists());
        assert!(!vault.unlocked());
        // A new installation-style vault can be created only after deletion.
        vault.open(&path,"New!vault#2026",true).unwrap();
        assert!(vault.status(&path).unwrap()["items"].as_array().unwrap().is_empty());
        vault.lock();
        let _=fs::remove_file(path);
    }

}