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

use std::{fs, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};
use serde::{Deserialize, Serialize};
use tauri::Manager;

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

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaLibrary {
    pub folders: Vec<LibraryFolder>,
    pub items: Vec<LibraryItem>,
    pub last_scan: u64,
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
        serde_json::from_slice::<Self>(&data).unwrap_or_default()
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
            items.extend(scan_folder(folder));
        }
        self.items = items;
        self.last_scan = now_secs();
    }

    pub fn add_folder(&mut self, path: &str) -> Result<LibraryFolder, String> {
        let p = Path::new(path);
        if !p.is_dir() { return Err("That folder does not exist on this device".into()); }
        if self.folders.iter().any(|f| f.path == path) {
            return Err("That folder is already in the library".into());
        }
        let folder = LibraryFolder {
            id: format!("mf{}-{}", now_secs(), self.folders.len()),
            path: path.to_string(),
            name: p.file_name().map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Video Folder".into()),
        };
        self.folders.push(folder.clone());
        self.rescan_all();
        Ok(folder)
    }

    pub fn remove_folder(&mut self, folder_id: &str) {
        self.folders.retain(|f| f.id != folder_id);
        self.items.retain(|i| i.folder_id != folder_id);
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
            let folder = lib.add_folder(path)?;
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
