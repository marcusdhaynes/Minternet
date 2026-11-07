use std::{fs, path::PathBuf, collections::BTreeMap};
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
/// Identifying fields are stored only inside the existing authenticated,
/// password-derived encrypted vault; never in regular bookmarks or localStorage.
#[derive(Clone,Serialize,Deserialize)]
pub struct Identity {
    pub id:String,
    pub label:String,
    pub fields:BTreeMap<String,String>,
}
impl Drop for Identity {
    fn drop(&mut self){
        self.label.zeroize();
        for value in self.fields.values_mut(){value.zeroize();}
    }
}
fn valid_identity_field(key:&str)->bool{
    matches!(key,"full-name"|"given-name"|"family-name"|"middle-name"|"nickname"|
        "email"|"phone"|"company"|"job-title"|"street-address"|"address-line1"|
        "address-line2"|"city"|"region"|"postal-code"|"country"|"date-of-birth"|
        "national-id"|"passport-number"|"passport-country"|"passport-expiry"|
        "drivers-license"|"drivers-license-state"|"vehicle-make"|"vehicle-model"|
        "vehicle-year"|"vehicle-color"|"license-plate"|"vin"|"tax-id"|"website")
        || (key.starts_with("custom-")&&key.len()<=46&&
            key[7..].bytes().all(|c|c.is_ascii_lowercase()||c.is_ascii_digit()||c==b'-'))
}
fn check_identity(label:&str,fields:&BTreeMap<String,String>)->Result<(),String>{
    if label.trim().is_empty()||label.len()>80||fields.len()>40||
       fields.is_empty(){return Err("Identity needs a label and one or more fields".into());}
    for (name,value) in fields {
        if !valid_identity_field(name)||value.len()>400||value.chars().any(|c|c=='\0'){
            return Err("Invalid identity field or value".into());
        }
    }
    Ok(())
}
#[derive(Serialize,Deserialize)]
#[serde(untagged)]
enum VaultPayload {
    Legacy(Vec<Entry>),
    Current{logins:Vec<Entry>,cards:Vec<PaymentCard>,#[serde(default)] identities:Vec<Identity>}
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
    identities:Vec<Identity>,
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
        self.identities.clear();
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
        let (entries,cards,identities)=match parsed.map_err(|_|"Invalid vault entries".to_string())?{
            VaultPayload::Legacy(entries)=>(entries,Vec::new(),Vec::new()),
            VaultPayload::Current{logins,cards,identities}=>(logins,cards,identities)
        };
        if entries.len()>MAX_ENTRIES||cards.len()>50||identities.len()>60{
            return Err("Vault capacity exceeded".into());
        }
        for identity in &identities {check_identity(&identity.label,&identity.fields)?;}
        self.key=Some(key);self.salt=Some(disk.salt);
        self.entries=entries;self.cards=cards;self.identities=identities;
        Ok(())
    }
    pub fn save(&self,path:&PathBuf)->Result<(),String>{
        let key=self.key.as_ref().ok_or("Vault locked")?;
        let salt=self.salt.ok_or("Missing vault salt")?;
        let mut plaintext=serde_json::to_vec(&VaultPayload::Current{
            logins:self.entries.clone(),cards:self.cards.clone(),identities:self.identities.clone()
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
    /// Merge the authenticated remote vault with the *same* Argon2 salt/key.
    /// Existing credentials and cards are never replaced: concurrent edits
    /// fail closed instead of destroying local secrets.
    pub fn merge_encrypted_backup(&mut self,bytes:&[u8],path:&PathBuf)
        ->Result<serde_json::Value,String>{
        let key=self.key.as_ref().ok_or("Unlock the local vault to merge cloud secrets")?;
        if bytes.len()>2_000_000{return Err("Remote vault exceeds safety limit".into());}
        let disk:FileData=serde_json::from_slice(bytes)
            .map_err(|_|"Invalid remote vault".to_string())?;
        if disk.version!=1||Some(disk.salt)!=self.salt {
            return Err("Different vault master key: preserve both vaults and resolve manually".into());
        }
        let cipher=ChaCha20Poly1305::new_from_slice(key).map_err(|_|"Crypto error")?;
        let mut plain=cipher.decrypt(Nonce::from_slice(&disk.nonce),disk.ciphertext.as_ref())
            .map_err(|_|"Cloud vault authentication failed".to_string())?;
        let parsed=serde_json::from_slice::<VaultPayload>(&plain);
        plain.zeroize();
        let (logins,cards,identities)=match parsed.map_err(|_|"Cloud vault data invalid".to_string())?{
            VaultPayload::Legacy(logins)=>(logins,Vec::new(),Vec::new()),
            VaultPayload::Current{logins,cards,identities}=>(logins,cards,identities)
        };
        let mut new_logins=0;
        let mut new_cards=0;
        let mut conflicts=0;
        for entry in logins {
            if let Some(existing)=self.entries.iter().find(|e|
                e.origin==entry.origin&&e.username==entry.username){
                if existing.password!=entry.password {conflicts+=1;}
            }else if self.entries.len()<MAX_ENTRIES{
                self.entries.push(entry);
                new_logins+=1;
            }
        }
        for card in cards {
            if let Some(existing)=self.cards.iter().find(|c|c.id==card.id){
                if existing.number!=card.number||existing.month!=card.month||
                   existing.year!=card.year {conflicts+=1;}
            }else if self.cards.len()<50{
                self.cards.push(card);
                new_cards+=1;
            }
        }
        let mut new_identities=0;
        for identity in identities {
            if check_identity(&identity.label,&identity.fields).is_err(){continue;}
            if let Some(existing)=self.identities.iter().find(|e|e.id==identity.id){
                if existing.fields!=identity.fields{conflicts+=1;}
            }else if self.identities.len()<60{
                self.identities.push(identity);new_identities+=1;
            }
        }
        if new_logins>0||new_cards>0||new_identities>0{self.save(path)?;}
        Ok(serde_json::json!({"ok":true,"addedLogins":new_logins,
            "addedCards":new_cards,"addedIdentities":new_identities,"conflicts":conflicts}))
    }

    // Trusted-local-chrome export: records are encrypted individually with the
    // user's cross-device sync key before leaving the app. Never for websites.
    pub fn sync_snapshot(&self)->Result<serde_json::Value,String>{
        if !self.unlocked(){return Err("Unlock the local vault to sync secrets".into());}
        Ok(serde_json::json!({"logins":self.entries,"cards":self.cards,"identities":self.identities}))
    }
    pub fn sync_apply(&mut self,kind:&str,value:&serde_json::Value,deleted:bool)
        ->Result<bool,String>{
        if !self.unlocked(){return Err("Unlock the local vault before applying encrypted sync".into());}
        match kind {
            "login"=>{
                let address=value.get("origin").and_then(serde_json::Value::as_str)
                    .ok_or("Missing synced origin")?;
                let domain=origin(address)?;
                let username=value.get("username").and_then(serde_json::Value::as_str)
                    .ok_or("Missing synced username")?;
                if username.len()>320{return Err("Invalid login identity".into());}
                if deleted {
                    let old=self.entries.iter().position(|e|e.origin==domain&&e.username==username);
                    if let Some(index)=old {
                        let mut removed=self.entries.remove(index);
                        removed.password.zeroize();removed.username.zeroize();
                        return Ok(true);
                    }
                    return Ok(false);
                }
                let pass=value.get("password").and_then(serde_json::Value::as_str)
                    .ok_or("Missing synced password")?;
                if pass.is_empty()||pass.len()>4096{return Err("Invalid synced password".into());}
                let autofill=value.get("autofill").and_then(serde_json::Value::as_bool)!=Some(false);
                if let Some(entry)=self.entries.iter_mut().find(|e|e.origin==domain&&e.username==username){
                    if entry.password==pass&&entry.autofill==autofill{return Ok(false);}
                    entry.password.zeroize();entry.password=pass.to_owned();entry.autofill=autofill;
                    Ok(true)
                }else{
                    if self.entries.len()>=MAX_ENTRIES{return Err("Credential capacity exceeded".into());}
                    self.entries.push(Entry{origin:domain,username:username.to_owned(),
                        password:pass.to_owned(),autofill});
                    Ok(true)
                }
            }
            "payment"=>{
                let id=value.get("id").and_then(serde_json::Value::as_str)
                    .ok_or("Missing synced payment ID")?;
                if id.len()!=24||!id.chars().all(|c|c.is_ascii_hexdigit()){
                    return Err("Invalid synced payment identity".into());
                }
                if deleted {
                    if let Some(i)=self.cards.iter().position(|c|c.id==id){
                        self.cards.remove(i);
                        return Ok(true);
                    }
                    return Ok(false);
                }
                let number=value.get("number").and_then(serde_json::Value::as_str)
                    .and_then(valid_pan).ok_or("Invalid synced payment card number")?;
                let name=value.get("name").and_then(serde_json::Value::as_str)
                    .ok_or("Missing cardholder")?;
                let label=value.get("label").and_then(serde_json::Value::as_str).unwrap_or("");
                let month=value.get("month").and_then(serde_json::Value::as_u64)
                    .ok_or("Missing expiry month")?;
                let year=value.get("year").and_then(serde_json::Value::as_u64)
                    .ok_or("Missing expiry year")?;
                let postal=value.get("postal").and_then(serde_json::Value::as_str).unwrap_or("");
                if !(1..=12).contains(&month)||!(2020..=2100).contains(&year)||
                   name.is_empty()||name.len()>120||label.len()>80||postal.len()>40{
                    return Err("Invalid synced payment details".into());
                }
                let incoming=PaymentCard{id:id.to_owned(),label:label.to_owned(),
                    name:name.to_owned(),number,month:month as u8,year:year as u16,
                    postal:postal.to_owned()};
                if let Some(existing)=self.cards.iter_mut().find(|c|c.id==id){
                    if existing.name==incoming.name&&existing.number==incoming.number&&
                       existing.month==incoming.month&&existing.year==incoming.year&&
                       existing.label==incoming.label&&existing.postal==incoming.postal{
                        return Ok(false);
                    }
                    *existing=incoming;Ok(true)
                }else{
                    if self.cards.len()>=50{return Err("Payment capacity exceeded".into());}
                    self.cards.push(incoming);Ok(true)
                }
            }
            "identity"=>{
                let id=value.get("id").and_then(serde_json::Value::as_str)
                    .ok_or("Missing synced identity ID")?;
                if id.len()!=24||!id.bytes().all(|c|c.is_ascii_hexdigit()){
                    return Err("Invalid synced identity ID".into());
                }
                if deleted {
                    if let Some(i)=self.identities.iter().position(|e|e.id==id){
                        self.identities.remove(i);return Ok(true);
                    }
                    return Ok(false);
                }
                let identity:Identity=serde_json::from_value(value.clone())
                    .map_err(|_|"Invalid synced identity")?;
                check_identity(&identity.label,&identity.fields)?;
                if let Some(existing)=self.identities.iter_mut().find(|e|e.id==id){
                    if existing.label==identity.label&&existing.fields==identity.fields{return Ok(false);}
                    *existing=identity;return Ok(true);
                }
                if self.identities.len()>=60{return Err("Identity capacity exceeded".into());}
                self.identities.push(identity);Ok(true)
            }
            _=>Err("Unsupported synced vault category".into())
        }
    }

    pub fn list_identities(&self)->Result<serde_json::Value,String>{
        if !self.unlocked(){return Err("Unlock the encrypted vault first".into());}
        Ok(serde_json::json!(self.identities.iter().map(|item|serde_json::json!({
            "id":item.id,"label":item.label,
            "fields":item.fields.keys().collect::<Vec<_>>()
        })).collect::<Vec<_>>()))
    }
    pub fn identity(&self,id:&str)->Option<Identity>{
        if !self.unlocked(){return None;}
        self.identities.iter().find(|e|e.id==id).cloned()
    }
    pub fn put_identity(&mut self,id:Option<&str>,label:String,fields:BTreeMap<String,String>)
        ->Result<String,String>{
        if !self.unlocked(){return Err("Unlock the encrypted vault first".into());}
        check_identity(&label,&fields)?;
        if let Some(id)=id{
            let entry=self.identities.iter_mut().find(|e|e.id==id)
                .ok_or("Identity not found")?;
            *entry=Identity{id:id.to_owned(),label,fields};
            return Ok(id.to_owned());
        }
        if self.identities.len()>=60{return Err("Maximum 60 identities".into());}
        let mut bytes=[0u8;12];OsRng.fill_bytes(&mut bytes);
        let id=bytes.iter().map(|b|format!("{b:02x}")).collect::<String>();
        self.identities.push(Identity{id:id.clone(),label,fields});
        Ok(id)
    }
    pub fn remove_identity(&mut self,id:&str)->Result<(),String>{
        if !self.unlocked(){return Err("Unlock the encrypted vault first".into());}
        let index=self.identities.iter().position(|e|e.id==id)
            .ok_or("Identity not found")?;
        self.identities.remove(index);Ok(())
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
    pub fn update_card(&mut self,id:&str,label:String,name:String,
                       month:u8,year:u16,postal:String)->Result<(),String>{
        if !self.unlocked(){return Err("Unlock the encrypted vault first".into());}
        if label.len()>80||name.trim().is_empty()||name.len()>120||
            postal.len()>40||!(1..=12).contains(&month)||
            !(2020..=2100).contains(&year){return Err("Invalid card details".into());}
        let card=self.cards.iter_mut().find(|c|c.id==id).ok_or("Card not found")?;
        card.name.zeroize();card.postal.zeroize();
        card.label=label;card.name=name;card.month=month;card.year=year;card.postal=postal;
        Ok(())
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
        vault.update_card(&id,"Travel".into(),"Updated User".into(),3,2031,"10001".into()).unwrap();
        assert_eq!(vault.card(&id).unwrap().name,"Updated User");
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
    fn identities_are_encrypted_masked_and_persist_with_existing_logins(){
        let path=std::env::temp_dir().join(format!("minternet-identities-{}.enc",
            rand::random::<u64>()));
        let mut vault=Vault::default();
        vault.unlock(&path,"correct horse battery staple",true).unwrap();
        vault.put("https://example.com".into(),"alice".into(),"secret".into(),true).unwrap();
        let mut values=BTreeMap::new();
        values.insert("full-name".into(),"Example User".into());
        values.insert("passport-number".into(),"A12345678".into());
        values.insert("vin".into(),"1HGCM82633A004352".into());
        let id=vault.put_identity(None,"Travel".into(),values.clone()).unwrap();
        assert!(!vault.list_identities().unwrap().to_string().contains("A12345678"));
        assert_eq!(vault.identity(&id).unwrap().fields,values);
        vault.save(&path).unwrap();
        let encoded=fs::read(&path).unwrap();
        assert!(!String::from_utf8_lossy(&encoded).contains("A12345678"));
        assert!(!String::from_utf8_lossy(&encoded).contains("Example User"));
        vault.lock();
        assert!(vault.identity(&id).is_none());
        vault.unlock(&path,"correct horse battery staple",false).unwrap();
        assert_eq!(vault.identity(&id).unwrap().fields,values);
        assert_eq!(vault.matching("https://example.com",true,None).unwrap().username,"alice");
        vault.remove_identity(&id).unwrap();
        vault.save(&path).unwrap();
        assert!(vault.identity(&id).is_none());
        let _=fs::remove_file(path);
    }
    #[test]
    fn identity_field_validation_rejects_secrets_and_invalid_tags(){
        let mut fields=BTreeMap::new();
        fields.insert("passport-number".into(),"P-123".into());
        assert!(check_identity("Travel",&fields).is_ok());
        fields.insert("password".into(),"secret".into());
        assert!(check_identity("Travel",&fields).is_err());
        fields.remove("password");
        fields.insert("credit-card-cvv".into(),"123".into());
        assert!(check_identity("Travel",&fields).is_err());
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
