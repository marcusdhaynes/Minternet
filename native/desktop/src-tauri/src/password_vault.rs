use std::{fs, path::PathBuf};
use serde::{Serialize, Deserialize};
use tauri::Manager;
use argon2::Argon2;
use chacha20poly1305::{ChaCha20Poly1305, KeyInit, Nonce, aead::Aead};
use rand::{rngs::OsRng, RngCore};
use zeroize::Zeroize;

const MAX_ENTRIES: usize = 2000;
#[derive(Clone, Serialize, Deserialize)]
pub struct Entry {
    pub origin: String,
    pub username: String,
    pub password: String,
    #[serde(default = "default_autofill")]
    pub autofill: bool,
}
fn default_autofill() -> bool { true }
#[derive(Clone, Serialize, Deserialize)]
pub struct PaymentCard {
    pub id:String,
    pub label:String,
    pub name:String,
    pub number:String,
    pub month:u8,
    pub year:u16,
    pub postal:String,
}
impl Drop for PaymentCard {
    fn drop(&mut self){self.number.zeroize();self.name.zeroize();self.postal.zeroize();}
}
#[derive(Serialize,Deserialize)]
#[serde(untagged)]
enum VaultPayload {
    Legacy(Vec<Entry>),
    Current{logins:Vec<Entry>,cards:Vec<PaymentCard>}
}
fn valid_pan(input:&str)->Option<String>{
    if input.len()>40{return None;}
    if !input.chars().all(|c|c.is_ascii_digit()||c==' '||c=='-'){return None;}
    let digits=input.chars().filter(|c|c.is_ascii_digit()).collect::<String>();
    if !(12..=19).contains(&digits.len()) {return None;}
    let mut sum=0u32;
    for (i,byte) in digits.bytes().rev().enumerate(){
        let mut n=(byte-b'0') as u32;
        if i%2==1{n*=2;if n>9{n-=9;}}
        sum+=n;
    }
    if sum%10!=0{return None;}
    Some(digits)
}

#[derive(Serialize, Deserialize)]
struct FileData {
    version: u8,
    salt: [u8; 16],
    nonce: [u8; 12],
    ciphertext: Vec<u8>,
}
#[derive(Default)]
pub struct Vault {
    key: Option<[u8; 32]>,
    salt: Option<[u8; 16]>,
    entries: Vec<Entry>,
    cards: Vec<PaymentCard>,
}
impl Drop for Vault {
    fn drop(&mut self) { self.lock(); }
}
impl Vault {
    pub fn unlocked(&self) -> bool { self.key.is_some() }
    pub fn lock(&mut self) {
        if let Some(mut key)=self.key.take(){key.zeroize();}
        for entry in &mut self.entries {entry.password.zeroize();entry.username.zeroize();}
        self.entries.clear();
        self.cards.clear();
        self.salt=None;
    }
    pub fn list(&self) -> Result<serde_json::Value,String> {
        if !self.unlocked(){return Err("Unlock your password vault first".into());}
        Ok(serde_json::json!(self.entries.iter().map(|e|
            serde_json::json!({"origin":e.origin,"username":e.username,"autofill":e.autofill})
        ).collect::<Vec<_>>()))
    }
    pub fn matching(&self, origin:&str, manual:bool, username:Option<&str>) -> Option<Entry> {
        if !self.unlocked(){return None;}
        self.entries.iter().find(|e|e.origin==origin&&(manual||e.autofill)&&username.map(|name|name==e.username).unwrap_or(true)).cloned()
    }
    fn key_from(password:&str,salt:&[u8;16]) -> Result<[u8;32],String> {
        if password.len()<12||password.len()>1024{return Err("Master password must contain 12–1024 characters".into());}
        let mut key=[0u8;32];
        Argon2::default().hash_password_into(password.as_bytes(),salt,&mut key)
            .map_err(|_|"Key derivation failed".to_string())?;
        Ok(key)
    }
    pub fn unlock(&mut self, path:&PathBuf, password:&str, create:bool)->Result<(),String>{
        self.lock();
        if create {
            if path.exists(){return Err("Vault already exists; unlock instead".into());}
            let mut salt=[0u8;16];OsRng.fill_bytes(&mut salt);
            let key=Self::key_from(password,&salt)?;
            self.key=Some(key);self.salt=Some(salt);
            if let Err(err)=self.save(path){self.lock();return Err(err);}
            return Ok(());
        }
        let bytes=fs::read(path).map_err(|_|"No password vault exists yet".to_string())?;
        if bytes.len()>2_000_000{return Err("Password vault exceeds allowed size".into());}
        let disk:FileData=serde_json::from_slice(&bytes).map_err(|_|"Invalid vault format".to_string())?;
        if disk.version!=1{return Err("Unsupported password vault version".into());}
        let mut key=Self::key_from(password,&disk.salt)?;
        let cipher=ChaCha20Poly1305::new_from_slice(&key).map_err(|_|"Crypto initialization failed".to_string())?;
        let mut plaintext=match cipher.decrypt(Nonce::from_slice(&disk.nonce),disk.ciphertext.as_ref()){
            Ok(v)=>v,Err(_)=>{key.zeroize();return Err("Incorrect master password or vault authentication failed".into());}
        };
        let parsed=serde_json::from_slice::<VaultPayload>(&plaintext);
        plaintext.zeroize();
        let (entries,cards)=match parsed.map_err(|_|"Invalid vault entries".to_string())?{
            VaultPayload::Legacy(entries)=>(entries,Vec::new()),
            VaultPayload::Current{logins,cards}=>(logins,cards)
        };
        if entries.len()>MAX_ENTRIES||cards.len()>50{return Err("Vault capacity exceeded".into());}
        self.key=Some(key);self.salt=Some(disk.salt);self.entries=entries;self.cards=cards;
        Ok(())
    }
    pub fn save(&self,path:&PathBuf)->Result<(),String>{
        let key=self.key.as_ref().ok_or("Vault locked")?;
        let salt=self.salt.ok_or("Missing vault salt")?;
        let mut plaintext=serde_json::to_vec(&VaultPayload::Current{
            logins:self.entries.clone(),cards:self.cards.clone()
        }).map_err(|e|e.to_string())?;
        let mut nonce=[0u8;12];OsRng.fill_bytes(&mut nonce);
        let cipher=ChaCha20Poly1305::new_from_slice(key).map_err(|_|"Crypto initialization failed")?;
        let encrypted=cipher.encrypt(Nonce::from_slice(&nonce),plaintext.as_ref())
            .map_err(|_|"Encryption failed".to_string());
        plaintext.zeroize();
        let disk=FileData{version:1,salt,nonce,ciphertext:encrypted?};
        let bytes=serde_json::to_vec(&disk).map_err(|e|e.to_string())?;
        if let Some(parent)=path.parent(){fs::create_dir_all(parent).map_err(|e|e.to_string())?;}
        let temporary=path.with_extension("tmp");
        fs::write(&temporary,bytes).map_err(|e|e.to_string())?;
        if fs::rename(&temporary,path).is_err(){
            fs::copy(&temporary,path).map_err(|e|e.to_string())?;
            let _=fs::remove_file(&temporary);
        }
        Ok(())
    }
    pub fn put(&mut self,origin:String,username:String,password:String,autofill:bool)->Result<(),String>{
        if !self.unlocked(){return Err("Vault locked".into());}
        if username.len()>320||password.is_empty()||password.len()>4096{return Err("Invalid credential length".into());}
        if let Some(old)=self.entries.iter_mut().find(|e|e.origin==origin&&e.username==username){
            old.password.zeroize();old.password=password;old.autofill=autofill;
        }else{
            if self.entries.len()>=MAX_ENTRIES{return Err("Vault limit reached".into());}
            self.entries.push(Entry{origin,username,password,autofill});
        }
        Ok(())
    }
    pub fn list_cards(&self)->Result<serde_json::Value,String>{
        if !self.unlocked(){return Err("Unlock the encrypted vault first".into());}
        Ok(serde_json::json!(self.cards.iter().map(|card|serde_json::json!({
            "id":card.id,"label":card.label,"name":card.name,
            "last4":card.number.chars().rev().take(4).collect::<String>().chars().rev().collect::<String>(),
            "month":card.month,"year":card.year,"postal":card.postal
        })).collect::<Vec<_>>()))
    }
    pub fn put_card(&mut self,label:String,name:String,number:String,
                    month:u8,year:u16,postal:String)->Result<String,String>{
        if !self.unlocked(){return Err("Unlock the encrypted vault first".into());}
        if self.cards.len()>=50{return Err("Maximum 50 payment methods".into());}
        if label.len()>80||name.trim().is_empty()||name.len()>120||
           postal.len()>40||!(1..=12).contains(&month)||
           !(2020..=2100).contains(&year) {return Err("Invalid card details".into());}
        let number=valid_pan(&number).ok_or("Invalid card number (Luhn check)")?;
        let mut bytes=[0u8;12];OsRng.fill_bytes(&mut bytes);
        let id=bytes.iter().map(|b|format!("{b:02x}")).collect::<String>();
        self.cards.push(PaymentCard{id:id.clone(),label,name,number,month,year,postal});
        Ok(id)
    }
    pub fn remove_card(&mut self,id:&str)->Result<(),String>{
        if !self.unlocked(){return Err("Unlock the encrypted vault first".into());}
        let i=self.cards.iter().position(|c|c.id==id).ok_or("Card not found")?;
        self.cards.remove(i);
        Ok(())
    }
    pub fn card(&self,id:&str)->Option<PaymentCard>{
        if !self.unlocked(){return None;}
        self.cards.iter().find(|c|c.id==id).cloned()
    }
    pub fn remove(&mut self,origin:&str,username:&str)->Result<(),String>{
        if !self.unlocked(){return Err("Vault locked".into());}
        let i=self.entries.iter().position(|e|e.origin==origin&&e.username==username)
            .ok_or("Credential not found")?;
        let mut old=self.entries.remove(i);
        old.password.zeroize();old.username.zeroize();
        Ok(())
    }
}
pub fn file(app:&tauri::AppHandle)->Result<PathBuf,String>{
    Ok(app.path().app_data_dir().map_err(|e|e.to_string())?.join("password-vault.v1.enc"))
}
pub fn origin(address:&str)->Result<String,String>{
    let url=tauri::Url::parse(address).map_err(|_|"Invalid HTTPS website URL".to_string())?;
    if url.scheme()!="https"||url.host_str().is_none()||!url.username().is_empty()||url.password().is_some(){
        return Err("Password saving requires a valid HTTPS origin".into());
    }
    Ok(url.origin().ascii_serialization())
}

#[cfg(test)]
mod card_tests{
    use super::*;
    #[test]
    fn validate_luhn_and_reject_card_secrets(){
        assert_eq!(valid_pan("4111 1111 1111 1111"),Some("4111111111111111".into()));
        assert!(valid_pan("4111 1111 1111 1112").is_none());
        assert!(valid_pan("4111<script>alert(1)</script>").is_none());
    }
    #[test]
    fn payment_methods_are_encrypted_and_never_list_pan(){
        let mut salt=[0u8;6];OsRng.fill_bytes(&mut salt);
        let name=format!("card-vault-test-{}",salt.iter().map(|b|format!("{b:02x}")).collect::<String>());
        let path=std::env::temp_dir().join(name);
        let mut vault=Vault::default();
        vault.unlock(&path,"correct horse battery staple",true).unwrap();
        let id=vault.put_card("Personal".into(),"Example User".into(),
            "4111111111111111".into(),12,2030,"90210".into()).unwrap();
        let cards=vault.list_cards().unwrap().to_string();
        assert!(cards.contains("1111"));
        assert!(!cards.contains("4111111111111111"));
        vault.save(&path).unwrap();
        let raw=fs::read(&path).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("4111111111111111"));
        vault.lock();
        assert!(vault.list_cards().is_err());
        vault.unlock(&path,"correct horse battery staple",false).unwrap();
        assert_eq!(vault.card(&id).unwrap().number,"4111111111111111");
        let _=fs::remove_file(path);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encrypted_vault_round_trip_and_wrong_password() {
        let mut random=[0u8;16];OsRng.fill_bytes(&mut random);
        let unique=random.iter().map(|x|format!("{x:02x}")).collect::<String>();
        let file=std::env::temp_dir().join(format!("minternet-vault-test-{unique}.enc"));
        let mut vault=Vault::default();
        vault.unlock(&file,"correct horse battery staple",true).unwrap();
        vault.put("https://example.com".into(),"alice".into(),"a-secret-credential".into(),true).unwrap();
        vault.save(&file).unwrap();
        let stored=fs::read(&file).unwrap();
        assert!(!String::from_utf8_lossy(&stored).contains("a-secret-credential"));
        assert!(!String::from_utf8_lossy(&stored).contains("alice"));
        vault.lock();
        assert!(vault.matching("https://example.com",false,None).is_none());
        assert!(vault.unlock(&file,"wrong master password",false).is_err());
        vault.unlock(&file,"correct horse battery staple",false).unwrap();
        assert_eq!(vault.matching("https://example.com",false,None).unwrap().password,"a-secret-credential");
        assert!(vault.matching("https://example.org",false,None).is_none());
        vault.remove("https://example.com","alice").unwrap();
        vault.save(&file).unwrap();
        vault.lock();
        vault.unlock(&file,"correct horse battery staple",false).unwrap();
        assert!(vault.matching("https://example.com",false,None).is_none());
        let _=fs::remove_file(&file);
    }
    #[test]
    fn only_exact_https_origins() {
        assert_eq!(origin("https://example.com/login").unwrap(),"https://example.com");
        assert_ne!(origin("https://sub.example.com").unwrap(),origin("https://example.com").unwrap());
        assert!(origin("http://example.com").is_err());
        assert!(origin("https://user:password@example.com").is_err());
        assert!(origin("javascript:alert(1)").is_err());
    }
}
