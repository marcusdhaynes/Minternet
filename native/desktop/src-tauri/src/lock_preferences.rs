//! Per-section master-password prompts. Defaults require a password.
use std::{fs,path::PathBuf};
use serde::{Serialize,Deserialize};
use tauri::Manager;
#[derive(Clone,Copy,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Policy{
    #[serde(default="yes")]pub logins:bool,
    #[serde(default="yes")]pub identities:bool,
    #[serde(default="yes")]pub payments:bool,
    // This controls *Secret* Bookmarks; ordinary Bookmarks are not encrypted.
    #[serde(default="yes")]pub bookmarks:bool,
}
fn yes()->bool{true}
impl Default for Policy{
    fn default()->Self{Self{logins:true,identities:true,payments:true,bookmarks:true}}
}
impl Policy{
    pub fn required(&self,kind:&str)->Result<bool,String>{
        match kind{
            "logins"=>Ok(self.logins),"identities"=>Ok(self.identities),
            "payments"=>Ok(self.payments),"bookmarks"=>Ok(self.bookmarks),
            _=>Err("Unknown lock preference".into())
        }
    }
    pub fn set(&mut self,kind:&str,locked:bool)->Result<(),String>{
        match kind{
            "logins"=>self.logins=locked,
            "identities"=>self.identities=locked,
            "payments"=>self.payments=locked,
            "bookmarks"=>self.bookmarks=locked,
            _=>return Err("Unknown lock preference".into())
        }
        Ok(())
    }
    pub fn any_unlocked_vault(&self)->bool{
        !self.logins||!self.identities||!self.payments
    }
}
fn file(app:&tauri::AppHandle)->Result<PathBuf,String>{
    app.path().app_data_dir()
        .map(|folder|folder.join("password-prompts.v1.json"))
        .map_err(|e|e.to_string())
}
pub fn load(app:&tauri::AppHandle)->Policy{
    file(app).ok().and_then(|path|fs::read(path).ok())
        .filter(|bytes|bytes.len()<2048)
        .and_then(|bytes|serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}
pub fn save(app:&tauri::AppHandle,value:&Policy)->Result<(),String>{
    let path=file(app)?;
    if let Some(folder)=path.parent(){fs::create_dir_all(folder).map_err(|e|e.to_string())?;}
    let temp=path.with_extension("tmp");
    fs::write(&temp,serde_json::to_vec(value).map_err(|e|e.to_string())?)
        .map_err(|e|e.to_string())?;
    if path.exists(){fs::remove_file(&path).map_err(|e|e.to_string())?;}
    fs::rename(&temp,&path).map_err(|e|e.to_string())
}
#[derive(Default)]
pub struct Access{
    pub logins:bool,pub identities:bool,pub payments:bool
}
impl Access{
    pub fn granted(&self,kind:&str)->bool{
        match kind{"logins"=>self.logins,"identities"=>self.identities,
          "payments"=>self.payments,_=>false}
    }
    pub fn permit(&mut self,kind:&str){
        match kind{"logins"=>self.logins=true,"identities"=>self.identities=true,
          "payments"=>self.payments=true,_=>()}
    }
    pub fn from_policy(policy:&Policy)->Self{
        Self{logins:!policy.logins,identities:!policy.identities,
             payments:!policy.payments}
    }
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn all_locks_default_on(){
        let p:Policy=serde_json::from_str("{}").unwrap();
        assert!(p.logins&&p.identities&&p.payments&&p.bookmarks);
    }
    #[test]fn scopes_remain_independent(){
        let mut p=Policy::default();
        p.set("logins",false).unwrap();
        assert!(p.any_unlocked_vault());
        let a=Access::from_policy(&p);
        assert!(a.granted("logins"));assert!(!a.granted("payments"));
        assert!(!a.granted("identities"));
        assert!(p.set("other",false).is_err());
    }
}
