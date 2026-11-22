//! Recursively import WebExtensions from a user-selected ZIP, XPI, MEXT or CRX3.
//! Runs only in the trusted native extension dialog, never in website JavaScript.
//! A universal bundle may contain folders, nested archives and several browser
//! builds. Select the best compatible variant of each extension for WebView2.
//! No extension is installed until the complete archive passes safety checks.
use std::{
    collections::{BTreeMap,HashSet},
    fs, io::{Read,Cursor}, path::{Path,PathBuf,Component},
};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use tauri::AppHandle;
use zip::ZipArchive;

const MAX_INPUT:u64=64*1024*1024;
const MAX_ENTRY:u64=32*1024*1024;
const MAX_EXPANDED:u64=160*1024*1024;
const MAX_ENTRIES:usize=6000;
const MAX_ARCHIVES:usize=128;
const MAX_DEPTH:usize=8;
const MAX_MANIFEST:usize=1024*1024;
const MAX_CANDIDATES:usize=128;

struct Candidate {
    name:String,
    version:String,
    priority:u8,
    path:String,
    files:BTreeMap<String,Vec<u8>>,
}
#[derive(Default)]
struct Scan {
    expanded:u64,
    entries:usize,
    archives:usize,
    found:usize,
    candidates:Vec<Candidate>,
    skipped:Vec<String>,
}
fn safe_relative(path:&str)->Result<(),String>{
    if path.is_empty()||path.len()>2048||path.contains(':')||
       path.contains('\\')||path.starts_with('/')||path.contains('\0') {
        return Err("Archive contains an unsafe path".into());
    }
    if path.split('/').any(|part|part.is_empty()||part=="."||part==".."){
        return Err("Archive contains an ambiguous or traversal path".into());
    }
    let p=Path::new(path);
    let mut count=0usize;
    for part in p.components(){
        if !matches!(part,Component::Normal(_)){return Err("Archive contains a traversal path".into());}
        count+=1;
        if count>32{return Err("Archive path is too deep".into());}
    }
    if count==0{return Err("Archive has an empty entry path".into());}
    Ok(())
}
fn zip_bytes(bytes:&[u8])->Result<&[u8],String>{
    if bytes.starts_with(b"Cr24"){
        if bytes.len()<12{return Err("Incomplete CRX header".into());}
        let version=u32::from_le_bytes(bytes[4..8].try_into().map_err(|_|"Invalid CRX header")?);
        if version!=3{return Err("Only CRX3 is supported".into());}
        let len=u32::from_le_bytes(bytes[8..12].try_into().map_err(|_|"Invalid CRX header")?) as usize;
        let start=12usize.checked_add(len).ok_or("Invalid CRX header size")?;
        if start>=bytes.len(){return Err("Invalid CRX payload".into());}
        return Ok(&bytes[start..]);
    }
    if bytes.starts_with(b"PK\x03\x04")||bytes.starts_with(b"PK\x05\x06")||
       bytes.starts_with(b"PK\x07\x08") {return Ok(bytes);}
    Err("Selected package is not a ZIP, XPI, MEXT or CRX3 archive".into())
}
fn archive_file(name:&str)->bool{
    let n=name.to_ascii_lowercase();
    [".zip",".xpi",".mext",".crx"].iter().any(|x|n.ends_with(x))
}
fn token_path(name:&str,part:&str)->bool{
    name.split(|c:char|!c.is_ascii_alphanumeric())
        .any(|piece|piece==part)
}
fn rank(source:&str,where_found:&str,manifest:&Value)->Option<u8>{
    let text=where_found.to_ascii_lowercase();
    let firefox=token_path(&text,"firefox");
    let safari=token_path(&text,"safari");
    let minternet=token_path(&text,"minternet");
    let chrome=token_path(&text,"chrome")||token_path(&text,"chromium");
    let other_chromium=["brave","edge","opera","vivaldi"].iter()
        .any(|name|token_path(&text,name));
    let mv=manifest.get("manifest_version").and_then(Value::as_u64)?;
    if !matches!(mv,2|3){return None;}
    let background=manifest.get("background");
    let gecko_only=manifest.pointer("/browser_specific_settings/gecko").is_some()
        ||manifest.pointer("/applications/gecko").is_some();
    let firefox_background=mv==3 && background
        .and_then(|b|b.get("scripts")).is_some() &&
        background.and_then(|b|b.get("service_worker")).is_none();
    match source {
        "minternet"|"chrome" => {
            if firefox||safari||gecko_only||firefox_background{return None;}
            // Minternet currently loads through Windows WebView2 (Chromium).
            // Prefer an explicit Minternet package over Chrome-family builds.
            Some(if minternet {100} else if chrome {90}
                else if other_chromium {80} else {65})
        }
        "firefox" => {
            if safari||minternet||chrome||other_chromium{return None;}
            Some(if firefox {100} else {65})
        }
        _ => None,
    }
}
fn fingerprint(files:&BTreeMap<String,Vec<u8>>)->String{
    let mut hasher=Sha256::new();
    for (name,bytes) in files {
        hasher.update((name.len() as u64).to_le_bytes());
        hasher.update(name.as_bytes());
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(bytes);
    }
    format!("{:x}",hasher.finalize())[..24].to_owned()
}
fn consider(scan:&mut Scan,source:&str,where_found:String,
            files:BTreeMap<String,Vec<u8>>,manifest:&Value) {
    scan.found+=1;
    let Some(name)=manifest.get("name").and_then(Value::as_str)
        .map(str::trim).filter(|x|!x.is_empty()&&x.len()<=240)
        else {scan.skipped.push(format!("{where_found}: missing extension name"));return;};
    let Some(version)=manifest.get("version").and_then(Value::as_str)
        .map(str::trim).filter(|x|!x.is_empty()&&x.len()<=60)
        else {scan.skipped.push(format!("{where_found}: missing extension version"));return;};
    let Some(priority)=rank(source,&where_found,manifest) else {
        scan.skipped.push(format!("{where_found}: incompatible browser variant"));
        return;
    };
    let key=name.to_lowercase();
    let candidate=Candidate{name:name.into(),version:version.into(),
        priority,path:where_found,files};
    if let Some(pos)=scan.candidates.iter().position(|c|c.name.to_lowercase()==key){
        let old=&scan.candidates[pos];
        // Favor a Minternet-specific package over generic Chromium; use
        // a deterministic path tie-break for repeatable results.
        if priority>old.priority ||
           (priority==old.priority && candidate.path<old.path){
            scan.candidates[pos]=candidate;
        }
    }else if scan.candidates.len()<MAX_CANDIDATES{
        scan.candidates.push(candidate);
    }else{
        scan.skipped.push("Archive has too many extension manifests".into());
    }
}
fn discover(bytes:&[u8],location:&str,depth:usize,source:&str,
            scan:&mut Scan)->Result<(),String>{
    if depth>MAX_DEPTH{return Err("Too many nested ZIP levels (maximum 8)".into());}
    scan.archives+=1;
    if scan.archives>MAX_ARCHIVES{return Err("Too many nested archives".into());}
    let body=zip_bytes(bytes)?;
    let mut archive=ZipArchive::new(Cursor::new(body))
        .map_err(|_|format!("Invalid extension archive at {location}"))?;
    scan.entries=scan.entries.checked_add(archive.len()).ok_or("Archive entry count overflow")?;
    if scan.entries>MAX_ENTRIES{return Err("Archive has too many entries".into());}
    let mut files=BTreeMap::<String,Vec<u8>>::new();
    for index in 0..archive.len(){
        let mut entry=archive.by_index(index).map_err(|e|e.to_string())?;
        let raw_name=entry.name().trim_end_matches('/');
        safe_relative(raw_name)?;
        if let Some(mode)=entry.unix_mode(){
            if mode&0o170000==0o120000{return Err("Archive symlinks are forbidden".into());}
        }
        if entry.is_dir(){continue;}
        if entry.size()>MAX_ENTRY{return Err("Archive contains an oversized file".into());}
        // Count uncompressed bytes across *all* nested archives, not only a
        // single ZIP. A size forged in the ZIP header cannot evade the read cap.
        scan.expanded=scan.expanded.checked_add(entry.size())
            .ok_or("Archive size overflow")?;
        if scan.expanded>MAX_EXPANDED{return Err("Nested archive expansion exceeds 160 MB".into());}
        let mut payload=Vec::new();
        entry.by_ref().take(MAX_ENTRY+1).read_to_end(&mut payload)
            .map_err(|e|e.to_string())?;
        if payload.len() as u64>MAX_ENTRY{return Err("Archive file exceeds 32 MB".into());}
        if files.insert(raw_name.to_owned(),payload).is_some(){
            return Err("Duplicate path within extension archive".into());
        }
    }
    // Nested archives can live anywhere. Keep their original bytes in case
    // they are resources of a root extension; recurse only on archive names.
    for (name,data) in &files{
        if !archive_file(name){continue;}
        if zip_bytes(data).is_err(){
            scan.skipped.push(format!("{location}/{name}: invalid nested archive"));
            continue;
        }
        discover(data,&format!("{location}/{name}!"),depth+1,source,scan)?;
    }
    let manifests=files.keys().filter(|p|p=="manifest.json"||p.ends_with("/manifest.json"))
        .cloned().collect::<Vec<_>>();
    for path in manifests{
        let Some(data)=files.get(&path) else{continue;};
        if data.len()>MAX_MANIFEST{
            scan.skipped.push(format!("{location}/{path}: oversized manifest"));continue;
        }
        let Ok(manifest)=serde_json::from_slice::<Value>(data) else{
            scan.skipped.push(format!("{location}/{path}: invalid manifest JSON"));continue;
        };
        let root=path.strip_suffix("manifest.json").unwrap_or("");
        let mut resources=BTreeMap::new();
        for (name,bytes) in &files {
            if let Some(relative)=name.strip_prefix(root){
                if !relative.is_empty(){resources.insert(relative.to_owned(),bytes.clone());}
            }
        }
        consider(scan,source,format!("{location}/{path}"),resources,&manifest);
    }
    Ok(())
}
fn installed_names(active:&Path)->HashSet<String>{
    let mut names=HashSet::new();
    let Some(parent)=active.parent() else{return names;};
    for folder in ["installed","disabled"]{
        let Ok(entries)=fs::read_dir(parent.join(folder)) else{continue;};
        for entry in entries.flatten(){
            if !entry.file_type().map(|t|t.is_dir()&&!t.is_symlink()).unwrap_or(false){continue;}
            if let Ok(bytes)=fs::read(entry.path().join("manifest.json")){
                if let Ok(manifest)=serde_json::from_slice::<Value>(&bytes){
                    if let Some(name)=manifest.get("name").and_then(Value::as_str){
                        names.insert(name.to_lowercase());
                    }
                }
            }
        }
    }
    names
}
fn install(active:&Path,source:&str,candidate:&Candidate)->Result<Value,String>{
    let id=fingerprint(&candidate.files);
    let folder=format!("{source}-{id}");
    let destination=active.join(&folder);
    let disabled=active.parent().ok_or("Invalid extensions directory")?.join("disabled");
    if destination.exists()||disabled.join(&folder).exists(){
        return Err("Already imported".into());
    }
    let staging_root=active.parent().ok_or("Invalid extensions directory")?.join("staging");
    fs::create_dir_all(&staging_root).map_err(|e|e.to_string())?;
    let staging=staging_root.join(format!(".import-{folder}"));
    fs::create_dir(&staging).map_err(|e|format!("Cannot stage extension: {e}"))?;
    let result=(||->Result<Value,String>{
        for (name,bytes) in &candidate.files{
            safe_relative(name)?;
            let target=staging.join(name);
            if let Some(parent)=target.parent(){fs::create_dir_all(parent).map_err(|e|e.to_string())?;}
            fs::write(target,bytes).map_err(|e|e.to_string())?;
        }
        if !staging.join("manifest.json").is_file(){
            return Err("Extension manifest was not extracted".into());
        }
        fs::rename(&staging,&destination).map_err(|e|e.to_string())?;
        Ok(json!({"id":id,"source":source,"name":candidate.name,
            "version":candidate.version,"enabled":true,"restartRequired":true,
            "nativeMediaServer":false,"packagePath":candidate.path}))
    })();
    if result.is_err(){let _=fs::remove_dir_all(&staging);}
    result
}
pub fn import(app:&AppHandle,source:&str,path:&Path)->Result<Value,String>{
    if !matches!(source,"minternet"|"firefox"|"chrome"){
        return Err("Unknown extension source".into());
    }
    let size=fs::metadata(path).map_err(|e|e.to_string())?.len();
    if size==0||size>MAX_INPUT{return Err("Extension archive must be under 64 MB".into());}
    let file=path.file_name().and_then(|n|n.to_str()).unwrap_or("").to_lowercase();
    if !archive_file(&file){return Err("Select a ZIP, MEXT, XPI or CRX file".into());}
    let bytes=fs::read(path).map_err(|e|e.to_string())?;
    let mut scan=Scan::default();
    // Validate and discover every nested archive before touching installed files.
    discover(&bytes,&file,0,source,&mut scan)?;
    if scan.candidates.is_empty(){
        return Err(format!("No compatible WebExtension found in this archive ({} manifests checked)",scan.found));
    }
    let active=super::extensions::active_dir(app)?;
    fs::create_dir_all(&active).map_err(|e|e.to_string())?;
    let mut known=installed_names(&active);
    scan.candidates.sort_by(|a,b|a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    let mut imported=Vec::new();
    for candidate in &scan.candidates{
        if known.contains(&candidate.name.to_lowercase()){
            scan.skipped.push(format!("{}: already installed; existing extension preserved",candidate.name));
            continue;
        }
        match install(&active,source,candidate){
            Ok(info)=>{known.insert(candidate.name.to_lowercase());imported.push(info);}
            Err(error)=>scan.skipped.push(format!("{}: {error}",candidate.name)),
        }
    }
    Ok(json!({"extensions":imported,"skipped":scan.skipped,
        "manifestsFound":scan.found,"archivesScanned":scan.archives,
        "restartRequired":!imported.is_empty()}))
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn validates_portable_paths(){
        assert!(safe_relative("sub/manifest.json").is_ok());
        assert!(safe_relative("../escape.js").is_err());
        assert!(safe_relative("C:/evil.js").is_err());
        assert!(safe_relative("x\\evil.js").is_err());
        assert!(safe_relative("/etc/passwd").is_err());
    }
    fn make_zip(entries:Vec<(&str,Vec<u8>)>)->Vec<u8>{
        use std::io::Write;
        let mut zip=zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name,contents) in entries{
            zip.start_file(name,zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(&contents).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }
    #[test]
    fn recursively_finds_best_variant_and_other_extensions(){
        let first=br#"{"name":"Marmalade Library","version":"0.3","manifest_version":3}"#.to_vec();
        let second=br#"{"name":"Other Tool","version":"1","manifest_version":3}"#.to_vec();
        let inner_minternet=make_zip(vec![
            ("nested/source/manifest.json",first.clone()),
            ("nested/source/content.js",b"self.ready=true;".to_vec())
        ]);
        let inner_chrome=make_zip(vec![("manifest.json",first.clone())]);
        let inner_firefox=make_zip(vec![("manifest.json",first)]);
        let extra=make_zip(vec![("manifest.json",second)]);
        let middle=make_zip(vec![
            ("archives/marmalade-library-minternet.zip",inner_minternet),
            ("archives/marmalade-library-chrome.zip",inner_chrome),
            ("archives/marmalade-library-firefox.zip",inner_firefox),
            ("archives/second-extension.zip",extra)
        ]);
        let outer=make_zip(vec![("deeply/bundled.zip",middle)]);
        let mut scan=Scan::default();
        discover(&outer,"universal.zip",0,"minternet",&mut scan).unwrap();
        assert_eq!(scan.candidates.len(),2);
        let chosen=scan.candidates.iter()
            .find(|candidate|candidate.name=="Marmalade Library").unwrap();
        assert!(chosen.path.contains("minternet.zip"));
        assert!(chosen.files.contains_key("content.js"));
        assert!(chosen.files.contains_key("manifest.json"));
        assert!(!chosen.files.contains_key("nested/source/manifest.json"));
        assert!(scan.found>=4);
    }
    #[test]
    fn detects_unsafe_nested_archives_before_installing(){
        let inner=make_zip(vec![("../unsafe/manifest.json",b"{}".to_vec())]);
        let outer=make_zip(vec![("child.zip",inner)]);
        let mut scan=Scan::default();
        assert!(discover(&outer,"bundle.zip",0,"minternet",&mut scan).is_err());
    }
    #[test]
    fn prefers_minternet_over_other_browser_variants(){
        let manifest=json!({"name":"Example","version":"1","manifest_version":3});
        assert!(rank("minternet","bundle/firefox/example.zip",&manifest).is_none());
        assert!(rank("minternet","bundle/safari/example.zip",&manifest).is_none());
        assert!(rank("minternet","bundle/minternet/example.zip",&manifest)>
                rank("minternet","bundle/chrome/example.zip",&manifest));
    }
}
