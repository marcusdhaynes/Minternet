//! Per-section master-password prompts. New Windows profiles default to no prompt.
use std::{fs,path::PathBuf};
use serde::{Serialize,Deserialize};
use tauri::Manager;
#[derive(Clone,Copy,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Policy{
    #[serde(default)]pub logins:bool,
    #[serde(default)]pub identities:bool,
    #[serde(default)]pub payments:bool,
    // This controls *Secret* Bookmarks; ordinary Bookmarks are not encrypted.
    #[serde(default)]pub bookmarks:bool,
}
impl Default for Policy{
    fn default()->Self{Self{logins:false,identities:false,payments:false,bookmarks:false}}
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
    pub fn protected()->Self{Self{logins:true,identities:true,payments:true,bookmarks:true}}
    pub fn any_protected_vault(&self)->bool{self.logins||self.identities||self.payments}
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
    if !cfg!(windows){return Policy::protected();}
    let Ok(path)=file(app) else{return Policy::protected()};
    match fs::read(path){
        Ok(bytes) if bytes.len()<2048=>serde_json::from_slice(&bytes).unwrap_or_else(|_|Policy::protected()),
        Err(error) if error.kind()==std::io::ErrorKind::NotFound=>Policy::default(),
        _=>Policy::protected()
    }
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
    pub fn revoke(&mut self,kind:&str){
        match kind{"logins"=>self.logins=false,"identities"=>self.identities=false,
          "payments"=>self.payments=false,"all"=>*self=Self::default(),_=>()}
    }
    pub fn any(&self)->bool{self.logins||self.identities||self.payments}
    pub fn from_policy(policy:&Policy)->Self{
        Self{logins:!policy.logins,identities:!policy.identities,
             payments:!policy.payments}
    }
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn all_locks_default_off(){
        let p:Policy=serde_json::from_str("{}").unwrap();
        assert!(!p.logins&&!p.identities&&!p.payments&&!p.bookmarks);
        assert!(!Policy::default().any_protected_vault());
        assert!(Policy::protected().any_protected_vault());
    }
    #[test]fn scopes_remain_independent(){
        let mut p=Policy::protected();
        p.set("logins",false).unwrap();
        assert!(p.any_unlocked_vault());
        let a=Access::from_policy(&p);
        assert!(a.granted("logins"));assert!(!a.granted("payments"));
        assert!(!a.granted("identities"));
        assert!(p.set("other",false).is_err());
        let mut access=Access::from_policy(&p);
        access.permit("payments");
        access.revoke("payments");
        assert!(access.granted("logins")&&!access.granted("payments"));
        access.revoke("all");
        assert!(!access.any());
    }
}
