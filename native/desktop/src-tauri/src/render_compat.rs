//! Optional, reversible WebView2 GPU troubleshooting mode.
//! Microsoft recommends keeping acceleration ON normally. Affected devices
//! can disable it for the next process launch without touching browser data.
#![cfg(windows)]
use std::{fs,path::PathBuf,sync::OnceLock};
use serde_json::{json,Value};
use tauri::Manager;
static CURRENT:OnceLock<bool>=OnceLock::new();
fn file(app:&tauri::AppHandle)->Result<PathBuf,String>{
  app.path().app_data_dir().map(|p|p.join("render-compat.v1.json"))
    .map_err(|e|format!("Cannot locate browser settings: {e}"))
}
fn decode(bytes:&[u8])->bool{
  if bytes.len()>1024{return false;}
  serde_json::from_slice::<Value>(bytes).ok()
    .and_then(|v|v.get("softwareRendering")?.as_bool()).unwrap_or(false)
}
fn configured(app:&tauri::AppHandle)->bool{
  file(app).ok().and_then(|p|fs::read(p).ok())
    .is_some_and(|content|decode(&content))
}
pub fn configure(app:&tauri::AppHandle){
  let enabled=configured(app);
  let _=CURRENT.set(enabled);
  if enabled{
    // Only the narrowly scoped performance-troubleshooting switch is
    // appended. Do not override existing user or enterprise browser flags.
    let current=std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
      .unwrap_or_default();
    if !current.split_whitespace().any(|flag|flag=="--disable-gpu"){
      let flags=if current.trim().is_empty(){"--disable-gpu".to_string()}
        else{format!("{} --disable-gpu",current.trim())};
      std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",flags);
    }
  }
}
pub fn status(app:&tauri::AppHandle)->Value{
  json!({"supported":true,"saved":configured(app),
    "current":*CURRENT.get().unwrap_or(&false),
    "restartRequired":configured(app)!=*CURRENT.get().unwrap_or(&false),
    "profileChanged":false})
}
pub fn save(app:&tauri::AppHandle,enable:bool)->Result<Value,String>{
  let target=file(app)?;
  let folder=target.parent().ok_or("Settings folder missing")?;
  fs::create_dir_all(folder).map_err(|e|format!("Cannot open settings: {e}"))?;
  let temporary=target.with_extension("tmp");
  fs::write(&temporary,if enable {
    r#"{"softwareRendering":true}"#
  }else{r#"{"softwareRendering":false}"#})
    .map_err(|e|format!("Cannot save rendering setting: {e}"))?;
  // Windows RenameFile does not overwrite; remove only this dedicated
  // non-sensitive settings file, NEVER the WebView2 user data directory.
  if target.exists(){fs::remove_file(&target)
     .map_err(|e|format!("Cannot update rendering setting: {e}"))?;}
  fs::rename(temporary,target)
    .map_err(|e|format!("Cannot commit rendering setting: {e}"))?;
  Ok(status(app))
}
#[cfg(test)]
mod tests{
 use super::*;
 #[test]fn defaults_to_hardware_acceleration(){
   assert!(!decode(b""));
   assert!(!decode(b"{broken"));
   assert!(!decode(br#"{"softwareRendering":false}"#));
   assert!(decode(br#"{"softwareRendering":true}"#));
 }
 #[test]fn never_accepts_arbitrary_command_line_flags(){
   assert!(!decode(br#"{"disableWebSecurity":true}"#));
   assert!(!decode(br#"{"softwareRendering":"--disable-web-security"}"#));
 }
}
