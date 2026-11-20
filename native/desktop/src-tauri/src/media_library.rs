//! Marmalade media library for Minternet (native desktop, Tauri 2).
//!
//! WHY THIS MODULE EXISTS
//! Minternet is Marcus's own browser, so it does not have to live inside
//! the web permission model. This module stores the actual folder PATHS in
//! Minternet's native app data (`media-library.v1.json` in app_data_dir)
//! and rescans them with real filesystem access on startup and on demand.
//! There is no directory handle, no permission prompt, and nothing that
//! expires: after a folder is added once, it NEVER needs to be reconnected
//! or re-picked. That is the Plex Media Server model, implemented inside
//! the browser Marcus owns instead of as a separate program.
//!
//! This is LOCAL filesystem data only. Per Minternet's AGENTS.md house
//! rule it introduces no cloud backend at all (no Firebase, no Supabase):
//! nothing here leaves the machine.
//!
//! EXPOSURE RULE (matches Minternet's capability design): remote web pages
//! receive NO Tauri capabilities. The trusted chrome UI owns these
//! commands. The chrome injects the read-only catalog bridge
//! (`window.MarmaladeNativeLibrary`) ONLY into tabs whose URL is exactly
//! marmaladeum.com or the MarmaladePlayer GitHub Pages path, mirroring how
//! the password vault autofills only on an opted-in exact origin. Playback
//! is served to that tab through Tauri's asset protocol scope extended at
//! runtime to the registered library folders (protocol-asset is already a
//! Cargo feature), never by handing raw paths to arbitrary sites.
//!
//! INTEGRATION (native/desktop/src-tauri/src/main.rs):
//!   mod media_library;
//!   .manage(Mutex::new(media_library::MediaLibrary::default()))
//!   // in setup(): load + startup rescan
//!   if let Ok(mut lib) = app.state::<Mutex<media_library::MediaLibrary>>().lock() {
//!       *lib = media_library::MediaLibrary::load(app.handle());
//!       lib.rescan_all();
//!       let _ = lib.save(app.handle());
//!   }
//!   // route in browser_action, like site-media-*:
//!   if matches!(name.as_str(),
//!       "media-library-get" | "media-library-add-folder" |
//!       "media-library-remove-folder" | "media-library-rescan") {
//!       return media_library::action(app, &name, &value);
//!   }
//! The chrome's folder add uses the already-present tauri-plugin-dialog
//! folder picker, so the ONE user interaction is choosing the folder in a
//! native dialog. After that: zero reconnects, forever, on every platform
//! the Tauri shell ships (Windows/macOS/Linux). Android/iOS Minternet
//! shells need the equivalent Kotlin/Swift module; the JSON schema below is
//! the shared contract.

use std::{fs, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}, collections::BTreeMap};
use serde_json::Value;
use serde::{Deserialize, Serialize};
use tauri::Manager;
use rand::RngCore;

pub const VIDEO_EXTENSIONS: &[&str] = &[
    "3g2", "3gp", "asf", "avi", "divx", "f4v", "flv", "m1v", "m2ts", "m4v",
    "mkv", "mov", "mp4", "mpe", "mpeg", "mpg", "mts", "ogv", "qt", "rm",
    "rmvb", "ts", "vob", "webm", "wmv",
];
const IGNORE_DIRS: &[&str] = &[".git", "node_modules", "$recycle.bin", "system volume information", "__macosx"];
const MAX_ITEMS: usize = 100_000;
const MAX_DEPTH: usize = 24;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFolder {
    pub id: String,
    /// Absolute filesystem path. Storing the PATH (not a browser handle)
    /// is the entire point: native code can re-read it on every launch.
    pub path: String,
    pub name: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    pub id: String, // folderId + "|" + relative path
    pub folder_id: String,
    /// Path relative to the folder root, '/'-separated. A file directly in
    /// the root has its bare filename here.
    pub path: String,
    pub name: String,
    pub size: u64,
    pub last_modified: u64,
    pub title: String,
    pub year: Option<u32>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct LibraryCollection {
    pub id:String,
    pub name:String,
    pub kind:String,
    #[serde(default)]
    pub folder_ids:Vec<String>,
    #[serde(default)]
    pub hidden_ids:Vec<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaLibrary {
    pub folders: Vec<LibraryFolder>,
    pub items: Vec<LibraryItem>,
    pub last_scan: u64,
    #[serde(default)]
    pub collections:Vec<LibraryCollection>,
    #[serde(default)]
    pub overrides:BTreeMap<String,Value>,
}

pub fn file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?
        .join("media-library.v1.json"))
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|x| x.as_secs()).unwrap_or(0)
}

pub fn is_video(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str())
        .map(|e| VIDEO_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

fn title_of(name: &str) -> (String, Option<u32>) {
    let stem = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name);
    let clean = stem.replace(['.', '_'], " ");
    let mut year = None;
    for token in clean.split_whitespace() {
        let t = token.trim_matches(|c| c == '(' || c == ')' || c == '[' || c == ']');
        if t.len() == 4 {
            if let Ok(y) = t.parse::<u32>() {
                if (1900..=2099).contains(&y) { year = Some(y); }
            }
        }
    }
    (clean.split_whitespace().collect::<Vec<_>>().join(" "), year)
}

/// Recursive scan of one registered folder. Missing/unreadable folders
/// yield zero items but are KEPT in the registry — a disconnected external
/// drive must never silently delete the user's library or force a re-add
/// when it comes back.
pub fn scan_folder(folder: &LibraryFolder) -> Vec<LibraryItem> {
    let root = Path::new(&folder.path);
    let mut items = Vec::new();
    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > MAX_DEPTH { continue; }
        let Ok(read) = fs::read_dir(&dir) else { continue };
        for entry in read.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') { continue; }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                if IGNORE_DIRS.contains(&name.to_lowercase().as_str()) { continue; }
                stack.push((path, depth + 1));
            } else if kind.is_file() && is_video(&path) {
                let rel = path.strip_prefix(root).unwrap_or(&path)
                    .to_string_lossy().replace('\\', "/");
                let meta = entry.metadata().ok();
                let (title, year) = title_of(&name);
                items.push(LibraryItem {
                    id: format!("{}|{}", folder.id, rel),
                    folder_id: folder.id.clone(),
                    path: rel,
                    name,
                    size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                    last_modified: meta.as_ref()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_secs()).unwrap_or(0),
                    title, year,
                });
                if items.len() >= MAX_ITEMS { return items; }
            }
        }
    }
    items.sort_by(|a, b| a.path.cmp(&b.path));
    items
}

impl MediaLibrary {
    pub fn load(app: &tauri::AppHandle) -> Self {
        let Ok(path) = file(app) else { return Self::default() };
        let Ok(data) = fs::read(path) else { return Self::default() };
        let mut result=serde_json::from_slice::<Self>(&data).unwrap_or_default();
        // Migrate the original single-library format without dropping its
        // registered native folders or requiring another user permission.
        if result.collections.is_empty() && !result.folders.is_empty(){
            result.collections.push(LibraryCollection{
                id:"minternet-media".into(),name:"Media Library".into(),
                kind:"mixed".into(),
                folder_ids:result.folders.iter().map(|f|f.id.clone()).collect(),
                hidden_ids:Vec::new(),
            });
        }
        result
    }

    pub fn save(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let path = file(app)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let bytes = serde_json::to_vec(self).map_err(|e| e.to_string())?;
        let temp = path.with_extension("tmp");
        fs::write(&temp, bytes).map_err(|e| e.to_string())?;
        if fs::rename(&temp, &path).is_err() {
            fs::copy(&temp, &path).map_err(|e| e.to_string())?;
            let _ = fs::remove_file(&temp);
        }
        Ok(())
    }

    /// Startup / on-demand rescan of every registered folder path.
    /// No permission request exists in this path — that is the feature.
    pub fn rescan_all(&mut self) {
        let mut items = Vec::new();
        for folder in &self.folders {
            let root=Path::new(&folder.path);
            if root.is_dir()&&fs::read_dir(root).is_ok(){
                items.extend(scan_folder(folder));
            }else{
                // Preserve the last known catalog if an external drive is
                // unplugged or permission is temporarily denied. Never force
                // users to re-add folders after reconnecting the drive.
                items.extend(self.items.iter()
                    .filter(|item|item.folder_id==folder.id).cloned());
            }
        }
        self.items = items;
        self.last_scan = now_secs();
    }

    pub fn create_or_update_collection(&mut self, id:Option<&str>,
        name:&str,kind:&str)->Result<String,String>{
        let name=name.trim();
        if name.is_empty()||name.chars().count()>80{return Err("Library name must contain 1–80 characters".into());}
        if !matches!(kind,"movie"|"tv"|"mixed"){return Err("Choose a valid library type".into());}
        if self.collections.iter().any(|c|c.name.eq_ignore_ascii_case(name)&&Some(c.id.as_str())!=id){
            return Err("A library with this name already exists".into());
        }
        if let Some(id)=id {
            let existing=self.collections.iter_mut().find(|c|c.id==id)
                .ok_or("Library was not found")?;
            existing.name=name.into();existing.kind=kind.into();
            return Ok(existing.id.clone());
        }
        // Stable opaque identifier; IDs are never paths or user data.
        let mut bytes=[0u8;16];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        let id=format!("ml{}",bytes.iter().map(|b|format!("{b:02x}")).collect::<String>());
        self.collections.push(LibraryCollection{
            id:id.clone(),name:name.into(),kind:kind.into(),
            folder_ids:Vec::new(),hidden_ids:Vec::new()
        });
        Ok(id)
    }
    pub fn add_folder_to(&mut self, path:&str, library_id:&str)->Result<LibraryFolder,String>{
        if !self.collections.iter().any(|l|l.id==library_id){
            return Err("Create a library in Marmaladeum first".into());
        }
        let canonical=Path::new(path).canonicalize().map_err(|e|e.to_string())?;
        if !canonical.is_dir(){return Err("Choose an existing media folder".into());}
        if let Some(existing)=self.folders.iter().find(|f|Path::new(&f.path)==canonical){
            return Err(format!("Folder is already registered: {}",existing.name));
        }
        let mut bytes=[0u8;16];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        let folder=LibraryFolder {
            id:format!("mf{}",bytes.iter().map(|b|format!("{b:02x}")).collect::<String>()),
            path:canonical.to_string_lossy().into_owned(),
            name:canonical.file_name().map(|n|n.to_string_lossy().into_owned())
                .unwrap_or_else(||"Video Folder".into()),
        };
        self.folders.push(folder.clone());
        if let Some(l)=self.collections.iter_mut().find(|l|l.id==library_id){
            l.folder_ids.push(folder.id.clone());
        }
        self.rescan_all();
        Ok(folder)
    }
    pub fn remove_folder(&mut self,folder_id:&str){
        self.folders.retain(|f|f.id!=folder_id);
        self.items.retain(|i|i.folder_id!=folder_id);
        self.overrides.retain(|id,_|!id.starts_with(&format!("{folder_id}|")));
        for l in &mut self.collections{l.folder_ids.retain(|f|f!=folder_id);}
    }
    pub fn remove_collection(&mut self,id:&str)->Result<(),String>{
        let collection=self.collections.iter().find(|c|c.id==id)
            .ok_or("Library not found")?;
        let folders=collection.folder_ids.clone();
        self.collections.retain(|c|c.id!=id);
        for folder_id in folders {
            if !self.collections.iter().any(|c|c.folder_ids.contains(&folder_id)){
                self.remove_folder(&folder_id);
            }
        }
        Ok(())
    }
    pub fn update_item(&mut self,library_id:&str,item_id:&str,changes:Value)->Result<(),String>{
        let collection=self.collections.iter_mut().find(|c|c.id==library_id)
            .ok_or("Library not found")?;
        let item=self.items.iter().find(|i|i.id==item_id)
            .ok_or("Video not found")?;
        if !collection.folder_ids.contains(&item.folder_id){
            return Err("This video does not belong to the selected library".into());
        }
        let obj=changes.as_object().ok_or("Invalid media changes")?;
        let allowed_fields=["title","year","type","show","season","episode",
            "poster","overview","favorite","watched","watchlist","playlists",
            "collections","runtimeSec","metadataSource","customized","analyzedAt",
            "posterCustomized"];
        if let Some(hidden)=obj.get("hidden").and_then(Value::as_bool){
            if hidden {
                if !collection.hidden_ids.contains(&item_id.to_string()){
                    collection.hidden_ids.push(item_id.into());
                }
            }else{collection.hidden_ids.retain(|id|id!=item_id);}
        }
        let saved=self.overrides.entry(item_id.into()).or_insert_with(||Value::Object(Default::default()));
        if let Some(target)=saved.as_object_mut(){
            for (k,v) in obj {
                if allowed_fields.contains(&k.as_str()){
                    target.insert(k.clone(),v.clone());
                }
            }
        }
        Ok(())
    }
}

/// Chrome-side action router, called from browser_action in main.rs with
/// the same (name, value) convention as media_devices::action. Only the
/// trusted chrome can reach browser_action (see capabilities/default.json).
pub fn action(app: &tauri::AppHandle, name: &str, value: &serde_json::Value)
    -> Result<serde_json::Value, String> {
    let state = app.state::<std::sync::Mutex<MediaLibrary>>();
    let mut lib = state.lock().map_err(|e| e.to_string())?;
    match name {
        "media-library-get" => Ok(serde_json::to_value(&*lib).map_err(|e| e.to_string())?),
        "media-library-add-folder" => {
            let path = value.get("path").and_then(|v| v.as_str())
                .ok_or("Choose a folder first")?;
            let library_id=value.get("libraryId").and_then(Value::as_str)
                .unwrap_or("minternet-media");
            if lib.collections.is_empty() {
                lib.collections.push(LibraryCollection{
                    id:"minternet-media".into(),name:"Media Library".into(),kind:"mixed".into(),
                    folder_ids:Vec::new(),hidden_ids:Vec::new()
                });
            }
            let folder = lib.add_folder_to(path,library_id)?;
            lib.save(app)?;
            Ok(serde_json::json!({"ok": true, "folder": folder,
                "count": lib.items.iter().filter(|i| i.folder_id == folder.id).count()}))
        }
        "media-library-remove-folder" => {
            let id = value.get("folderId").and_then(|v| v.as_str()).unwrap_or("");
            lib.remove_folder(id);
            lib.save(app)?;
            Ok(serde_json::json!({"ok": true}))
        }
        "media-library-library-save" => {
            let id=value.get("id").and_then(Value::as_str);
            let name=value.get("name").and_then(Value::as_str).ok_or("Library name required")?;
            let kind=value.get("kind").and_then(Value::as_str).unwrap_or("movie");
            let id=lib.create_or_update_collection(id,name,kind)?;
            lib.save(app)?;
            Ok(serde_json::json!({"ok":true,"id":id}))
        }
        "media-library-library-delete" => {
            let id=value.get("id").and_then(Value::as_str).ok_or("Library ID required")?;
            lib.remove_collection(id)?;
            lib.save(app)?;
            Ok(serde_json::json!({"ok":true}))
        }
        "media-library-item-update" => {
            let library_id=value.get("libraryId").and_then(Value::as_str).ok_or("Library ID required")?;
            let item_id=value.get("itemId").and_then(Value::as_str).ok_or("Video ID required")?;
            let changes=value.get("changes").cloned().ok_or("Changes required")?;
            lib.update_item(library_id,item_id,changes)?;
            lib.save(app)?;
            Ok(serde_json::json!({"ok":true}))
        }
        "media-library-rescan" => {
            lib.rescan_all();
            lib.save(app)?;
            Ok(serde_json::json!({"ok": true, "count": lib.items.len(),
                "lastScan": lib.last_scan}))
        }
        _ => Err("Unknown media library action".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn temporarily_missing_drive_preserves_known_video_cards(){
        let dir=std::env::temp_dir().join(format!("minternet-unmounted-test-{}-{}",std::process::id(),now_secs()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("Retained.mp4"),b"video").unwrap();
        let folder=LibraryFolder{id:"cached-folder".into(),path:dir.to_string_lossy().into_owned(),name:"Drive".into()};
        let mut catalog=MediaLibrary::default();
        catalog.folders.push(folder);
        catalog.rescan_all();
        assert_eq!(catalog.items.len(),1);
        fs::remove_dir_all(&dir).unwrap();
        catalog.rescan_all();
        assert_eq!(catalog.items.len(),1,"unavailable drives must not erase saved catalog");
    }
    #[test]
    fn named_libraries_keep_media_overrides_and_folder_membership(){
        let mut state=MediaLibrary::default();
        let id=state.create_or_update_collection(None,"Films","movie").unwrap();
        let shows=state.create_or_update_collection(None,"Series","tv").unwrap();
        assert_ne!(id,shows);
        assert_eq!(state.collections.len(),2);
        state.create_or_update_collection(Some(&id),"Movies","mixed").unwrap();
        assert_eq!(state.collections[0].name,"Movies");
        assert!(state.create_or_update_collection(None,"Movies","movie").is_err());
        state.remove_collection(&id).unwrap();
        assert_eq!(state.collections.len(),1);
    }
    #[test]
    fn scan_finds_root_and_nested_videos_only() {
        let dir = std::env::temp_dir().join(format!("minternet-ml-test-{}", now_secs()));
        fs::create_dir_all(dir.join("Movies")).unwrap();
        fs::create_dir_all(dir.join("Shows/Season 01")).unwrap();
        let mut root_file = fs::File::create(dir.join("A Single Movie (2025).mp4")).unwrap();
        root_file.write_all(b"root").unwrap();
        fs::write(dir.join("Movies/Blade Runner (1982).mkv"), b"nested").unwrap();
        fs::write(dir.join("Shows/Season 01/Some.Show.S01E01.mp4"), b"ep").unwrap();
        fs::write(dir.join("notes.txt"), b"not a video").unwrap();
        let folder = LibraryFolder {
            id: "mf1".into(), path: dir.to_string_lossy().into_owned(), name: "Test".into(),
        };
        let items = scan_folder(&folder);
        assert_eq!(items.len(), 3, "root MP4 + nested MKV + nested episode, not the txt");
        assert!(items.iter().any(|i| i.path == "A Single Movie (2025).mp4"),
            "a file directly in the root keeps its bare filename");
        assert!(items.iter().any(|i| i.path == "Movies/Blade Runner (1982).mkv"));
        assert!(items.iter().any(|i| i.year == Some(1982)));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_folder_scans_empty_but_stays_registered() {
        let folder = LibraryFolder {
            id: "mf2".into(), path: "/definitely/not/here".into(), name: "Gone".into(),
        };
        assert!(scan_folder(&folder).is_empty());
        let mut lib = MediaLibrary::default();
        lib.folders.push(folder);
        lib.rescan_all();
        assert_eq!(lib.folders.len(), 1, "unplugged drive must not unregister the folder");
        assert!(lib.items.is_empty());
    }
}
