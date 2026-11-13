//! Local extension packages selected by the user. Never let page JavaScript
//! choose a path or access the extension store. WebView2 loads supported
//! unpacked extensions only in an isolated website data directory on Windows.
use std::{fs,io::{self,Read,Cursor},path::{Path,PathBuf,Component}};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use tauri::{AppHandle,Manager};
use zip::ZipArchive;

const MAX_COMPRESSED:u64=48*1024*1024;
const MAX_TOTAL:u64=160*1024*1024;
const MAX_ENTRY:u64=32*1024*1024;
const MAX_ENTRIES:usize=3000;

pub fn active_dir(app:&AppHandle)->Result<PathBuf,String>{
    Ok(app.path().app_data_dir().map_err(|e|e.to_string())?
        .join("extensions").join("installed"))
}
fn disabled_dir(app:&AppHandle)->Result<PathBuf,String>{
    Ok(app.path().app_data_dir().map_err(|e|e.to_string())?
        .join("extensions").join("disabled"))
}
pub fn any_enabled(app:&AppHandle)->bool{
    let Ok(dir)=active_dir(app) else{return false};
    fs::read_dir(dir).map(|entries|entries.flatten().any(|e|
        e.path().is_dir()&&e.path().join("manifest.json").is_file()))
        .unwrap_or(false)
}
pub fn isolated_site_dir(app:&AppHandle)->Result<PathBuf,String>{
    Ok(app.path().app_local_data_dir().map_err(|e|e.to_string())?
        .join("extension-sites"))
}
fn source_ok(source:&str)->bool{matches!(source,"minternet"|"firefox"|"chrome")}
fn extension_id_ok(id:&str)->bool{id.len()==24 && id.bytes().all(|b|b.is_ascii_hexdigit())}
fn metadata(dir:&Path,source:&str,enabled:bool,id:String)->Option<Value>{
    let manifest:Value=serde_json::from_slice(&fs::read(dir.join("manifest.json")).ok()?).ok()?;
    let name=manifest.get("name")?.as_str()?.chars().take(120).collect::<String>();
    let version=manifest.get("version")?.as_str()?.chars().take(50).collect::<String>();
    Some(json!({"id":id,"source":source,"name":name,"version":version,
        "enabled":enabled,"restartRequired":true,
        "permissions":manifest.get("permissions").and_then(Value::as_array)
            .map(|v|v.iter().filter_map(Value::as_str)
                 .take(20).collect::<Vec<_>>()).unwrap_or_default()}))
}
pub fn list(app:&AppHandle)->Result<Value,String>{
    let mut entries=Vec::new();
    for (root,enabled) in [(active_dir(app)?,true),(disabled_dir(app)?,false)]{
        if !root.is_dir(){continue;}
        for entry in fs::read_dir(root).map_err(|e|e.to_string())?.flatten(){
            let Ok(kind)=entry.file_type() else{continue};
            if !kind.is_dir() || kind.is_symlink(){continue;}
            let name=entry.file_name().to_string_lossy().to_string();
            let mut parts=name.splitn(2,'-');
            let source=parts.next().unwrap_or("");
            let id=parts.next().unwrap_or("");
            if !source_ok(source)||!extension_id_ok(id){continue;}
            if let Some(record)=metadata(&entry.path(),source,enabled,id.into()){
                entries.push(record);
            }
        }
    }
    Ok(json!({"extensions":entries,"platformSupported":cfg!(windows),
        "restartRequired":true}))
}
fn parse_package(source:&str,path:&Path)->Result<(String,String,Vec<u8>),String>{
    if !source_ok(source){return Err("Unknown extension source".into());}
    let size=fs::metadata(path).map_err(|e|e.to_string())?.len();
    if size==0||size>MAX_COMPRESSED{return Err("Extension package must be under 48 MB".into());}
    let bytes=fs::read(path).map_err(|e|e.to_string())?;
    let filename=path.file_name().and_then(|n|n.to_str()).unwrap_or("").to_lowercase();
    let valid=match source{
        "minternet"=>filename.ends_with(".mext")||filename.ends_with(".zip"),
        "firefox"=>filename.ends_with(".xpi")||filename.ends_with(".zip"),
        "chrome"=>filename.ends_with(".crx")||filename.ends_with(".zip"),
        _=>false
    };
    if !valid{return Err("Choose a supported extension package for this source".into());}
    let offset=if bytes.starts_with(b"Cr24"){
        if source!="chrome"||bytes.len()<16{
            return Err("Invalid Chrome CRX package".into());
        }
        let version=u32::from_le_bytes(bytes[4..8].try_into().unwrap());
        if version!=3{return Err("Only CRX3 and ZIP extension packages are supported".into());}
        let header=u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
        12usize.checked_add(header).filter(|n|*n<bytes.len())
            .ok_or("Invalid Chrome package header")?
    }else{0};
    let mut digest=Sha256::new();
    digest.update(&bytes);
    let id=format!("{:x}",digest.finalize());
    Ok((filename,id[..24].into(),bytes[offset..].to_vec()))
}
fn path_checked(path:&Path)->Result<(),String>{
    if path.components().all(|part|matches!(part,Component::Normal(_)))
        && path.components().count()>0 {Ok(())}
    else {Err("Extension archive contains an unsafe path".into())}
}
fn import_package(app:&AppHandle,source:&str,path:&Path)->Result<Value,String>{
    let (_name,id,bytes)=parse_package(source,path)?;
    let folder=format!("{source}-{id}");
    let active=active_dir(app)?;
    let disabled=disabled_dir(app)?;
    fs::create_dir_all(&active).map_err(|e|e.to_string())?;
    if active.join(&folder).exists()||disabled.join(&folder).exists(){
        return Err("This extension is already imported".into());
    }
    let staging=active.join(format!(".import-{folder}"));
    if staging.exists(){return Err("An import is already in progress".into());}
    fs::create_dir(&staging).map_err(|e|e.to_string())?;
    let result=(||{
        let mut zip=ZipArchive::new(Cursor::new(bytes))
            .map_err(|_|"Package is not a valid ZIP/CRX3/XPI archive")?;
        if zip.len()>MAX_ENTRIES{return Err("Extension contains too many files".into());}
        let mut total=0u64;
        for i in 0..zip.len(){
            let mut entry=zip.by_index(i).map_err(|e|e.to_string())?;
            if let Some(mode)=entry.unix_mode(){
                if mode&0o170000==0o120000 {
                    return Err("Archive links are not allowed".into());
                }
            }
            let relative=entry.enclosed_name().ok_or("Unsafe archive entry")?.to_path_buf();
            path_checked(&relative)?;
            if entry.size()>MAX_ENTRY{return Err("Extension entry exceeds 32 MB".into());}
            total=total.checked_add(entry.size()).ok_or("Extension too large")?;
            if total>MAX_TOTAL{return Err("Unpacked extension exceeds 160 MB".into());}
            let destination=staging.join(relative);
            if entry.is_dir(){fs::create_dir_all(destination).map_err(|e|e.to_string())?;continue;}
            if let Some(parent)=destination.parent(){
                fs::create_dir_all(parent).map_err(|e|e.to_string())?;
            }
            let mut output=fs::File::create(&destination).map_err(|e|e.to_string())?;
            io::copy(&mut entry,&mut output).map_err(|e|e.to_string())?;
        }
        let root=if staging.join("manifest.json").is_file(){staging.clone()}else{
            let directories=fs::read_dir(&staging).map_err(|e|e.to_string())?
                .flatten().filter(|p|p.path().is_dir()).map(|p|p.path())
                .collect::<Vec<_>>();
            if directories.len()!=1 || !directories[0].join("manifest.json").is_file(){
                return Err("The package must contain a WebExtension manifest.json".into());
            }
            directories[0].clone()
        };
        let manifest:Value=serde_json::from_slice(&fs::read(root.join("manifest.json"))
            .map_err(|e|e.to_string())?).map_err(|_|"Invalid manifest.json")?;
        let version=manifest.get("manifest_version").and_then(Value::as_u64).unwrap_or(0);
        if !matches!(version,2|3){return Err("Manifest V2 or V3 required".into());}
        if manifest.get("name").and_then(Value::as_str).filter(|n|!n.is_empty()).is_none()
          || manifest.get("version").and_then(Value::as_str).filter(|n|!n.is_empty()).is_none(){
            return Err("Extension name and version are required".into());
        }
        let final_dir=active.join(&folder);
        if root==staging{
            fs::rename(&staging,&final_dir).map_err(|e|e.to_string())?;
        }else{
            fs::rename(&root,&final_dir).map_err(|e|e.to_string())?;
        }
        metadata(&final_dir,source,true,id).ok_or("Extension metadata missing".into())
    })();
    let _=fs::remove_dir_all(&staging);
    result
}
pub fn import(app:&AppHandle,source:&str,path:&Path)->Result<Value,String>{
    if !cfg!(windows){return Err("Extension loading currently requires Windows WebView2".into());}
    import_package(app,source,path)
}
pub fn set_enabled(app:&AppHandle,source:&str,id:&str,enabled:bool)->Result<Value,String>{
    if !source_ok(source)||!extension_id_ok(id){return Err("Invalid extension identifier".into());}
    let folder=format!("{source}-{id}");
    let from=if enabled{disabled_dir(app)?}else{active_dir(app)?};
    let to=if enabled{active_dir(app)?}else{disabled_dir(app)?};
    let path=from.join(&folder);
    if !path.join("manifest.json").is_file(){return Err("Extension not found".into());}
    fs::create_dir_all(&to).map_err(|e|e.to_string())?;
    if to.join(&folder).exists(){return Err("Extension already exists".into());}
    fs::rename(path,to.join(folder)).map_err(|e|e.to_string())?;
    Ok(json!({"ok":true,"restartRequired":true}))
}
pub fn remove(app:&AppHandle,source:&str,id:&str)->Result<Value,String>{
    if !source_ok(source)||!extension_id_ok(id){return Err("Invalid extension identifier".into());}
    let folder=format!("{source}-{id}");
    let dir=[active_dir(app)?,disabled_dir(app)?].into_iter()
        .map(|root|root.join(&folder))
        .find(|path|path.join("manifest.json").is_file())
        .ok_or("Extension not found")?;
    fs::remove_dir_all(dir).map_err(|e|e.to_string())?;
    Ok(json!({"ok":true,"restartRequired":true}))
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn rejects_unsafe_extension_ids_and_paths(){
        assert!(!extension_id_ok("../Windows/System32"));
        assert!(!extension_id_ok("a".repeat(23).as_str()));
        assert!(extension_id_ok("0123456789abcdef01234567"));
        assert!(path_checked(Path::new("manifest.json")).is_ok());
        assert!(path_checked(Path::new("../evil.js")).is_err());
        assert!(path_checked(Path::new("C:/evil.js")).is_err());
        assert!(!source_ok("other"));
    }
}
