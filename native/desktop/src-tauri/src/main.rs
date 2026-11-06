#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod password_vault;
mod browsing_history;
mod google_account;
mod firefox_bookmarks;
mod secret_bookmarks;
use base64::Engine as _;
use rand::{rngs::OsRng,RngCore};
use tauri_plugin_clipboard_manager::ClipboardExt;

use std::{sync::{Mutex,atomic::{AtomicU64,Ordering}}, collections::{HashSet, HashMap, VecDeque}, path::PathBuf, time::{Instant, Duration}};
use serde::{Serialize,Deserialize};
use zeroize::Zeroize;
use serde_json::{json, Value};
use tauri::{
    Emitter, Manager, WebviewUrl, LogicalPosition, LogicalSize,
    webview::{WebviewBuilder, WebviewWindowBuilder, NewWindowResponse, PermissionResponse, PageLoadEvent, DownloadEvent},
    window::WindowBuilder,
};

const CHROME: f64 = 52.0;
const BOOKMARK_BAR: f64 = 22.0;
const MAX_TABS: usize = 35;
const HOME: &str = "about:blank";

#[derive(Clone)]
struct PendingChatPrompt {
    text: String,
    temporary: bool,
}

#[derive(Clone)]
struct Tab {
    id: u32,
    title: String,
    url: String,
    private: bool,
    pinned: bool,
    audio_playing: bool,
    audio_muted: bool,
    view: Option<String>,
    history: Vec<String>,
    at: usize,
    // Renderer memory can be dropped while preserving the URL and tab identity.
    inactive_since: Option<Instant>,
    loading: bool,
    checking_unload: bool,
    // Only Ctrl-click-created tabs have an explicit source; the frontend uses
    // this to restore immediate visual adjacency within tab groups.
    opener_id: Option<u32>,
    pending_chatgpt: Option<PendingChatPrompt>,
    sync_id: String,
    secret_id: Option<String>,
    secret_revealed: bool,
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicTab {
    id: u32,
    title: String,
    url: String,
    private: bool,
    pinned: bool,
    audio_playing: bool,
    audio_muted: bool,
    loading: bool,
    can_back: bool,
    can_forward: bool,
    suspended: bool,
    opener_id: Option<u32>,
    sync_id:String,
    error: String,
    secret_tab: bool,
    secret_pending: bool,
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    tabs: Vec<PublicTab>,
    active_id: u32,
    extensions_count: usize,
}

struct Browser {
    tabs: Vec<Tab>,
    active_id: u32,
    next_id: u32,
    last_notified: Option<Snapshot>,
    warming: HashSet<u32>,
}

#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
struct RecentDownload {
    id:u64,
    name:String,
    source:String,
    path:String,
    status:String,
    private:bool,
}
#[derive(Default)]
struct DownloadsState(Mutex<VecDeque<RecentDownload>>);

fn recent_downloads_file(app:&tauri::AppHandle)->Result<PathBuf,String>{
    Ok(app.path().app_data_dir().map_err(|e|e.to_string())?
        .join("recent-downloads.v1.json"))
}
fn save_recent_downloads(app:&tauri::AppHandle){
    let state=app.state::<DownloadsState>();
    let Ok(history)=state.0.lock() else{return};
    let stored=history.iter().filter(|d|!d.private).cloned().collect::<Vec<_>>();
    drop(history);
    let Ok(path)=recent_downloads_file(app) else{return};
    let Ok(data)=serde_json::to_vec(&stored) else{return};
    if data.len()>200_000 {return;}
    if let Some(parent)=path.parent(){if std::fs::create_dir_all(parent).is_err(){return;}}
    let temp=path.with_extension("tmp");
    if std::fs::write(&temp,data).is_err(){return;}
    if std::fs::rename(&temp,&path).is_err(){
        let _=std::fs::copy(&temp,&path);
        let _=std::fs::remove_file(&temp);
    }
}
fn restore_recent_downloads(app:&tauri::AppHandle){
    let Ok(file)=recent_downloads_file(app) else{return};
    let Ok(raw)=std::fs::read(file) else{return};
    if raw.len()>200_000 {return;}
    let Ok(entries)=serde_json::from_slice::<Vec<RecentDownload>>(&raw) else{return};
    let Ok(dir)=app.path().download_dir() else{return};
    let Ok(real_download_dir)=std::fs::canonicalize(&dir) else{return};
    let state=app.state::<DownloadsState>();
    let Ok(mut history)=state.0.lock() else{return};
    for mut entry in entries.into_iter().rev().take(50).collect::<Vec<_>>().into_iter().rev(){
        if entry.private || entry.name.len()>160 || entry.source.len()>4096 {continue;}
        let path=PathBuf::from(&entry.path);
        let Ok(real_file)=std::fs::canonicalize(&path) else{continue};
        if !real_file.starts_with(&real_download_dir)
            || path.file_name().and_then(|n|n.to_str())!=Some(entry.name.as_str())
            || !real_file.is_file(){continue;}
        if entry.status=="downloading"{entry.status="interrupted".into();}
        if !matches!(entry.status.as_str(),"completed"|"failed"|"interrupted"){continue;}
        history.push_back(entry);
    }
}
fn download_name(url:&tauri::Url)->String{
    let segment=url.path_segments().and_then(|mut segments|segments.next_back()).unwrap_or("download");
    let cleaned=segment.chars().map(|c|{
        if c.is_ascii_alphanumeric() || matches!(c,'.'|'-'|'_'|'('|')'|' ') {c} else {'_'}
    }).collect::<String>();
    let name=cleaned.trim_matches(|c:char|c=='.'||c==' ').chars().take(120).collect::<String>();
    if name.is_empty() {"download".into()}else{name}
}
fn download_path(app:&tauri::AppHandle,url:&tauri::Url,suggested:&std::path::Path)->Result<PathBuf,String>{
    let dir=app.path().download_dir().map_err(|_|"Downloads directory is unavailable".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e|e.to_string())?;
    // WebView2 supplies the server Content-Disposition suggested filename in
    // destination. Prefer that over a generic /download URL, but never trust
    // its directory or any unsafe filename characters.
    let supplied=suggested.file_name().and_then(|v|v.to_str()).unwrap_or("");
    let safe=supplied.chars().map(|c|{
        if c.is_ascii_alphanumeric() || matches!(c,'.'|'-'|'_'|'('|')'|' ') {c} else {'_'}
    }).collect::<String>();
    let safe=safe.trim_matches(|c:char|c=='.'||c==' ').chars().take(120).collect::<String>();
    let original=if safe.is_empty(){download_name(url)}else{safe};
    let candidate=std::path::Path::new(&original);
    let stem=candidate.file_stem().and_then(|n|n.to_str()).unwrap_or("download");
    let extension=candidate.extension().and_then(|n|n.to_str()).unwrap_or("");
    let state=app.state::<DownloadsState>();
    let history=state.0.lock().map_err(|e|e.to_string())?;
    for i in 0..1000 {
        let name=if i==0{original.clone()}
                 else if extension.is_empty(){format!("{stem} ({i})")}
                 else{format!("{stem} ({i}).{extension}")};
        let path=dir.join(name);
        if !path.exists()&&!history.iter().any(|d|d.path==path.to_string_lossy()) {
            return Ok(path);
        }
    }
    Err("Too many files with this name in Downloads".into())
}
// Server URLs often end in /download or .txt even when the response is a
// genuine executable. Detect the actual file signature AFTER a completed
// download and fix the filename rather than handing the user a text file.
fn download_signature(path:&std::path::Path)->Option<&'static str>{
    use std::io::{Read,Seek,SeekFrom};
    let mut f=std::fs::File::open(path).ok()?;
    let mut head=[0u8;512];
    let count=f.read(&mut head).ok()?;
    let h=&head[..count];
    if h.starts_with(b"MZ") && count>=64 {
        let offset=u32::from_le_bytes(h[0x3c..0x40].try_into().ok()?) as u64;
        if offset<4_000_000 {
            let mut marker=[0u8;4];
            if f.seek(SeekFrom::Start(offset)).is_ok()
                && f.read_exact(&mut marker).is_ok() && &marker==b"PE\0\0" {
                return Some("exe");
            }
        }
    }
    if h.starts_with(b"%PDF-"){return Some("pdf");}
    if h.starts_with(b"PK\x03\x04") || h.starts_with(b"PK\x05\x06"){return Some("zip");}
    if h.starts_with(b"\x89PNG\r\n\x1a\n"){return Some("png");}
    if h.starts_with(b"\xff\xd8\xff"){return Some("jpg");}
    if h.starts_with(b"7z\xbc\xaf\x27\x1c"){return Some("7z");}
    if h.starts_with(b"Rar!\x1a\x07"){return Some("rar");}
    None
}
fn repair_download_extension(path:&std::path::Path)->PathBuf{
    let Some(detected)=download_signature(path) else{return path.to_path_buf()};
    let ext=path.extension().and_then(|x|x.to_str()).unwrap_or("").to_ascii_lowercase();
    if ext==detected || (detected=="jpg" && ext=="jpeg"){return path.to_path_buf();}
    // Correct an actual PE binary even if the server mislabeled it .txt.
    // For other formats, only rename extensionless/misleading generic files.
    if detected!="exe" && !matches!(ext.as_str(),""|"txt"|"bin"|"dat"|"download"){
        return path.to_path_buf();
    }
    // A file named Program.exe.txt should become Program.exe, not .exe.exe.
    let original=path.file_name().and_then(|n|n.to_str()).unwrap_or("download");
    let lower=original.to_ascii_lowercase();
    let base=if lower.ends_with(&format!(".{detected}.txt")){
        original[..original.len()-4].to_string()
    }else{
        path.with_extension(detected).file_name().and_then(|n|n.to_str())
            .unwrap_or(original).to_string()
    };
    let dir=path.parent().unwrap_or_else(||std::path::Path::new("."));
    for n in 0..100 {
        let name=if n==0{base.clone()}else{
            let stem=std::path::Path::new(&base).file_stem().and_then(|x|x.to_str()).unwrap_or("download");
            format!("{stem} ({n}).{detected}")
        };
        let candidate=dir.join(name);
        if candidate==path{return path.to_path_buf();}
        if !candidate.exists() && std::fs::rename(path,&candidate).is_ok(){
            return candidate;
        }
    }
    path.to_path_buf()
}
#[cfg(test)]
mod download_format_tests {
    use super::{download_signature,repair_download_extension};
    #[test]
    fn mislabeled_executable_becomes_real_exe_without_loading_it() {
        let path=std::env::temp_dir().join(format!("minternet-{}-sample.exe.txt",std::process::id()));
        let mut content=vec![0u8;256];
        content[0..2].copy_from_slice(b"MZ");
        content[0x3c..0x40].copy_from_slice(&128u32.to_le_bytes());
        content[128..132].copy_from_slice(b"PE\0\0");
        std::fs::write(&path,content).unwrap();
        assert_eq!(download_signature(&path),Some("exe"));
        let updated=repair_download_extension(&path);
        assert_eq!(updated.extension().and_then(|x|x.to_str()),Some("exe"));
        assert_eq!(download_signature(&updated),Some("exe"));
        let _=std::fs::remove_file(updated);
    }
    #[test]
    fn text_dressed_up_as_exe_is_not_an_executable() {
        let path=std::env::temp_dir().join(format!("minternet-{}-fake.exe",std::process::id()));
        std::fs::write(&path,b"<html>Error: file unavailable</html>").unwrap();
        assert_eq!(download_signature(&path),None);
        let _=std::fs::remove_file(&path);
    }
}
fn download_update(app:&tauri::AppHandle,url:&tauri::Url,path:Option<&std::path::Path>,
                   private:bool,success:Option<bool>){
    let state=app.state::<DownloadsState>();
    let Ok(mut history)=state.0.lock() else{return};
    let source=url.as_str().to_string();
    if let Some(done)=success {
        // Match the source AND original destination: parallel downloads must
        // never replace one another's statuses or filenames.
        if let Some(entry)=history.iter_mut().rev().find(|d|
            d.source==source&&d.status=="downloading"&&d.private==private
            &&path.map(|p|p.to_string_lossy()==d.path).unwrap_or(true)){
            if done && std::path::Path::new(&entry.path).is_file() {
                let corrected=repair_download_extension(std::path::Path::new(&entry.path));
                let is_exe=corrected.extension().and_then(|x|x.to_str())
                    .map(|x|x.eq_ignore_ascii_case("exe")).unwrap_or(false);
                let valid_binary=!is_exe || download_signature(&corrected)==Some("exe");
                entry.path=corrected.to_string_lossy().to_string();
                entry.name=corrected.file_name().and_then(|x|x.to_str()).unwrap_or("Download").to_string();
                entry.status=if valid_binary{"completed"}else{"invalid"}.into();
            }else{entry.status="failed".into();}
        }
    }else if let Some(file)=path{
        let next=history.back().map(|d|d.id+1).unwrap_or(1);
        history.push_back(RecentDownload{
            id:next,name:file.file_name().and_then(|n|n.to_str()).unwrap_or("Download").to_string(),
            source,path:file.to_string_lossy().to_string(),status:"downloading".into(),private
        });
        while history.len()>50 {history.pop_front();}
    }
    let summary=history.iter().rev().map(|d|json!({
        "id":d.id,"name":d.name,"status":d.status,"private":d.private
    })).collect::<Vec<_>>();
    drop(history);
    let _=app.emit_to("chrome","minternet:downloads",summary);
    if !private {save_recent_downloads(app);}
}
// Download actions accept only IDs previously created by Minternet. The
// resolved file must still be inside the user's real Downloads directory.
fn checked_download_path(app:&tauri::AppHandle,id:u64)->Result<PathBuf,String>{
    let saved={
        let state=app.state::<DownloadsState>();
        let downloads=state.0.lock().map_err(|e|e.to_string())?;
        let item=downloads.iter().find(|d|d.id==id&&d.status=="completed")
            .ok_or("Completed download not found")?;
        (item.path.clone(),item.name.clone())
    };
    let root=std::fs::canonicalize(app.path().download_dir().map_err(|e|e.to_string())?)
        .map_err(|e|e.to_string())?;
    let path=std::fs::canonicalize(&saved.0).map_err(|_|"Downloaded file no longer exists")?;
    if !path.is_file() || !path.starts_with(&root)
        || path.file_name().and_then(|n|n.to_str())!=Some(saved.1.as_str()){
        return Err("Download path is no longer valid".into());
    }
    Ok(path)
}
#[cfg(windows)]
fn open_download_file(path:&std::path::Path)->Result<(),String>{
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{w,PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let wide=path.as_os_str().encode_wide().chain(std::iter::once(0))
        .collect::<Vec<u16>>();
    // A deliberate user click invokes the normal Windows security prompts
    // and registered application; no cmd.exe or shell string interpolation.
    let instance=unsafe{ShellExecuteW(None,w!("open"),PCWSTR(wide.as_ptr()),
        PCWSTR::null(),PCWSTR::null(),SW_SHOWNORMAL)};
    if instance.0 as isize<=32{return Err("Windows could not open this file".into());}
    Ok(())
}
#[cfg(target_os="macos")]
fn open_download_file(path:&std::path::Path)->Result<(),String>{
    std::process::Command::new("open").arg(path).spawn().map_err(|e|e.to_string())?;
    Ok(())
}
#[cfg(target_os="linux")]
fn open_download_file(path:&std::path::Path)->Result<(),String>{
    std::process::Command::new("xdg-open").arg(path).spawn().map_err(|e|e.to_string())?;
    Ok(())
}
// A WebView2 popup that has been replaced by a detached tab loses the real
// window.opener relationship. Firebase Auth and most OAuth popup handshakes
// depend on it. Keep auth popups in a related native WebView2 window so the
// login can send its result back to the initiating tab and close normally.
static NEXT_AUTH_POPUP_ID: AtomicU64 = AtomicU64::new(1);

fn is_auth_popup_url(url: &tauri::Url) -> bool {
    if url.as_str() == "about:blank" { return true; }
    if url.scheme() != "https" { return false; }
    let Some(host) = url.host_str() else { return false };
    let host = host.to_ascii_lowercase();
    let path = url.path().to_ascii_lowercase();
    // Firebase Auth's real popup starts on the app's firebaseapp.com auth
    // handler and then redirects to accounts.google.com and back again.
    // Support custom Firebase auth domains as well.
    if path.starts_with("/__/auth/") { return true; }
    if matches!(host.as_str(), "accounts.google.com"|"login.microsoftonline.com"|
        "login.live.com"|"appleid.apple.com"|"id.apple.com"|
        "github.com"|"login.yahoo.com"|"www.facebook.com") {
        return host != "github.com" || path.starts_with("/login/oauth/");
    }
    // Common OIDC/OAuth authorization endpoints used by other websites.
    (path.contains("/oauth/") || path.ends_with("/authorize") ||
        path.ends_with("/authorization") || path.ends_with("/login"))
        && url.query_pairs().any(|(key,_)| matches!(key.as_ref(),
            "client_id"|"redirect_uri"|"response_type"|"code_challenge"))
}

#[cfg(test)]
mod auth_popup_tests {
    use super::*;
    #[test]
    fn firebase_google_sign_in_popup_keeps_native_opener() {
        for url in [
            "https://proseu-working-03-624365-f0705.firebaseapp.com/__/auth/handler?authType=signInViaPopup",
            "https://accounts.google.com/o/oauth2/v2/auth?client_id=test&response_type=code",
            "https://auth.example.org/oauth2/authorize?client_id=demo",
            "about:blank",
        ] {
            assert!(is_auth_popup_url(&tauri::Url::parse(url).unwrap()),"{url}");
        }
    }
    #[test]
    fn normal_links_still_open_as_minternet_tabs() {
        for url in [
            "https://example.com",
            "https://github.com/example/project",
            "https://chatgpt.com/",
            "http://accounts.google.com/o/oauth2/v2/auth?client_id=bad",
            "file:///etc/passwd",
        ] {
            assert!(!is_auth_popup_url(&tauri::Url::parse(url).unwrap()),"{url}");
        }
    }
}

struct PopupDeduper(Mutex<HashMap<(u32,String),Instant>>);
struct ZoomState(Mutex<f64>);
#[derive(Default)]
struct SplitState(Mutex<Vec<u32>>);
struct SplitRatios(Mutex<(f64,f64)>);
struct UndoState { tabs: Vec<Tab>, active_id:u32, split_ids:Vec<u32>, ratios:(f64,f64), ui:Option<Value> }
struct UndoHistory(Mutex<VecDeque<UndoState>>);

fn remember_undo(app:&tauri::AppHandle, ui:Option<Value>) {
    let (tabs,active_id)={
        let state=app.state::<Mutex<Browser>>();
        let Ok(browser)=state.lock() else{return};
        (browser.tabs.clone(),browser.active_id)
    };
    let split_ids=app.state::<SplitState>().0.lock().map(|s|s.clone()).unwrap_or_default();
    let ratios=app.state::<SplitRatios>().0.lock().map(|r|*r).unwrap_or((0.5,0.5));
    let snapshot=UndoState{tabs,active_id,split_ids,ratios,ui};
    let history=app.state::<UndoHistory>();
    if let Ok(mut list)=history.0.lock(){
        if list.len()>=100{list.pop_front();}
        list.push_back(snapshot);
    };
}
fn undo_last(app:&tauri::AppHandle)->Result<Option<Value>,String> {
    let entry={
        let state=app.state::<UndoHistory>();
        let mut undo=state.0.lock().map_err(|e|e.to_string())?;
        undo.pop_back()
    };
    let Some(mut entry)=entry else{return Ok(None)};
    let ui=entry.ui.take();
    let mut to_close=Vec::new();
    {
        let state=app.state::<Mutex<Browser>>();
        let mut browser=state.lock().map_err(|e|e.to_string())?;
        for current in &browser.tabs{
            let original=entry.tabs.iter().find(|saved|saved.id==current.id);
            if original.map(|saved|saved.url==current.url && saved.private==current.private).unwrap_or(false){
                continue;
            }
            if let Some(label)=current.view.clone(){to_close.push(label);}
        }
        for restored in &mut entry.tabs {
            if let Some(current)=browser.tabs.iter().find(|t|t.id==restored.id && t.url==restored.url && t.private==restored.private){
                restored.view=current.view.clone();
            }else{restored.view=None;}
        }
        browser.tabs=entry.tabs;
        browser.active_id=entry.active_id;
        browser.next_id=browser.next_id.max(browser.tabs.iter().map(|t|t.id).max().unwrap_or(0)+1);
        browser.warming.clear();
        browser.last_notified=None;
    }
    for label in to_close{
        if let Some(view)=app.get_webview(&label){let _=view.close();}
    }
    *app.state::<SplitState>().0.lock().map_err(|e|e.to_string())?=entry.split_ids;
    *app.state::<SplitRatios>().0.lock().map_err(|e|e.to_string())?=entry.ratios;
    invalidate_layout(app);
    save_pinned(app)?;
    activated(app)?;
    notify(app);
    Ok(Some(ui.unwrap_or(Value::Null)))
}

#[derive(Default)]
struct LayoutCache {
    size_and_home: Option<(u32, u32, bool, bool, bool, u64)>,
    shown: HashSet<String>,
    bookmark_bar_visible: bool,
    overlay_open: bool,
}

fn new_sync_id()->String {
    let mut random=[0u8;16];
    OsRng.fill_bytes(&mut random);
    random.iter().map(|c|format!("{c:02x}")).collect()
}
impl Browser {
    fn new() -> Self {
        Self {
            // The home page can be displayed without creating any tab.
            tabs: Vec::new(),
            active_id: 0,
            next_id: 1,
            last_notified: None,
            warming: HashSet::new(),
        }
    }
    fn active(&self) -> Option<&Tab> {
        self.tabs.iter().find(|t| t.id == self.active_id)
    }
    fn active_mut(&mut self) -> Option<&mut Tab> {
        self.tabs.iter_mut().find(|t| t.id == self.active_id)
    }
    fn add(&mut self, private: bool) -> Result<u32, String> {
        if self.tabs.len() >= MAX_TABS { return Err("Maximum 35 tabs".into()); }
        let id = self.next_id;
        self.next_id += 1;
        self.tabs.push(Tab {
            id, title: "New Tab".into(), url: HOME.into(), private,
            pinned: false, audio_playing:false, audio_muted:false,
            view: None, history: vec![HOME.into()], at: 0,
            inactive_since: None, loading: false, checking_unload: false,
            opener_id: None, pending_chatgpt: None,
            sync_id: new_sync_id(),
            secret_id:None,secret_revealed:false,
        });
        self.active_id = id;
        Ok(id)
    }
    // Preserve logical order in the native session and source-tab identity.
    // The active page remains selected for background link openings.
    fn add_after(&mut self, private: bool, opener: u32, background: bool) -> Result<u32,String> {
        let selected=self.active_id;
        let id=self.add(private)?;
        if let Some(index)=self.tabs.iter().position(|tab|tab.id==opener) {
            if let Some(mut created)=self.tabs.pop(){
                created.opener_id=Some(opener);
                self.tabs.insert(index+1,created);
            }
        }
        if background {self.active_id=selected;}
        Ok(id)
    }
    fn snapshot(&self) -> Snapshot {
        Snapshot {
            active_id: self.active_id,
            extensions_count: 0,
            tabs: self.tabs.iter().map(|t| PublicTab {
                id:t.id,
                title:if t.secret_id.is_some(){"Secret Tab".into()}else{t.title.clone()},
                url:if t.secret_id.is_some(){HOME.into()}else{t.url.clone()},
                private:t.private,pinned:t.pinned,audio_playing:t.audio_playing,
                audio_muted:t.audio_muted,loading:t.loading,
                can_back:t.secret_id.is_none() && t.at>0,
                can_forward:t.secret_id.is_none() && t.at+1<t.history.len(),
                suspended:t.view.is_none() && t.url!=HOME,
                opener_id:t.opener_id,sync_id:t.sync_id.clone(),
                error:String::new(),
                secret_tab:t.secret_id.is_some(),
                secret_pending:t.secret_id.is_some()&&!t.secret_revealed,
            }).collect(),
        }
    }
}

// Only non-private, HTTPS pinned pages survive application restarts.
// The file is in Minternet's own user profile, never beside the single EXE.
fn pinned_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // CI smoke uses an isolated file so it never alters the user's pins.
    if std::env::args().any(|a|a=="--minternet-pin-smoke"||
                               a=="--minternet-pin-reopen-smoke") {
        return Ok(std::env::temp_dir().join("minternet-ci-pinned-tabs.v1.json"));
    }
    let dir=app.path().app_data_dir().map_err(|e|e.to_string())?;
    Ok(dir.join("pinned-tabs.v1.json"))
}
fn save_pinned(app: &tauri::AppHandle) -> Result<(), String> {
    let pages = {
        let state=app.state::<Mutex<Browser>>();
        let browser=state.lock().map_err(|e|e.to_string())?;
        browser.tabs.iter()
            .filter(|tab|tab.pinned && !tab.private)
            .filter(|tab|tab.url.starts_with("https://"))
            .map(|tab|tab.url.clone()).take(MAX_TABS).collect::<Vec<_>>()
    };
    let file=pinned_file(app)?;
    if let Some(dir)=file.parent(){std::fs::create_dir_all(dir).map_err(|e|e.to_string())?;}
    let contents=serde_json::to_vec(&pages).map_err(|e|e.to_string())?;
    // Write atomically to avoid losing pinned pages on an interrupted update.
    let temp=file.with_extension("tmp");
    std::fs::write(&temp,contents).map_err(|e|e.to_string())?;
    if std::fs::rename(&temp,&file).is_err(){
        // Windows cannot always replace an existing file using rename.
        std::fs::copy(&temp,&file).map_err(|e|e.to_string())?;
        let _=std::fs::remove_file(&temp);
    }
    Ok(())
}
fn restore_pinned(app: &tauri::AppHandle) {
    let Ok(path)=pinned_file(app) else {return};
    let Ok(bytes)=std::fs::read(path) else {return};
    if bytes.len()>128_000{return}
    let Ok(pages)=serde_json::from_slice::<Vec<String>>(&bytes) else {return};
    let state=app.state::<Mutex<Browser>>();
    let Ok(mut browser)=state.lock() else {return};
    for address in pages.into_iter().take(MAX_TABS) {
        let Ok(url)=tauri::Url::parse(&address) else {continue};
        if url.scheme()!="https"||url.host_str().is_none()||
           !url.username().is_empty()||url.password().is_some(){continue;}
        if let Ok(id)=browser.add(false){
            if let Some(tab)=browser.tabs.iter_mut().find(|t|t.id==id){
                tab.pinned=true;
                tab.url=address.clone();
                tab.title=title_for(&address);
                tab.history=vec![address];
                tab.at=0;
            }
        }
    }
    // On launch, focus the first pinned tab; otherwise show the tabless home.
    browser.active_id=browser.tabs.first().map(|tab|tab.id).unwrap_or(0);
}


/* Restore the full non-private browsing session, including ordinary tabs.
   Private tabs intentionally never enter persistent storage. */
fn session_file(app: &tauri::AppHandle) -> Result<PathBuf,String> {
    let dir=app.path().app_data_dir().map_err(|e|e.to_string())?;
    Ok(dir.join("browser-session.v1.json"))
}
fn save_session(app: &tauri::AppHandle) -> Result<(),String> {
    if std::env::args().any(|a|a.starts_with("--minternet-") && a.ends_with("smoke")) {return Ok(());}
    let data={
        let store=app.state::<Mutex<Browser>>();
        let browser=store.lock().map_err(|e|e.to_string())?;
        let tabs=browser.tabs.iter().filter(|tab|!tab.private).map(|tab|{
            json!({"url":tab.url,"pinned":tab.pinned,"syncId":tab.sync_id})
        }).collect::<Vec<_>>();
        let selected=browser.active().filter(|t|!t.private).map(|t|t.id);
        let active=tabs.iter().enumerate().find_map(|(i,_)|{
            let target=browser.tabs.iter().filter(|t|!t.private).nth(i)?;
            if Some(target.id)==selected{Some(i)}else{None}
        });
        json!({"version":1,"tabs":tabs,"active":active})
    };
    let file=session_file(app)?;
    let bytes=serde_json::to_vec(&data).map_err(|e|e.to_string())?;
    if std::fs::read(&file).ok().as_deref()==Some(bytes.as_slice()){return Ok(());}
    if let Some(dir)=file.parent(){std::fs::create_dir_all(dir).map_err(|e|e.to_string())?;}
    let temp=file.with_extension("tmp");
    std::fs::write(&temp,&bytes).map_err(|e|e.to_string())?;
    if std::fs::rename(&temp,&file).is_err(){
        std::fs::copy(&temp,&file).map_err(|e|e.to_string())?;
        let _=std::fs::remove_file(&temp);
    }
    Ok(())
}
fn restore_session(app: &tauri::AppHandle) {
    if std::env::args().any(|a|a.starts_with("--minternet-") && a.ends_with("smoke")){
        restore_pinned(app);return;
    }
    let Ok(path)=session_file(app) else {restore_pinned(app);return};
    let Ok(bytes)=std::fs::read(path) else {restore_pinned(app);return};
    if bytes.len()>128_000 {restore_pinned(app);return;}
    let Ok(data)=serde_json::from_slice::<Value>(&bytes) else {restore_pinned(app);return};
    let Some(saved)=data.get("tabs").and_then(Value::as_array) else {restore_pinned(app);return};
    let state=app.state::<Mutex<Browser>>();
    let Ok(mut browser)=state.lock() else {return};
    for record in saved.iter().take(MAX_TABS) {
        let Some(address)=record.get("url").and_then(Value::as_str) else {continue};
        if address!=HOME {
            let Ok(url)=tauri::Url::parse(address) else {continue};
            if url.scheme()!="https"||url.host_str().is_none()||
                !url.username().is_empty()||url.password().is_some(){continue;}
        }
        if let Ok(id)=browser.add(false){
            if let Some(tab)=browser.tabs.iter_mut().find(|t|t.id==id){
                tab.url=address.to_string();
                tab.title=title_for(address);
                tab.history=vec![address.to_string()];
                tab.pinned=record.get("pinned").and_then(Value::as_bool)==Some(true);
                if let Some(remote)=record.get("syncId").and_then(Value::as_str) {
                    if remote.len()==32 && remote.chars().all(|c|c.is_ascii_hexdigit()){
                        tab.sync_id=remote.to_owned();
                    }
                }
            }
        }
    }
    let index=data.get("active").and_then(Value::as_u64).map(|n|n as usize);
    browser.active_id=index.and_then(|i|browser.tabs.get(i).map(|t|t.id))
        .or_else(||browser.tabs.iter().find(|t|t.pinned).map(|t|t.id)).unwrap_or(0);
}

fn snapshot(app: &tauri::AppHandle) -> Result<Snapshot, String> {
    let browser = app.state::<Mutex<Browser>>();
    let b = browser.lock().map_err(|e| e.to_string())?;
    Ok(b.snapshot())
}

fn notify(app: &tauri::AppHandle) {
    let state = {
        let storage = app.state::<Mutex<Browser>>();
        let Ok(mut b) = storage.lock() else { return };
        let state = b.snapshot();
        if b.last_notified.as_ref() == Some(&state) { return; }
        b.last_notified = Some(state.clone());
        state
    };
    let _ = app.emit_to("chrome", "minternet:state", state);
    let _ = save_session(app);
}

fn title_for(url: &str) -> String {
    if url == HOME { return "New Tab".into(); }
    tauri::Url::parse(url).ok()
        .and_then(|url| url.host_str().map(|h| h.trim_start_matches("www.").to_string()))
        .unwrap_or_else(|| "Website".into())
}

fn parse_address(text: &str) -> Result<Option<tauri::Url>, String> {
    parse_address_with_engine(text, "google")
}

// Provider is selected from a strict allowlist: untrusted website content
// cannot supply a search URL or inject a different navigation scheme.
fn parse_address_with_engine(text: &str, engine: &str) -> Result<Option<tauri::Url>, String> {
    let s = text.trim();
    if s.is_empty() || s == HOME { return Ok(None); }
    if s.len() > 4096 { return Err("Address too long".into()); }
    let lowered = s.to_ascii_lowercase();
    if lowered.contains("://") && !lowered.starts_with("https://") && !lowered.starts_with("http://") {
        return Err("Only HTTP and HTTPS pages are supported.".into());
    }
    if lowered.starts_with("file:") || lowered.starts_with("javascript:") ||
       lowered.starts_with("data:") || lowered.starts_with("about:") ||
       lowered.starts_with("chrome:") || lowered.starts_with("blob:") {
        return Err("Unsafe navigation blocked".into());
    }
    let candidate = if lowered.starts_with("https://") || lowered.starts_with("http://") {
        s.to_string()
    } else if !s.contains(char::is_whitespace) && s.contains('.') &&
              !s.contains(':') && !s.starts_with('.') {
        format!("https://{s}")
    } else {
        let (base,query_param) = match engine {
            "duckduckgo" => ("https://duckduckgo.com/?q=", ""),
            "bing" => ("https://www.bing.com/search?q=", ""),
            "brave" => ("https://search.brave.com/search?q=", ""),
            "startpage" => ("https://www.startpage.com/sp/search?query=", ""),
            "ecosia" => ("https://www.ecosia.org/search?q=", ""),
            "chatgpt" => ("https://chatgpt.com/?q=", ""),
            "chatgpt-private" => ("https://chatgpt.com/?temporary-chat=true&q=", ""),
            _ => ("https://www.google.com/search?q=", ""),
        };
        format!("{base}{}{query_param}", percent_encode_search(s))
    };
    let url = tauri::Url::parse(&candidate).map_err(|e| e.to_string())?;
    if !matches!(url.scheme(),"https"|"http") || url.host_str().is_none() ||
       !url.username().is_empty() || url.password().is_some() {
        return Err("Blocked unsafe address".into());
    }
    Ok(Some(url))
}

#[cfg(test)]
mod search_provider_tests {
    use super::parse_address_with_engine;
    #[test]
    fn google_is_default_and_remains_https() {
        let url=parse_address_with_engine("where to eat", "google").unwrap().unwrap();
        assert_eq!(url.as_str(),"https://www.google.com/search?q=where%20to%20eat");
        assert_eq!(parse_address_with_engine("hello", "invalid").unwrap().unwrap().host_str(),Some("www.google.com"));
    }
    #[test]
    fn chatgpt_routes_prompts_to_chat_not_web_search() {
        let url=parse_address_with_engine("science & history", "chatgpt").unwrap().unwrap();
        assert_eq!(url.as_str(),"https://chatgpt.com/?q=science%20%26%20history");
        assert!(!url.as_str().contains("search"));
    }
    #[test]
    fn private_chatgpt_adds_temporary_flag_and_escapes_input() {
        let url=parse_address_with_engine("cats & dogs", "chatgpt-private").unwrap().unwrap();
        assert_eq!(url.as_str(),"https://chatgpt.com/?temporary-chat=true&q=cats%20%26%20dogs");
    }
    #[test]
    fn explicit_http_pages_can_open_without_downgrading_https() {
        assert_eq!(parse_address_with_engine("http://neverssl.com", "google").unwrap().unwrap().scheme(),"http");
        assert_eq!(parse_address_with_engine("example.com", "google").unwrap().unwrap().scheme(),"https");
        assert!(parse_address_with_engine("file:///test", "google").is_err());
    }
    #[test]
    fn explicit_secure_urls_ignore_engine_preference() {
        for engine in ["google","chatgpt","chatgpt-private"]{
            assert_eq!(parse_address_with_engine("https://example.com/docs",engine).unwrap().unwrap().as_str(),"https://example.com/docs");
            assert!(parse_address_with_engine("javascript:alert(1)",engine).is_err());
        }
    }
}
// Inspect the bookmarked document for its actual declared site icon.
// GitHub Pages apps commonly publish /Project/favicon.svg; guessing
// https://username.github.io/favicon.ico returns a generic/missing icon.
fn html_attribute(tag:&str,name:&str)->Option<String>{
    let bytes=tag.as_bytes();
    let mut i=0usize;
    while i<bytes.len(){
        while i<bytes.len() && (!bytes[i].is_ascii_alphanumeric() && bytes[i]!=b'_' && bytes[i]!=b'-'){i+=1;}
        let start=i;
        while i<bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i]==b'_' || bytes[i]==b'-'){i+=1;}
        if i==start{continue;}
        let attr=&tag[start..i];
        while i<bytes.len() && bytes[i].is_ascii_whitespace(){i+=1;}
        if i>=bytes.len() || bytes[i]!=b'=' {continue;}
        i+=1;
        while i<bytes.len() && bytes[i].is_ascii_whitespace(){i+=1;}
        if i>=bytes.len(){break;}
        let value=if bytes[i]==b'"' || bytes[i]==b'\''{
            let quote=bytes[i];i+=1;let begin=i;
            while i<bytes.len() && bytes[i]!=quote {i+=1;}
            let value=&tag[begin..i];
            if i<bytes.len(){i+=1;}
            value
        }else{
            let begin=i;
            while i<bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i]!=b'>'{i+=1;}
            &tag[begin..i]
        };
        if attr.eq_ignore_ascii_case(name){
            return Some(value.replace("&amp;","&").replace("&#38;","&"));
        }
    }
    None
}
fn declared_site_icons(html:&str,page:&tauri::Url)->Vec<String>{
    let lower=html.to_ascii_lowercase();
    let mut seek=0;
    let mut discovered=Vec::<(u8,String)>::new();
    while let Some(offset)=lower[seek..].find("<link") {
        let start=seek+offset;
        let Some(close_offset)=lower[start..].find('>') else{break};
        let end=start+close_offset+1;
        if end-start>1800{seek=end;continue;}
        let tag=&html[start..end];
        seek=end;
        let Some(rel)=html_attribute(tag,"rel") else{continue};
        let words=rel.to_ascii_lowercase();
        let (priority,allowed)=if words.split_whitespace().any(|part|part=="icon"){
            (0,true)
        }else if words.contains("apple-touch-icon"){
            (2,true)
        }else{(3,false)};
        if !allowed{continue;}
        let Some(href)=html_attribute(tag,"href") else{continue};
        let Ok(url)=page.join(href.trim()) else{continue};
        if url.scheme()!="https" || url.host_str().is_none() ||
            !url.username().is_empty() || url.password().is_some(){continue;}
        // For ordinary icons prefer scalable SVG, but honor the original
        // document's link order for ties.
        let priority=if priority==0 && (url.path().ends_with(".svg") ||
            html_attribute(tag,"type").as_deref()==Some("image/svg+xml")){0}
            else if priority==0{1}else{priority};
        let address=url.to_string();
        if !discovered.iter().any(|(_,v)|*v==address){
            discovered.push((priority,address));
        }
        if discovered.len()>=16 {break;}
    }
    discovered.sort_by_key(|(priority,_)|*priority);
    discovered.into_iter().map(|(_,href)|href).collect()
}
#[cfg(test)]
mod bookmark_favicon_tests {
    use super::{declared_site_icons,html_attribute};
    #[test]
    fn detect_site_icons_relative_to_project_path(){
        let page=tauri::Url::parse("https://marcusdhaynes.github.io/MarmaladePlayer/").unwrap();
        let html=r#"<html><head>
          <link rel="icon" type="image/svg+xml" href="./favicon.svg?v=20261104-fullbleed-v1">
          <link rel="icon" type="image/png" href="./favicon-32.png">
          <link rel="shortcut icon" href="./favicon.ico">
          <link rel="apple-touch-icon" href="./assets/apple-touch-icon.png">
        </head></html>"#;
        let icons=declared_site_icons(html,&page);
        assert_eq!(icons[0],"https://marcusdhaynes.github.io/MarmaladePlayer/favicon.svg?v=20261104-fullbleed-v1");
        assert_eq!(icons[1],"https://marcusdhaynes.github.io/MarmaladePlayer/favicon-32.png");
        assert_eq!(icons[3],"https://marcusdhaynes.github.io/MarmaladePlayer/assets/apple-touch-icon.png");
    }
    #[test]
    fn reject_javascript_data_and_insecure_icon_links(){
        let page=tauri::Url::parse("https://example.org/docs/").unwrap();
        let html=r#"<link rel="icon" href="javascript:alert(1)">
        <link rel='icon' href='data:image/svg+xml,...'>
        <link rel="icon" href="http://example.org/favicon.png">
        <link rel="icon" href="https://user:pass@example.org/favicon.ico">
        <link href='../assets/icon.png' rel='ICON'>"#;
        assert_eq!(declared_site_icons(html,&page),
            vec!["https://example.org/assets/icon.png".to_string()]);
    }
    #[test]
    fn tolerate_case_and_attribute_order(){
        let page=tauri::Url::parse("https://example.org/").unwrap();
        let icons=declared_site_icons("<LINK HREF='/brand.svg?v=1&amp;x=2' TYPE='image/svg+xml' REL='shortcut icon'>",&page);
        assert_eq!(icons,vec!["https://example.org/brand.svg?v=1&x=2".to_string()]);
        assert_eq!(html_attribute("REL='icon' href=/favicon.ico","href").as_deref(),Some("/favicon.ico"));
    }
}

fn lookup_site_icons(url:&str)->Vec<String>{
    use std::io::Read;
    let Ok(mut page)=tauri::Url::parse(url) else{return Vec::new()};
    if page.scheme()!="https" || page.host_str().is_none() ||
       !page.username().is_empty() || page.password().is_some(){return Vec::new();}
    // Never probe local addresses as part of bookmark icon discovery.
    let host=page.host_str().unwrap_or_default().to_ascii_lowercase();
    if host=="localhost" || host.ends_with(".localhost") ||
       host.ends_with(".local") || host.parse::<std::net::IpAddr>().is_ok(){
        return Vec::new();
    }
    page.set_fragment(None);
    // Avoid forwarding bookmark URL search/query tokens in icon lookups.
    page.set_query(None);
    let agent=ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(2))
        .timeout_read(Duration::from_secs(3))
        .timeout_write(Duration::from_secs(2))
        .redirects(0)
        .build();
    for _ in 0..3 {
        let response=match agent.get(page.as_str()).set("Accept","text/html").call(){
            Ok(response)=>response,
            Err(ureq::Error::Status(code,response)) if (300..400).contains(&code)=>{
                let Some(location)=response.header("Location") else{break};
                let Ok(next)=page.join(location) else{break};
                if next.scheme()!="https" || !next.username().is_empty() ||
                   next.password().is_some() {break;}
                page=next;continue;
            },
            Err(_)=>break,
        };
        // GitHub Pages redirects /Project to /Project/. Preserve the
        // redirected page as the base for ./favicon.svg and similar links.
        if (300..400).contains(&response.status()) {
            let Some(location)=response.header("Location") else{break};
            let Ok(next)=page.join(location) else{break};
            if next.scheme()!="https" || next.host_str().is_none() ||
                !next.username().is_empty() || next.password().is_some(){break;}
            let host=next.host_str().unwrap_or_default().to_ascii_lowercase();
            if host=="localhost" || host.ends_with(".localhost") ||
                host.ends_with(".local") || host.parse::<std::net::IpAddr>().is_ok(){break;}
            page=next;continue;
        }
        let mime=response.header("Content-Type").unwrap_or("");
        if !mime.to_ascii_lowercase().contains("text/html"){break;}
        let mut data=Vec::new();
        if response.into_reader().take(262_144).read_to_end(&mut data).is_err(){break;}
        let html=String::from_utf8_lossy(&data);
        return declared_site_icons(&html,&page);
    }
    Vec::new()
}

fn percent_encode_search(text: &str) -> String {
    let mut output = String::new();
    for byte in text.as_bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(byte) {
            output.push(char::from(*byte));
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

fn dimensions(window: &tauri::Window) -> Result<(f64, f64), String> {
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let logical = size.to_logical::<f64>(scale);
    Ok((logical.width.max(1.0), logical.height.max(1.0)))
}

fn chrome_top(app: &tauri::AppHandle) -> f64 {
    let cache = app.state::<Mutex<LayoutCache>>();
    let bar_visible = cache.lock().map(|s| s.bookmark_bar_visible).unwrap_or(false);
    CHROME + if bar_visible { BOOKMARK_BAR } else { 0.0 }
}

fn split_rect(index:usize,count:usize,width:f64,height:f64,top:f64,
              horizontal:f64,vertical:f64)->(f64,f64,f64,f64){
    let left=(width*horizontal.clamp(0.2,0.8)).round();
    let right=width-left;
    let upper=(height*vertical.clamp(0.2,0.8)).round();
    let lower=height-upper;
    match count {
        2=>if index==0{(0.0,top,left,height)}else{(left,top,right,height)},
        3=>match index{
            0=>(0.0,top,left,height),
            1=>(left,top,right,upper),
            _=>(left,top+upper,right,lower)
        },
        4=>match index{
            0=>(0.0,top,left,upper),
            1=>(left,top,right,upper),
            2=>(0.0,top+upper,left,lower),
            _=>(left,top+upper,right,lower)
        },
        _=>(0.0,top,width,height)
    }
}

#[cfg(test)]
mod split_layout_tests {
    use super::split_rect;
    #[test]
    fn two_way_split_fills_entire_page() {
        assert_eq!(split_rect(0,2,1000.0,800.0,52.0,0.5,0.5),
                   (0.0,52.0,500.0,800.0));
        assert_eq!(split_rect(1,2,1000.0,800.0,52.0,0.5,0.5),
                   (500.0,52.0,500.0,800.0));
    }
    #[test]
    fn four_quadrants_fit_without_overlap_and_respect_resize() {
        let expected=[
            (0.0,52.0,600.0,280.0),
            (600.0,52.0,400.0,280.0),
            (0.0,332.0,600.0,520.0),
            (600.0,332.0,400.0,520.0)
        ];
        for i in 0..4 {
            assert_eq!(split_rect(i,4,1000.0,800.0,52.0,0.6,0.35),expected[i]);
        }
    }
    #[test]
    fn three_panes_put_one_full_height_on_left() {
        assert_eq!(split_rect(0,3,1000.0,800.0,52.0,0.5,0.5),
                   (0.0,52.0,500.0,800.0));
        assert_eq!(split_rect(2,3,1000.0,800.0,52.0,0.5,0.5),
                   (500.0,452.0,500.0,400.0));
    }
}

fn return_split_pane(app:&tauri::AppHandle,id:u32){
    let remaining={
        let state=app.state::<SplitState>();
        let Ok(mut split)=state.0.lock() else{return};
        split.retain(|entry|*entry!=id);
        if split.len()<2 {split.clear();}
        split.clone()
    };
    if remaining.len()>1 {
        let state=app.state::<Mutex<Browser>>();
        if let Ok(mut browser)=state.lock(){
            if browser.active_id==id {browser.active_id=remaining[0];}
        };
    }
    invalidate_layout(app);
    display_active(app);
}
#[cfg(windows)]
fn start_split_badge_drag(app:tauri::AppHandle,id:u32){
    std::thread::spawn(move||{
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState,VK_LBUTTON};
        let mut start=POINT::default();
        if unsafe{GetCursorPos(&mut start)}.is_err(){return;}
        let deadline=Instant::now()+Duration::from_secs(12);
        loop {
            std::thread::sleep(Duration::from_millis(16));
            if Instant::now()>=deadline{return;}
            if unsafe{GetAsyncKeyState(VK_LBUTTON.0 as i32)}>=0 {
                let mut end=POINT::default();
                if unsafe{GetCursorPos(&mut end)}.is_err(){return;}
                let Some(window)=app.get_window("main") else{return};
                let Ok(position)=window.outer_position() else{return};
                let Ok(scale)=window.scale_factor() else{return};
                let local_y=(end.y-position.y) as f64/scale;
                let local_x=(end.x-position.x) as f64/scale;
                let dx=end.x-start.x;
                let dy=end.y-start.y;
                // A short click is handled by the badge's Return button.
                // Dragging up into the actual tab strip unsplits this pane.
                if dx*dx+dy*dy>400 && (0.0..=22.0).contains(&local_y)
                    && local_x>=47.0 {
                    let handle=app.clone();
                    let _=app.run_on_main_thread(move||return_split_pane(&handle,id));
                }
                return;
            }
        }
    });
}
#[cfg(not(windows))]
fn start_split_badge_drag(_app:tauri::AppHandle,_id:u32){}


#[cfg(windows)]
fn start_split_badge_resize(app:tauri::AppHandle,id:u32){
    std::thread::spawn(move||{
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState,VK_LBUTTON};
        let Some(window)=app.get_window("main") else{return};
        let Ok(origin)=window.outer_position() else{return};
        let Ok(scale)=window.scale_factor() else{return};
        let Ok((width,height))=dimensions(&window) else{return};
        let top=chrome_top(&app);
        let available=(height-top).max(1.0);
        let (count,index)={
            let state=app.state::<SplitState>();
            let Ok(split)=state.0.lock() else{return};
            (split.len(),split.iter().position(|pane|*pane==id).unwrap_or(0))
        };
        if count<2{return;}
        let mut first=POINT::default();
        if unsafe{GetCursorPos(&mut first)}.is_err(){return;}
        let mut recorded=false;
        let mut previous=(0.0f64,0.0f64);
        let until=Instant::now()+Duration::from_secs(15);
        loop{
            std::thread::sleep(Duration::from_millis(34));
            if Instant::now()>=until{return;}
            if unsafe{GetAsyncKeyState(VK_LBUTTON.0 as i32)}>=0{return;}
            let mut pos=POINT::default();
            if unsafe{GetCursorPos(&mut pos)}.is_err(){return;}
            let dx=(pos.x-first.x).abs();
            let dy=(pos.y-first.y).abs();
            if dx+dy<5{continue;}
            let horizontal=(((pos.x-origin.x) as f64/scale)/width).clamp(0.2,0.8);
            let vertical=((((pos.y-origin.y) as f64/scale)-top)/available).clamp(0.2,0.8);
            if (previous.0-horizontal).abs()<0.01 &&
               (previous.1-vertical).abs()<0.01 {continue;}
            previous=(horizontal,vertical);
            let should_record=!recorded;
            recorded=true;
            let handle=app.clone();
            let _=app.run_on_main_thread(move||{
                if should_record{remember_undo(&handle,None);}
                let ratios=handle.state::<SplitRatios>();
                if let Ok(mut value)=ratios.0.lock(){
                    value.0=horizontal;
                    if count>3 || (count==3&&index>0){value.1=vertical;}
                };
                invalidate_layout(&handle);
                refresh_layout(&handle);
            });
        }
    });
}
#[cfg(not(windows))]
fn start_split_badge_resize(_app:tauri::AppHandle,_id:u32){}

fn update_split_badges(app:&tauri::AppHandle,window:&tauri::Window,
                       ids:&[u32],width:f64,height:f64,top:f64){
    let ratios=app.state::<SplitRatios>().0.lock().map(|r|*r).unwrap_or((0.5,0.5));
    let title_map={
        let state=app.state::<Mutex<Browser>>();
        let Ok(browser)=state.lock() else{return};
        browser.tabs.iter().map(|tab|(tab.id,tab.title.clone()))
            .collect::<HashMap<_,_>>()
    };
    for existing in window.webviews() {
        if !existing.label().starts_with("split-badge-"){continue;}
        let still_used=ids.iter().any(|id|existing.label()==format!("split-badge-{id}"));
        if !still_used {let _=existing.close();}
    }
    if ids.len()<2{return;}
    for (index,id) in ids.iter().enumerate(){
        let (x,y,w,_)=split_rect(index,ids.len(),width,height,top,ratios.0,ratios.1);
        let label=format!("split-badge-{id}");
        let position=LogicalPosition::new(x+6.0,y+6.0);
        let size=LogicalSize::new(w.min(190.0).max(40.0)-12.0,24.0);
        if let Some(view)=app.get_webview(&label){
            let _=view.set_position(position);
            let _=view.set_size(size);
            let _=view.show();
            continue;
        }
        let title=title_map.get(id).cloned().unwrap_or_else(||"Split Tab".into());
        let safe_title=serde_json::to_string(&title).unwrap_or_else(|_|"\"Split Tab\"".into());
        let callback_app=app.clone();
        let badge_id=*id;
        let builder=WebviewBuilder::new(label,WebviewUrl::App("split-badge.html".into()))
            .transparent(true)
            .on_navigation(move |url|{
                if url.host_str()==Some("minternet.invalid") {
                    match url.path(){
                        "/return"=>{
                            let handle=callback_app.clone();
                            let _=callback_app.run_on_main_thread(move||return_split_pane(&handle,badge_id));
                        },
                        "/drag"=>start_split_badge_drag(callback_app.clone(),badge_id),
                        "/resize"=>start_split_badge_resize(callback_app.clone(),badge_id),
                        _=>{}
                    }
                    return false;
                }
                let hostname=url.host_str().unwrap_or("");
                // A badge only ever loads its own packaged local HTML.
                url.scheme()=="tauri" || hostname=="tauri.localhost" || hostname=="localhost"
            })
            .on_page_load(move |view,event|{
                if matches!(event.event(),PageLoadEvent::Finished){
                    let _=view.eval(&format!("document.getElementById('title').textContent={safe_title};"));
                }
            });
        let _=window.add_child(builder,position,size);
    }
}

fn invalidate_layout(app:&tauri::AppHandle){
    let state=app.state::<Mutex<LayoutCache>>();
    if let Ok(mut cache)=state.lock(){
        cache.size_and_home=None;
    };
}
fn prune_splits(app:&tauri::AppHandle){
    let ids={
        let state=app.state::<Mutex<Browser>>();
        let result=state.lock().map(|b|b.tabs.iter().map(|t|t.id).collect::<HashSet<_>>()).unwrap_or_default();
        result
    };
    let state=app.state::<SplitState>();
    if let Ok(mut split)=state.0.lock(){
        split.retain(|id|ids.contains(id));
        if split.len()<2{split.clear();}
    }
    invalidate_layout(app);
}

fn visible_split(app:&tauri::AppHandle)->Vec<u32>{
    let list=app.state::<SplitState>().0.lock().map(|s|s.clone()).unwrap_or_default();
    let browser=app.state::<Mutex<Browser>>();
    let Ok(b)=browser.lock() else{return Vec::new()};
    if !list.contains(&b.active_id){return Vec::new();}
    list.into_iter().filter(|id|b.tabs.iter().any(|t|t.id==*id && t.url!=HOME)).take(4).collect()
}
// Child WebView2 windows have their own OS z-order. CSS z-index alone cannot
// paint above a later-created website WebView. On Windows WRY creates each
// top-level child controller with the WRY_WEBVIEW class; the browser chrome
// is the only one positioned at the top-left of the host client area.
// Raise that child only (not the application above other applications) when
// a trusted popup is open, leaving the live website visible underneath.
#[cfg(windows)]
fn raise_chrome_above_site(app:&tauri::AppHandle) {
    use windows::Win32::Foundation::{RECT,HWND};
    use windows::Win32::UI::WindowsAndMessaging::{
        FindWindowExW,GetWindowRect,SetWindowPos,HWND_TOP,
        SWP_NOACTIVATE,SWP_NOMOVE,SWP_NOSIZE,
    };
    use windows::core::{w,PCWSTR};
    let Some(window)=app.get_window("main") else {return};
    let Ok(parent)=window.hwnd() else {return};
    let Ok(origin)=window.inner_position() else {return};
    let mut previous:Option<HWND>=None;
    // Bounded to avoid infinite scanning if a third-party extension introduces
    // unexpected child windows. No site HWND is ever resized or hidden.
    for _ in 0..64 {
        let Ok(child)=(unsafe {
            FindWindowExW(Some(parent),previous,w!("WRY_WEBVIEW"),PCWSTR::null())
        }) else {break};
        previous=Some(child);
        let mut bounds=RECT::default();
        if unsafe {GetWindowRect(child,&mut bounds)}.is_err(){continue;}
        if (bounds.left-origin.x).abs()<=3 && (bounds.top-origin.y).abs()<=3 {
            let _=unsafe {
                SetWindowPos(child,Some(HWND_TOP),0,0,0,0,
                    SWP_NOACTIVATE|SWP_NOMOVE|SWP_NOSIZE)
            };
            break;
        }
    }
}
#[cfg(not(windows))]
fn raise_chrome_above_site(_app:&tauri::AppHandle){}

fn refresh_layout(app: &tauri::AppHandle) {
    let Some(window) = app.get_window("main") else { return };
    let Ok(physical) = window.inner_size() else { return };
    let Ok((width, height)) = dimensions(&window) else { return };
    let show_home = app.state::<Mutex<Browser>>()
        .lock()
        .map(|b| b.active().map(|t| t.url == HOME).unwrap_or(true))
        .unwrap_or(true);
    let split_signature=visible_split(app).iter().fold(0u64,|hash,id|hash.wrapping_mul(37).wrapping_add(*id as u64));
    let (bar_visible, overlay_open) = {
        let cache = app.state::<Mutex<LayoutCache>>();
        let Ok(mut state) = cache.lock() else { return };
        let signature = (
            physical.width, physical.height, show_home,
            state.bookmark_bar_visible, state.overlay_open, split_signature
        );
        if state.size_and_home == Some(signature) { return; }
        state.size_and_home = Some(signature);
        (state.bookmark_bar_visible, state.overlay_open)
    };
    let top = CHROME + if bar_visible { BOOKMARK_BAR } else { 0.0 };
    if let Some(chrome) = app.get_webview("chrome") {
        let full = show_home || overlay_open;
        let height_for_chrome = if full { height } else { top.min(height) };
        let _ = chrome.set_size(LogicalSize::new(width, height_for_chrome));
    }
    let available = (height - top).max(1.0);
    let positions=visible_split(app);
    let split_count=if positions.len()>1{positions.len()}else{0};
    let ratios=app.state::<SplitRatios>().0.lock().map(|r|*r).unwrap_or((0.5,0.5));
    for view in window.webviews() {
        if view.label() == "chrome" || view.label().starts_with("split-badge-") {continue;}
        let index=if split_count>0 {
            positions.iter().position(|id|view.label()==format!("tab-{id}"))
        }else{None};
        let (x,y,w,h)=if let Some(index)=index {
            split_rect(index,split_count,width,available,top,ratios.0,ratios.1)
        }else{(0.0,top,width,available)};
        let _ = view.set_position(LogicalPosition::new(x,y));
        let _ = view.set_size(LogicalSize::new(w.max(1.0),h.max(1.0)));
    }
    update_split_badges(app,&window,if split_count>1 {positions.as_slice()} else {&[]},width,available,top);
    if overlay_open {raise_chrome_above_site(app);}
}
fn display_active(app: &tauri::AppHandle) {
    let mut targets=HashSet::new();
    {
        // Keep all site views visible and at identical positions while trusted
        // chrome menus open. The chrome overlay is transparent outside panels.
        let split=visible_split(app);
        let browser=app.state::<Mutex<Browser>>();
        let Ok(mut b)=browser.lock() else{return};
        // Arm the idle timer only when a tab is no longer selected. Merely
        // opening the browser or rendering an updated toolbar is not idle time.
        let active=b.active_id;
        let now=Instant::now();
        for tab in &mut b.tabs {
            if tab.id==active { tab.inactive_since=None; }
            else if tab.inactive_since.is_none(){tab.inactive_since=Some(now);}
        }
        if split.len()>1{
            for id in split {
                if let Some(tab)=b.tabs.iter().find(|t|t.id==id){
                    if let Some(label)=&tab.view{targets.insert(label.clone());}
                }
            }
        }else if let Some(label)=b.active().and_then(|tab|{
            if tab.url==HOME{None}else{tab.view.clone()}
        }){targets.insert(label);}
    }
    refresh_layout(app);
    let (to_hide,to_show)={
        let cache=app.state::<Mutex<LayoutCache>>();
        let Ok(mut state)=cache.lock() else{return};
        if state.shown==targets {notify(app);return;}
        let hidden=state.shown.difference(&targets).cloned().collect::<Vec<_>>();
        let shown=targets.difference(&state.shown).cloned().collect::<Vec<_>>();
        state.shown=targets.clone();
        (hidden,shown)
    };
    for label in to_hide{
        if let Some(view)=app.get_webview(&label){let _=view.hide();}
    }
    for label in to_show{
        if let Some(view)=app.get_webview(&label){
            let zoom=app.state::<ZoomState>().0.lock().map(|n|*n).unwrap_or(1.0);
            let _=view.set_zoom(zoom);
            let _=view.show();
        }
    }
    notify(app);
}

fn update_from_site(app: &tauri::AppHandle, id: u32, url: &str) {
    if !url.starts_with("https://") && !url.starts_with("http://") { return; }
    let mut pinned_change=false;
    {
        let state=app.state::<Mutex<Browser>>();
        if let Ok(mut browser)=state.lock(){
            if let Some(tab)=browser.tabs.iter_mut().find(|tab|tab.id==id){
                if tab.secret_id.is_some(){return;}
                if tab.url!=url {
                    pinned_change=tab.pinned && !tab.private;
                    tab.url=url.into();
                    if tab.history.get(tab.at).map(|s|s.as_str())!=Some(url) {
                        tab.history.truncate(tab.at+1);
                        tab.history.push(url.into());
                        tab.at=tab.history.len()-1;
                    }
                }
                if tab.title=="New Tab"{tab.title=title_for(url);}
            }
        };
    }
    if pinned_change{let _=save_pinned(app);}
    notify(app);
}

fn record_page_history(app:&tauri::AppHandle,id:u32,url:&str,title_hint:Option<&str>){
    let details={
        let state=app.state::<Mutex<Browser>>();
        let Ok(b)=state.lock() else{return};
        let Some(tab)=b.tabs.iter().find(|t|t.id==id) else{return};
        if tab.private||tab.secret_id.is_some(){return;}
        (tab.title.clone(),tab.url.clone())
    };
    if details.1!=url{return;}
    let history=app.state::<Mutex<browsing_history::History>>();
    let Ok(mut saved)=history.lock() else{return};
    let changed=if let Some(title)=title_hint {
        if !saved.retitle(url,title){saved.visit(url,title)}else{true}
    }else{saved.visit(url,&details.0)};
    if changed{
        let _=saved.save(app);
        let _=app.emit_to("chrome","minternet:history-changed",());
    }
}

fn create_webview(app: &tauri::AppHandle, id: u32, url: WebviewUrl, private: bool) -> Result<(), String> {
    let Some(window) = app.get_window("main") else { return Err("Missing window".into()) };
    let label = format!("tab-{id}");
    let (width, height) = dimensions(&window)?;
    let top = chrome_top(app);
    let for_load = app.clone();
    let for_title = app.clone();
    let for_popup = app.clone();
    let for_download=app.clone();
    let builder = WebviewBuilder::new(label.clone(), url)
        .incognito(private)
        // Honor Ctrl/Cmd + plus/minus and Ctrl + mouse-wheel when focus is
        // inside the actual website WebView, not just the browser toolbar.
        .zoom_hotkeys_enabled(true)
        // Do not block internal warmup.html: the prepared WebView2 controller
        // must actually load before its first HTTPS navigation. Ordinary HTTP
        // is legitimate browser content but remains visibly marked insecure.
        .on_navigation(|url| {
            if matches!(url.scheme(), "https"|"http") {
                return url.host_str().is_some();
            }
            url.as_str()=="about:blank" ||
                ((url.scheme()=="tauri" || url.host_str()==Some("tauri.localhost"))
                 && url.path()=="/warmup.html")
        })
        .on_permission_request(|_view, _kind| PermissionResponse::Deny)
        .on_download(move |_view,event|{
            match event {
                DownloadEvent::Requested{url,destination}=>{
                    if url.scheme()!="https" {return false;}
                    match download_path(&for_download,&url,destination.as_path()){
                        Ok(path)=>{
                            *destination=path.clone();
                            download_update(&for_download,&url,Some(&path),private,None);
                            true
                        },
                        Err(_)=>false
                    }
                },
                DownloadEvent::Finished{url,path,success}=>{
                    download_update(&for_download,&url,path.as_deref(),private,Some(success));
                    true
                },
                _=>true
            }
        })
        .on_new_window(move |url, features| {
            if is_auth_popup_url(&url) {
                // Create a real WebView2 popup using the opener's *same*
                // environment. Passing the original window features is
                // critical for window.opener, cookies, and private profiles.
                // Do not navigate it ourselves: WebView2 attaches the new
                // controller to the original NewWindowRequested handshake.
                // This also handles apps that first open about:blank.
                let open_popups = for_popup.webview_windows().keys()
                    .filter(|name|name.starts_with("auth-popup-")).count();
                if open_popups >= 8 { return NewWindowResponse::Deny; }
                let label=format!("auth-popup-{}",
                    NEXT_AUTH_POPUP_ID.fetch_add(1,Ordering::Relaxed));
                let builder=WebviewWindowBuilder::new(
                        &for_popup,label,WebviewUrl::External(
                            tauri::Url::parse("about:blank").expect("valid blank URL")))
                    .window_features(features)
                    .title("Sign in — Minternet")
                    .inner_size(540.0,680.0)
                    .resizable(true)
                    .on_navigation(|destination| {
                        matches!(destination.scheme(),"https"|"http")
                            && destination.host_str().is_some()
                            || destination.as_str()=="about:blank"
                    })
                    // Treat remote login content like a website, not app
                    // chrome. Never add a native bridge or read OAuth codes.
                    .on_document_title_changed(|window,title| {
                        let safe=title.chars().take(100).collect::<String>();
                        if !safe.is_empty(){let _=window.set_title(&safe);}
                    });
                return match builder.build() {
                    Ok(window)=>NewWindowResponse::Create{window},
                    Err(error)=>{
                        eprintln!("Cannot create related sign-in popup: {error}");
                        NewWindowResponse::Deny
                    }
                };
            }
            if matches!(url.scheme(),"https"|"http") && url.host_str().is_some() {
                // Normal Ctrl-click and plain-link requests still become
                // Minternet tabs. Only auth handshakes use a related window.
                let key=(id,url.to_string());
                let state=for_popup.state::<PopupDeduper>();
                let should_open=if let Ok(mut recent)=state.0.lock(){
                    let now=Instant::now();
                    recent.retain(|_,t|now.duration_since(*t)<Duration::from_millis(900));
                    if recent.get(&key).map(|t|now.duration_since(*t)<Duration::from_millis(250)).unwrap_or(false){
                        false
                    }else{recent.insert(key,now);true}
                }else{false};
                if should_open{
                    let _=for_popup.emit_to("chrome","minternet:open-tab",json!({"url":url.to_string(),"private":private,"openerTabId":id}));
                }
            }
            NewWindowResponse::Deny
        })
        .on_page_load(move |view, event| {
            if matches!(event.event(), PageLoadEvent::Started | PageLoadEvent::Finished) {
                {
                    let state=for_load.state::<Mutex<Browser>>();
                    if let Ok(mut b)=state.lock(){
                        if let Some(tab)=b.tabs.iter_mut().find(|tab|tab.id==id){
                            tab.loading=matches!(event.event(),PageLoadEvent::Started);
                            tab.checking_unload=false;
                        }
                    };
                }
                update_from_site(&for_load, id, event.url().as_str());
                if matches!(event.event(), PageLoadEvent::Finished) {
                    record_page_history(&for_load,id,event.url().as_str(),None);
                    let _=fill_saved_credential(&for_load,id,false,None);
                    // Only a prompt typed into the trusted browser address bar
                    // can enable ChatGPT auto-submit. External URLs never do.
                    if event.url().host_str()==Some("chatgpt.com"){
                        let pending={
                            let state=for_load.state::<Mutex<Browser>>();
                            let result=state.lock().ok().and_then(|mut b|
                                b.tabs.iter_mut().find(|tab|tab.id==id)
                                    .and_then(|tab|tab.pending_chatgpt.take()));
                            result
                        };
                        if let Some(request)=pending {
                            let safe=serde_json::to_string(&json!({
                                "text":request.text,"temporary":request.temporary
                            })).unwrap_or_else(|_|"null".into());
                            let script=format!("(function(){{const minternetChatRequest={safe};\n{}\n}})();",
                                include_str!("../../../../ui/chatgpt-autosend.js"));
                            let _=view.eval(&script);
                        }
                    }
                }
            }
        })
        .on_document_title_changed(move |_view, title| {
            let state = for_title.state::<Mutex<Browser>>();
            let mut confirmed_in_app = false;
            if let Ok(mut browser) = state.lock() {
                if let Some(tab) = browser.tabs.iter_mut().find(|tab| tab.id == id) {
                    if tab.secret_id.is_some(){return;}
                    // A real webview title from example.com is observable
                    // only after the website loaded inside this child WebView.
                    confirmed_in_app = tab.url.starts_with("https://example.com/")
                        && title.contains("Example Domain")
                        && tab.view.is_some();
                    tab.title = title.chars().take(140).collect();
                }
            }
            if confirmed_in_app && std::env::args().any(|a| a == "--minternet-smoke" || a == "--minternet-turbo-smoke") {
                let marker = std::env::temp_dir()
                    .join(format!("minternet-inapp-{}.ok", std::process::id()));
                let _ = std::fs::write(marker, "Example Domain loaded in Minternet WebView2");
            }
            if let Some(badge)=for_title.get_webview(&format!("split-badge-{id}")){
                let safe=serde_json::to_string(&title).unwrap_or_else(|_|"\"Split Tab\"".into());
                let _=badge.eval(&format!("document.getElementById('title').textContent={safe};"));
            }
            // The title callback may arrive after the first page-load event.
            // Update the matching non-private history entry only.
            let current=for_title.state::<Mutex<Browser>>().lock().ok()
                .and_then(|b|b.tabs.iter().find(|t|t.id==id).map(|t|t.url.clone()));
            if let Some(url)=current {record_page_history(&for_title,id,&url,Some(&title));}
            notify(&for_title);
        });
    let zoom=app.state::<ZoomState>().0.lock().map(|n|*n).unwrap_or(1.0);
    let created=window.add_child(
        builder,
        LogicalPosition::new(0.0, top),
        LogicalSize::new(width, (height - top).max(1.0)),
    ).map_err(|e| e.to_string())?;
    let _=created.set_zoom(zoom);
    let state = app.state::<Mutex<Browser>>();
    let mut browser = state.lock().map_err(|e| e.to_string())?;
    if let Some(tab) = browser.tabs.iter_mut().find(|tab| tab.id == id) {
        tab.view = Some(label);
    }
    let background=browser.active_id!=id;
    drop(browser);
    // An unselected new WebView must never cover the current page, even when
    // display_active skips a no-op visibility refresh for the selected tab.
    if background {let _=created.hide();}
    Ok(())
}



#[cfg(windows)]
fn update_audio_state(app:&tauri::AppHandle,id:u32,playing:bool,muted:bool){
    let mut changed=false;
    {
        let state=app.state::<Mutex<Browser>>();
        if let Ok(mut browser)=state.lock(){
            if let Some(tab)=browser.tabs.iter_mut().find(|t|t.id==id){
                changed=tab.audio_playing!=playing||tab.audio_muted!=muted;
                tab.audio_playing=playing;
                tab.audio_muted=muted;
            }
        };
    }
    if changed{notify(app);}
}
#[cfg(windows)]
fn native_audio_poll(app:&tauri::AppHandle,id:u32,label:&str)->Result<(),String>{
    let Some(view)=app.get_webview(label) else{return Ok(())};
    let handle=app.clone();
    view.with_webview(move |native| {
        use windows::core::Interface;
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
        if let Ok(audio)=(unsafe{native.controller().CoreWebView2()}).and_then(|webview|webview.cast::<ICoreWebView2_8>()){
            let mut playing=windows::core::BOOL::default();
            let mut muted=windows::core::BOOL::default();
            let _=unsafe{audio.IsDocumentPlayingAudio(&mut playing)};
            let _=unsafe{audio.IsMuted(&mut muted)};
            let playing=playing.as_bool();
            let muted=muted.as_bool();
            update_audio_state(&handle,id,playing,muted);
        }
    }).map_err(|e|e.to_string())?;
    Ok(())
}

fn fill_saved_credential(app:&tauri::AppHandle,id:u32,manual:bool,username:Option<&str>)->Result<bool,String>{
    let (label,address,private)={
        let browser=app.state::<Mutex<Browser>>();
        let b=browser.lock().map_err(|e|e.to_string())?;
        let tab=b.tabs.iter().find(|t|t.id==id).ok_or("Tab not found")?;
        (tab.view.clone(),tab.url.clone(),tab.private)
    };
    if private{return Ok(false);}
    let Some(label)=label else {return Ok(false)};
    let Some(view)=app.get_webview(&label) else{return Ok(false)};
    let actual=view.url().map_err(|e|e.to_string())?;
    let actual_origin=password_vault::origin(actual.as_str())?;
    let tab_origin=password_vault::origin(&address)?;
    if actual_origin!=tab_origin{return Ok(false);}
    let credential={
        let state=app.state::<Mutex<password_vault::Vault>>();
        let vault=state.lock().map_err(|e|e.to_string())?;
        vault.matching(&actual_origin,manual,username)
    };
    let Some(mut entry)=credential else {return Ok(false)};
    let values=serde_json::json!({"origin":actual_origin,"username":entry.username,"password":entry.password});
    // JSON escaping prevents credential values from becoming executable code.
    let script=format!(r#"(function(){{
        'use strict';
        const data={};
        if(location.origin!==data.origin || window.top!==window)return;
        const visible=e=>!e.disabled&&!e.readOnly&&e.getClientRects().length>0;
        const passwords=[...document.querySelectorAll('input[type="password"]')].filter(visible);
        // Never populate registration, confirmation or password-change forms.
        if(passwords.length!==1)return;
        const password=passwords[0];
        const form=password.form||document;
        const inputs=[...form.querySelectorAll('input')].filter(visible);
        const user=inputs.find(e=>e.autocomplete==='username')||
            inputs.find(e=>e.type==='email')||
            inputs.find(e=>e.type==='text'&&/user|email|login/i.test(e.name+' '+e.id));
        const put=(element,value)=>{{
            if(!element)return;
            const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
            if(setter)setter.call(element,value);else element.value=value;
            element.dispatchEvent(new Event('input',{{bubbles:true}}));
            element.dispatchEvent(new Event('change',{{bubbles:true}}));
        }};
        put(user,data.username);put(password,data.password);
    }})();"#,values);
    use zeroize::Zeroize;
    entry.password.zeroize();
    view.eval(&script).map_err(|e|e.to_string())?;
    Ok(true)
}

// Prepare one lightweight WebView2 controller only after the user focuses a
// blank tab's address input. This does not connect to sites or leak typed URLs.
fn fill_payment_card(app:&tauri::AppHandle,id:&str)->Result<bool,String>{
    let (label,url)={
        let state=app.state::<Mutex<Browser>>();
        let browser=state.lock().map_err(|e|e.to_string())?;
        let tab=browser.active().ok_or("No active tab")?;
        let label=tab.view.clone().ok_or("No active webpage")?;
        (label,tab.url.clone())
    };
    let origin=password_vault::origin(&url)?;
    let mut card={
        let state=app.state::<Mutex<password_vault::Vault>>();
        let vault=state.lock().map_err(|e|e.to_string())?;
        vault.card(id).ok_or("Unlock the vault and choose a saved card")?
    };
    let webview=app.get_webview(&label).ok_or("No active webpage")?;
    let actual=webview.url().map_err(|e|e.to_string())?;
    if password_vault::origin(actual.as_str())?!=origin{
        return Err("Website changed; choose the card again".into());
    }
    // The PAN travels directly from the encrypted native vault to the one
    // user-selected HTTPS page. It never travels through chrome IPC or UI lists.
    // CVV is never stored or filled.
    let payload=json!({
        "name":card.name,"number":card.number,"month":card.month,
        "year":card.year,"postal":card.postal
    });
    let script=format!(r#"(function(){{
      'use strict';
      const card={payload};
      const inputs=[...document.querySelectorAll('input')].filter(el=>{{
        if(el.disabled||el.readOnly||el.type==='hidden'||el.type==='password')return false;
        const rect=el.getBoundingClientRect();
        return rect.width>0&&rect.height>0;
      }});
      const set=(el,value)=>{{
        if(!el||el.value)return;
        const nativeSet=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
        if(nativeSet)nativeSet.call(el,String(value));else el.value=String(value);
        el.dispatchEvent(new Event('input',{{bubbles:true}}));
        el.dispatchEvent(new Event('change',{{bubbles:true}}));
      }};
      const byAuto=(name)=>inputs.find(el=>el.autocomplete.toLowerCase().split(/\s+/).includes(name));
      const byName=(regex)=>inputs.find(el=>regex.test((el.name||'')+' '+(el.id||''))&&
        !/cvv|cvc|security.?code|verification/.test((el.name||'')+' '+(el.id||'')));
      set(byAuto('cc-name')||byName(/card.?holder|name.?on.?card/i),card.name);
      set(byAuto('cc-number')||byName(/cc.?number|card.?number|credit.?card/i),card.number);
      set(byAuto('cc-exp-month'),String(card.month).padStart(2,'0'));
      set(byAuto('cc-exp-year'),String(card.year));
      set(byAuto('cc-exp')||byName(/card.?expir|cc.?exp(?!-month|-year)/i),
        String(card.month).padStart(2,'0')+'/'+String(card.year).slice(-2));
      set(byAuto('cc-postal-code'),card.postal);
    }})()"#);
    card.number.zeroize();
    webview.eval(&script).map_err(|e|e.to_string())?;
    Ok(true)
}
fn prepare_active(app: &tauri::AppHandle) -> Result<(), String> {
    let (id, original_private) = {
        let store = app.state::<Mutex<Browser>>();
        let mut b = store.lock().map_err(|e| e.to_string())?;
        let Some(tab) = b.active() else { return Ok(()) };
        if tab.url != HOME || tab.view.is_some() || b.warming.contains(&tab.id) {
            return Ok(());
        }
        let (id, private) = (tab.id, tab.private);
        b.warming.insert(id);
        (id, private)
    };
    let created = create_webview(
        app, id, WebviewUrl::App("warmup.html".into()), original_private
    );
    let current = {
        let store = app.state::<Mutex<Browser>>();
        let mut b = store.lock().map_err(|e| e.to_string())?;
        b.warming.remove(&id);
        b.tabs.iter().find(|t| t.id == id)
            .map(|t| (t.url.clone(), t.private, b.active_id == id))
    };
    if let Err(err) = created {
        // If Enter beat warmup, recover by making the real browser tab normally.
        if let Some((url, _, _)) = current {
            if url != HOME {
                return navigate_tab(
                    app, id, Some(tauri::Url::parse(&url).map_err(|e| e.to_string())?), false
                );
            }
        }
        return Err(err);
    }

    let label = format!("tab-{id}");
    let Some(view) = app.get_webview(&label) else { return Ok(()) };
    // A prepared tab may no longer be selected. Never expose a background
    // controller on top of the currently visible website.
    let _ = view.hide();

    match current {
        Some((url, current_private, active)) if current_private != original_private => {
            // Critical isolation rule: a concurrently switched private tab MUST
            // NOT reuse a normal-mode controller (or the reverse).
            let _ = view.close();
            {
                let store = app.state::<Mutex<Browser>>();
                let mut b = store.lock().map_err(|e| e.to_string())?;
                if let Some(t) = b.tabs.iter_mut().find(|t| t.id == id) {
                    if t.view.as_deref() == Some(label.as_str()) { t.view = None; }
                }
            }
            if url != HOME {
                navigate_tab(
                    app, id, Some(tauri::Url::parse(&url).map_err(|e| e.to_string())?), false
                )?;
            } else if active {
                display_active(app);
            }
        }
        Some((url, _, active)) if url != HOME => {
            // Enter may have arrived during initialization. The same prepared
            // controller can now navigate, avoiding a second WebView2 startup.
            view.navigate(tauri::Url::parse(&url).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            if active { display_active(app); }
        }
        Some(_) => { /* Empty tab stays hidden until the first navigation. */ }
        None => { let _ = view.close(); } // Tab was closed while preparing.
    }

    if std::env::args().any(|a| a == "--minternet-turbo-smoke") {
        let marker = std::env::temp_dir()
            .join(format!("minternet-prepared-{}.ok", std::process::id()));
        let _ = std::fs::write(marker, "WebView2 tab created before navigation");
    }
    Ok(())
}

fn navigate_tab(app: &tauri::AppHandle, id: u32, url: Option<tauri::Url>, append: bool) -> Result<(), String> {
    let str_url = url.as_ref().map(|u| u.as_str()).unwrap_or(HOME).to_string();
    let (existing, private, warming, save_url) = {
        let state = app.state::<Mutex<Browser>>();
        let mut browser = state.lock().map_err(|e| e.to_string())?;
        let warming = browser.warming.contains(&id);
        let tab = browser.tabs.iter_mut().find(|t| t.id == id).ok_or("Tab not found")?;
        let save_url=tab.pinned&&!tab.private&&tab.url!=str_url;
        if append && tab.url != str_url {
            tab.history.truncate(tab.at + 1);
            tab.history.push(str_url.clone());
            tab.at = tab.history.len()-1;
        }
        tab.url = str_url.clone();
        tab.title = title_for(&str_url);
        tab.loading=url.is_some();
        tab.checking_unload=false;
        (tab.view.clone(), tab.private, warming, save_url)
    };
    if let Some(url) = url {
        if warming && existing.is_none() {
            // Prepare command will navigate the controller after it is ready.
            display_active(app);
            return Ok(());
        }
        if let Some(label) = existing {
            if let Some(view) = app.get_webview(&label) {
                view.navigate(url).map_err(|e| e.to_string())?;
            } else {
                create_webview(app, id, WebviewUrl::External(url), private)?;
            }
        } else {
            create_webview(app, id, WebviewUrl::External(url), private)?;
        }
    } else if let Some(label) = existing {
        if let Some(view) = app.get_webview(&label) { let _ = view.close(); }
        let state = app.state::<Mutex<Browser>>();
        if let Ok(mut b) = state.lock() {
            if let Some(tab) = b.tabs.iter_mut().find(|t| t.id == id) { tab.view = None; }
        };
    }
    if save_url {let _=save_pinned(app);}
    display_active(app);
    Ok(())
}

fn activated(app: &tauri::AppHandle) -> Result<(), String> {
    let current={
        let state=app.state::<Mutex<Browser>>();
        let b=state.lock().map_err(|e|e.to_string())?;
        b.active().map(|tab|(tab.id,tab.url.clone(),tab.view.is_some()))
    };
    let Some((id,url,view_exists))=current else {
        display_active(app);
        return Ok(());
    };
    let pending_secret={
        let store=app.state::<Mutex<Browser>>();
        store.lock().ok().and_then(|b|b.tabs.iter().find(|t|t.id==id)
            .map(|t|t.secret_id.is_some()&&!t.secret_revealed)).unwrap_or(false)
    };
    // Even activation of a suspended Secret Tab never loads it.
    if pending_secret {display_active(app);return Ok(());}
    if url != HOME && !view_exists {
        navigate_tab(app, id, Some(tauri::Url::parse(&url).map_err(|e| e.to_string())?), false)?;
    } else { display_active(app); }
    Ok(())
}

// A tab may only be auto-discarded when the document itself confirms that it
// is settled. Any failed evaluation fails closed (retains the renderer). This
// reads DOM state, never page text, credentials, or form values into Minternet.
// No arbitrary external page is given permission to send native commands.
const AUTO_UNLOAD_ELIGIBILITY: &str = r#"(() => {
  try {
    if (document.readyState !== 'complete' || document.hasFocus()) return false;
    if (window.onbeforeunload !== null) return false;
    if (document.pictureInPictureElement) return false;
    if (navigator.mediaSession?.playbackState === 'playing') return false;
    if (document.querySelector('iframe,object,embed,canvas,[aria-busy="true"],[role="progressbar"],progress,.spinner,.loading,[data-loading="true"]')) return false;
    if ([...document.querySelectorAll('audio,video')].some(m =>
        !m.paused || m.seeking || m.networkState === m.NETWORK_LOADING ||
        (m.currentSrc && m.readyState < m.HAVE_FUTURE_DATA))) return false;
    if ([...document.querySelectorAll('input,textarea,select')].some(e => {
      if (e.type === 'hidden' || e.type === 'submit' || e.type === 'button' || e.type === 'reset') return false;
      if (e.type === 'checkbox' || e.type === 'radio') return e.checked !== e.defaultChecked;
      if (e.type === 'file') return e.files?.length > 0;
      if (e.tagName === 'SELECT') return [...e.options].some(o => o.selected !== o.defaultSelected);
      return Boolean(e.value);
    })) return false;
    if ([...document.querySelectorAll('[contenteditable="true"],[role="textbox"]')]
        .some(e => e.textContent?.trim())) return false;
    const entries=performance.getEntriesByType('resource');
    if (entries.length) {
      const latest=entries[entries.length-1];
      if (performance.now()-(latest.responseEnd||latest.startTime) < 15000) return false;
    }
    return true;
  } catch { return false; }
})()"#;

// The user-configured policy is checked every ten seconds by trusted chrome.
// Page requests, media playback, entered values and split-visible tabs block
// auto-unload; evaluation errors or unknown documents are never destroyed.
fn check_idle_tabs(app:&tauri::AppHandle, minutes:u64) -> Result<(),String>{
    if minutes==0 || minutes>120 {return Ok(());}
    let idle=Duration::from_secs(minutes*60);
    let split=app.state::<SplitState>().0.lock().map_err(|e|e.to_string())?.clone();
    let downloads_busy=app.state::<DownloadsState>().0.lock().map_err(|e|e.to_string())?
        .iter().any(|d|d.status=="downloading");
    if downloads_busy {return Ok(());}
    let candidates={
        let store=app.state::<Mutex<Browser>>();
        let mut b=store.lock().map_err(|e|e.to_string())?;
        let active=b.active_id;
        let now=Instant::now();
        b.tabs.iter_mut().filter_map(|tab|{
            if tab.id==active || split.contains(&tab.id) ||
                tab.loading || tab.audio_playing || tab.checking_unload || tab.url==HOME {
                return None;
            }
            let since=tab.inactive_since?;
            if now.duration_since(since)<idle {return None;}
            let label=tab.view.clone()?;
            tab.checking_unload=true;
            Some((tab.id,label,since))
        }).collect::<Vec<_>>()
    };
    for (id,label,since) in candidates {
        let handle=app.clone();
        let captured=label.clone();
        let Some(view)=app.get_webview(&label) else {
            if let Ok(mut b)=app.state::<Mutex<Browser>>().lock(){
                if let Some(tab)=b.tabs.iter_mut().find(|t|t.id==id){tab.checking_unload=false;}
            }
            continue;
        };
        let evaluation=view.eval_with_callback(AUTO_UNLOAD_ELIGIBILITY,move |response|{
            let eligible=response.trim()=="true";
            let split_visible=handle.state::<SplitState>().0.lock().map(|s|s.contains(&id)).unwrap_or(true);
            let released={
                let store=handle.state::<Mutex<Browser>>();
                let result=if let Ok(mut b)=store.lock(){
                    let is_active=b.active_id==id;
                    if let Some(tab)=b.tabs.iter_mut().find(|t|t.id==id){
                        tab.checking_unload=false;
                        if eligible && !is_active && !split_visible && !tab.loading &&
                            !tab.audio_playing && tab.view.as_deref()==Some(captured.as_str()) &&
                            tab.inactive_since==Some(since) &&
                            Instant::now().duration_since(since)>=idle {
                            tab.loading=false;tab.audio_playing=false;tab.audio_muted=false;
                            tab.view.take()
                        }else{None}
                    }else{None}
                }else{None};
                result
            };
            if let Some(label)=released {
                if let Some(view)=handle.get_webview(&label){let _=view.close();}
                notify(&handle);
            }
        });
        if evaluation.is_err(){
            if let Ok(mut b)=app.state::<Mutex<Browser>>().lock(){
                if let Some(tab)=b.tabs.iter_mut().find(|t|t.id==id){tab.checking_unload=false;}
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn browser_snapshot(app: tauri::AppHandle) -> Result<Snapshot,String> { snapshot(&app) }

#[tauri::command]
async fn browser_action(app: tauri::AppHandle, name: String, value: Value) -> Result<Value, String> {
    // OAuth, Drive and Gmail are only available to the trusted local chrome.
    // All remote network calls run on worker threads so they never pause the
    // native browser event loop. No Google token is returned to web content.
    if name=="live-sync-auth" {
        let url=value.get("url").and_then(Value::as_str)
            .ok_or("Supabase project URL is required")?.to_owned();
        let key=value.get("publishableKey").and_then(Value::as_str)
            .ok_or("Supabase publishable key is required")?.to_owned();
        let handle=app.clone();
        return tauri::async_runtime::spawn_blocking(move||
            google_account::live_auth(
                &handle.state::<Mutex<google_account::GoogleState>>(),
                &url,&key))
            .await.map_err(|e|e.to_string())?;
    }
    // Secret bookmarks use a dedicated, password-derived native key. Only
    // visible aliases and opaque IDs cross into the trusted chrome; no URL is
    // returned by list, open, edit or preview operations.
    if name=="secret-status"{
        let path=secret_bookmarks::file(&app)?;
        let vault=app.state::<Mutex<secret_bookmarks::SecretVault>>();
        return vault.lock().map_err(|e|e.to_string())?.status(&path);
    }
    if name=="secret-auth"{
        let code=value.get("code").and_then(Value::as_str)
            .ok_or("Enter the Secret Bookmarks code")?.to_owned();
        let create=value.get("create").and_then(Value::as_bool)==Some(true);
        let handle=app.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            let path=secret_bookmarks::file(&handle)?;
            let state=handle.state::<Mutex<secret_bookmarks::SecretVault>>();
            state.lock().map_err(|e|e.to_string())?.open(&path,&code,create)
        }).await.map_err(|e|e.to_string())?;
    }
    if name=="secret-lock"{
        let vault=app.state::<Mutex<secret_bookmarks::SecretVault>>();
        vault.lock().map_err(|e|e.to_string())?.lock();
        return Ok(json!({"ok":true}));
    }
    if matches!(name.as_str(),"secret-put"|"secret-delete"|"secret-edit"|"secret-move"){
        let path=secret_bookmarks::file(&app)?;
        let vault=app.state::<Mutex<secret_bookmarks::SecretVault>>();
        let mut secret=vault.lock().map_err(|e|e.to_string())?;
        return match name.as_str(){
            "secret-put" => secret.put(
                &path,
                value.get("kind").and_then(Value::as_str).ok_or("Missing bookmark kind")?,
                value.get("parent").and_then(Value::as_str),
                value.get("visibleName").and_then(Value::as_str).unwrap_or(""),
                value.get("url").and_then(Value::as_str),
                value.get("title").and_then(Value::as_str)
            ),
            "secret-delete" => secret.delete(&path,
                value.get("id").and_then(Value::as_str).ok_or("Missing bookmark ID")?),
            "secret-edit" => secret.edit(&path,
                value.get("id").and_then(Value::as_str).ok_or("Missing bookmark ID")?,
                value.get("visibleName").and_then(Value::as_str).unwrap_or("")),
            "secret-move" => secret.move_inside(&path,
                value.get("id").and_then(Value::as_str).ok_or("Missing bookmark ID")?,
                value.get("parent").and_then(Value::as_str)),
            _ => unreachable!()
        };
    }
    if name=="secret-open"{
        let wanted=value.get("ids").and_then(Value::as_array)
            .ok_or("Choose Secret Bookmarks")?;
        if wanted.is_empty()||wanted.len()>MAX_TABS{
            return Err("Choose up to 35 Secret Bookmarks".into());
        }
        // One successful passcode entry authorizes the entire selected batch.
        // Validate every ID before creating even one tab.
        let secrets=app.state::<Mutex<secret_bookmarks::SecretVault>>();
        let secret=secrets.lock().map_err(|e|e.to_string())?;
        if !secret.unlocked(){return Err("Enter your Secret Bookmarks code first".into());}
        for item in wanted{
            let id=item.as_str().ok_or("Invalid Secret Bookmark ID")?;
            secret.link(id)?;
        }
        drop(secret);
        let browser=app.state::<Mutex<Browser>>();
        let mut b=browser.lock().map_err(|e|e.to_string())?;
        let selected=b.active_id;
        if b.tabs.len()+wanted.len()>MAX_TABS{return Err("Not enough available tabs".into());}
        let mut created=Vec::with_capacity(wanted.len());
        for item in wanted {
            let id=b.add(true)?;
            let tab=b.tabs.iter_mut().find(|t|t.id==id).ok_or("Tab missing")?;
            tab.secret_id=item.as_str().map(str::to_string);
            tab.secret_revealed=false;
            tab.title="Secret Tab".into();
            tab.url=HOME.into();
            tab.view=None;
            created.push(id);
        }
        b.active_id=selected;
        drop(b);
        notify(&app);
        return Ok(json!({"tabIds":created}));
    }
    if name=="secret-reveal"{
        let id=value.get("tabId").and_then(Value::as_u64)
            .ok_or("Missing tab ID")? as u32;
        let secret_id={
            let state=app.state::<Mutex<Browser>>();
            let browser=state.lock().map_err(|e|e.to_string())?;
            let tab=browser.tabs.iter().find(|t|t.id==id).ok_or("Unknown tab")?;
            if browser.active_id!=id{return Err("Select the secret tab first".into());}
            if tab.secret_revealed{return Ok(json!({"ok":true}));}
            tab.secret_id.clone().ok_or("Not a secret bookmark tab")?
        };
        let url={
            let state=app.state::<Mutex<secret_bookmarks::SecretVault>>();
            state.lock().map_err(|e|e.to_string())?.link(&secret_id)?
        };
        let parsed=tauri::Url::parse(&url).map_err(|_|"Secret URL invalid")?;
        {
            let state=app.state::<Mutex<Browser>>();
            let mut browser=state.lock().map_err(|e|e.to_string())?;
            let tab=browser.tabs.iter_mut().find(|t|t.id==id).ok_or("Unknown tab")?;
            tab.secret_revealed=true;
        }
        if let Err(err)=navigate_tab(&app,id,Some(parsed),false){
            let state=app.state::<Mutex<Browser>>();
            if let Ok(mut b)=state.lock(){
                if let Some(tab)=b.tabs.iter_mut().find(|t|t.id==id){tab.secret_revealed=false;}
            }
            return Err(err);
        }
        return Ok(json!({"ok":true}));
    }
    if name=="google-status"{
        return google_account::status(&app.state::<Mutex<google_account::GoogleState>>());
    }
    if name=="google-login"||name=="google-gmail-login"{
        let client=value.get("clientId").and_then(Value::as_str)
            .ok_or("Google Desktop OAuth Client ID is required")?.to_owned();
        let mail=name=="google-gmail-login";
        let handle=app.clone();
        return tauri::async_runtime::spawn_blocking(move||
            google_account::login(&handle.state::<Mutex<google_account::GoogleState>>(),&client,mail))
            .await.map_err(|e|e.to_string())?;
    }
    if name=="google-sync-enable" {
        return google_account::set_enabled(
            &app.state::<Mutex<google_account::GoogleState>>(),
            value.as_bool().ok_or("Expected consent flag")?);
    }
    if name=="google-drive-pull" {
        let handle=app.clone();
        return tauri::async_runtime::spawn_blocking(move||
            google_account::pull(&handle.state::<Mutex<google_account::GoogleState>>()))
            .await.map_err(|e|e.to_string())?;
    }
    if name=="google-drive-push" {
        let encrypted=value.as_str().ok_or("Missing encrypted sync data")?.to_owned();
        let handle=app.clone();
        return tauri::async_runtime::spawn_blocking(move||
            google_account::push(&handle.state::<Mutex<google_account::GoogleState>>(),&encrypted))
            .await.map_err(|e|e.to_string())?;
    }
    if name=="live-sync-vault-export" {
        // Sensitive plaintext is returned only to the LOCAL trusted chrome,
        // which immediately wraps each record in AES-GCM for server storage.
        let state=app.state::<Mutex<password_vault::Vault>>();
        let vault=state.lock().map_err(|e|e.to_string())?;
        if !vault.unlocked(){return Ok(json!({"locked":true}));}
        return vault.sync_snapshot();
    }
    if name=="live-sync-vault-apply" {
        let kind=value.get("kind").and_then(Value::as_str)
            .ok_or("Missing sync category")?;
        let entry=value.get("entry").ok_or("Missing decrypted sync entry")?;
        let deleted=value.get("deleted").and_then(Value::as_bool)==Some(true);
        if !matches!(kind,"login"|"payment") {return Err("Not a vault record".into());}
        let state=app.state::<Mutex<password_vault::Vault>>();
        let mut vault=state.lock().map_err(|e|e.to_string())?;
        if !vault.unlocked(){return Ok(json!({"ok":false,"locked":true}));}
        let changed=vault.sync_apply(kind,entry,deleted)?;
        if changed{vault.save(&password_vault::file(&app)?)?;}
        return Ok(json!({"ok":true,"changed":changed}));
    }
    if name=="live-sync-apply-tab" {
        // Remote changes never create private/Tor tabs, switch focus, or steal
        // typed page data. Existing active pages are not silently destroyed.
        let sync_id=value.get("syncId").and_then(Value::as_str)
            .ok_or("Missing stable tab identity")?;
        if !(sync_id.len()==32 && sync_id.chars().all(|c|c.is_ascii_hexdigit())){
            return Err("Invalid cross-device tab identity".into());
        }
        let deleted=value.get("deleted").and_then(Value::as_bool)==Some(true);
        let pinned=value.get("pinned").and_then(Value::as_bool)==Some(true);
        let dest=if deleted {None}else{
            let address=value.get("url").and_then(Value::as_str)
                .ok_or("Missing synced HTTPS URL")?;
            let url=tauri::Url::parse(address).map_err(|_|"Invalid tab URL")?;
            if url.scheme()!="https"||url.host_str().is_none()||
               url.host_str().is_some_and(|h|h.ends_with(".onion"))||
               !url.username().is_empty()||url.password().is_some()||
               address.len()>2048{return Err("Private, Tor or unsafe URL excluded".into());}
            Some(address.to_owned())
        };
        let (changed,to_close,deferred)={
            let store=app.state::<Mutex<Browser>>();
            let mut b=store.lock().map_err(|e|e.to_string())?;
            let found=b.tabs.iter().position(|t|t.sync_id==sync_id&&!t.private);
            let mut to_close=None;
            let mut changed=false;
            let mut deferred=false;
            if let Some(i)=found{
                let active=b.tabs[i].id==b.active_id;
                if deleted {
                    if active {deferred=true;}
                    else {
                        let old=b.tabs.remove(i);
                        to_close=old.view;
                        changed=true;
                    }
                }else if let Some(url)=dest.as_ref(){
                    if active&&b.tabs[i].url!=*url{deferred=true;}
                    else {
                        let tab=&mut b.tabs[i];
                        if tab.url!=*url {
                            to_close=tab.view.take();
                            tab.url=url.clone();
                            tab.title=title_for(url);
                            tab.history=vec![HOME.into(),url.clone()];
                            tab.at=1;tab.loading=false;
                            tab.inactive_since=Some(Instant::now());
                            changed=true;
                        }
                        if tab.pinned!=pinned{tab.pinned=pinned;changed=true;}
                    }
                }
            }else if !deleted && b.tabs.len()<MAX_TABS {
                let selected=b.active_id;
                let id=b.add(false)?;
                if let (Some(tab),Some(url))=(b.tabs.iter_mut().find(|t|t.id==id),dest.as_ref()){
                    tab.sync_id=sync_id.to_owned();
                    tab.pinned=pinned;tab.url=url.clone();
                    tab.title=title_for(url);tab.history=vec![HOME.into(),url.clone()];
                    tab.at=1;tab.inactive_since=Some(Instant::now());
                }
                b.active_id=selected;changed=true;
            }else if !deleted {deferred=true;}
            (changed,to_close,deferred)
        };
        if let Some(label)=to_close {
            if let Some(view)=app.get_webview(&label){let _=view.close();}
        }
        if changed {
            let _=save_pinned(&app);
            let _=save_session(&app);
            notify(&app);
        }
        return Ok(json!({"ok":true,"changed":changed,"deferred":deferred}));
    }
    if name=="google-sync-tabs-merge" {
        // Sync never mutates private tabs or foreground input, and unopened
        // remote tabs stay suspended until the user explicitly selects one.
        let urls=value.as_array().ok_or("Expected synced tab list")?;
        if urls.len()>MAX_TABS{return Err("Too many synced tabs".into());}
        let (added,total)={
            let state=app.state::<Mutex<Browser>>();
            let mut b=state.lock().map_err(|e|e.to_string())?;
            let selected=b.active_id;
            let mut added=0;
            for item in urls {
                let Some(url)=item.get("url").and_then(Value::as_str) else{continue;};
                if url.len()>2048{continue;}
                let Ok(parsed)=tauri::Url::parse(url) else{continue;};
                if parsed.scheme()!="https"||parsed.host_str().is_none()||
                    !parsed.username().is_empty()||parsed.password().is_some(){continue;}
                if b.tabs.iter().any(|tab|!tab.private&&tab.url==url){continue;}
                if b.tabs.len()>=MAX_TABS{break;}
                let id=b.add(false)?;
                if let Some(tab)=b.tabs.iter_mut().find(|tab|tab.id==id){
                    tab.url=url.to_owned();
                    tab.title=title_for(url);
                    tab.pinned=item.get("pinned").and_then(Value::as_bool).unwrap_or(false);
                    tab.history=vec![HOME.into(),url.to_owned()];
                    tab.at=1;
                    tab.inactive_since=Some(Instant::now());
                }
                added+=1;
            }
            b.active_id=selected;
            (added,b.tabs.len())
        };
        if added>0 {notify(&app);}
        return Ok(json!({"ok":true,"added":added,"total":total}));
    }
    if name=="google-vault-export" {
        // Upload the original authenticated, encrypted vault bytes, never PANs
        // or plaintext passwords. No private browsing credentials enter it.
        let path=password_vault::file(&app)?;
        if !path.exists(){return Ok(json!({"exists":false}));}
        let raw=std::fs::read(path).map_err(|e|e.to_string())?;
        if raw.len()>2_000_000{return Err("Vault exceeds sync limit".into());}
        let meta:Value=serde_json::from_slice(&raw).map_err(|_|"Invalid local vault")?;
        if !meta["ciphertext"].is_array()||!meta["salt"].is_array()||!meta["nonce"].is_array(){
            return Err("Refusing to sync an unencrypted vault".into());
        }
        return Ok(json!({"exists":true,
            "encrypted":base64::engine::general_purpose::STANDARD.encode(raw)}));
    }
    if name=="google-vault-merge" {
        let encoded=value.as_str().ok_or("Missing encrypted cloud vault")?;
        if encoded.len()>2_800_000{return Err("Cloud vault exceeds safe size".into());}
        let raw=base64::engine::general_purpose::STANDARD.decode(encoded)
            .map_err(|_|"Invalid encrypted cloud vault encoding")?;
        let file=password_vault::file(&app)?;
        if !file.exists(){return Ok(json!({"ok":false,"reason":"no-local-vault"}));}
        let state=app.state::<Mutex<password_vault::Vault>>();
        let mut vault=state.lock().map_err(|e|e.to_string())?;
        if !vault.unlocked(){return Ok(json!({"ok":false,"reason":"vault-locked"}));}
        return vault.merge_encrypted_backup(&raw,&file);
    }
    if name=="google-vault-import" {
        // An existing vault is never silently overwritten. Reconciliation of
        // conflicting vaults needs explicit, separate user action.
        let path=password_vault::file(&app)?;
        if path.exists(){return Ok(json!({"ok":false,"reason":"local-vault-exists"}));}
        let encoded=value.as_str().ok_or("Missing encrypted vault file")?;
        if encoded.len()>2_800_000{return Err("Vault backup too large".into());}
        let raw=base64::engine::general_purpose::STANDARD.decode(encoded)
            .map_err(|_|"Invalid encrypted vault encoding")?;
        let parsed:Value=serde_json::from_slice(&raw).map_err(|_|"Invalid vault backup")?;
        if parsed["version"]!=1 || !parsed["ciphertext"].is_array() ||
           !parsed["nonce"].is_array() || !parsed["salt"].is_array(){
            return Err("Refusing an unencrypted or incompatible vault".into());
        }
        if let Some(folder)=path.parent(){std::fs::create_dir_all(folder).map_err(|e|e.to_string())?;}
        std::fs::write(&path,raw).map_err(|e|e.to_string())?;
        return Ok(json!({"ok":true}));
    }
    if name=="google-code-check" {
        let sites={
            let browser=app.state::<Mutex<Browser>>();
            let b=browser.lock().map_err(|e|e.to_string())?;
            b.tabs.iter().filter(|t|!t.private&&t.url.starts_with("https://"))
                .map(|t|t.url.clone()).collect::<Vec<_>>()
        };
        if sites.is_empty(){return Ok(json!([]));}
        let handle=app.clone();
        let found=tauri::async_runtime::spawn_blocking(move||
            google_account::codes(&handle.state::<Mutex<google_account::GoogleState>>(),&sites))
            .await.map_err(|e|e.to_string())??;
        // Enter codes into fields even in background tabs, but only at the
        // exact originally checked HTTPS hostname. Never press submit.
        for hit in &found {
            // A single freshly detected code is placed on the OS clipboard.
            // The user must separately authorize Gmail read access before
            // this background operation is ever enabled.
            let _=app.clipboard().write_text(hit.code.clone());
            let eligible={
                let browser=app.state::<Mutex<Browser>>();
                let b=browser.lock().map_err(|e|e.to_string())?;
                b.tabs.iter().filter(|t|!t.private && t.view.is_some() &&
                    tauri::Url::parse(&t.url).ok().and_then(|u|u.host_str().map(str::to_owned))
                        .as_deref()==Some(hit.host.as_str()))
                    .filter_map(|t|t.view.clone()).collect::<Vec<_>>()
            };
            let code=serde_json::to_string(&hit.code).map_err(|e|e.to_string())?;
            let hostname=serde_json::to_string(&hit.host).map_err(|e|e.to_string())?;
            for label in eligible {
                if let Some(view)=app.get_webview(&label){
                    let script=format!(r#"(function(){{
                        if(location.protocol!=='https:'||location.hostname!=={hostname})return;
                        const code={code};
                        const inputs=[...document.querySelectorAll('input')];
                        const single=inputs.find(e=>!e.disabled && !e.readOnly &&
                          ((e.autocomplete||'').includes('one-time-code')||
                          /(?:otp|verification|security.?code|passcode|confirm.?code)/i.test(
                          (e.name||'')+' '+(e.id||'')+' '+(e.placeholder||'')+' '+
                          (e.getAttribute('aria-label')||''))) && !e.value);
                        if(single){{
                          const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
                          set.call(single,code);
                          single.dispatchEvent(new Event('input',{{bubbles:true}}));
                          single.dispatchEvent(new Event('change',{{bubbles:true}}));
                        }}
                    }})();"#);
                    let _=view.eval(&script);
                }
            }
        }
        return serde_json::to_value(found).map_err(|e|e.to_string());
    }

    if name.starts_with("history-"){
        // Private browsing intentionally does not consult saved history,
        // including for address-bar suggestions.
        let private=app.state::<Mutex<Browser>>().lock().map_err(|e|e.to_string())?
            .active().map(|t|t.private).unwrap_or(false);
        let history=app.state::<Mutex<browsing_history::History>>();
        let mut store=history.lock().map_err(|e|e.to_string())?;
        match name.as_str(){
            "history-search" | "history-list"=>{
                if private{return Ok(json!([]));}
                let query=value.as_str().or_else(||value.get("query").and_then(Value::as_str)).unwrap_or("");
                if query.len()>240{return Ok(json!([]));}
                let offset=value.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
                let limit=value.get("limit").and_then(Value::as_u64).map(|n|n as usize)
                    .unwrap_or(if name=="history-search"{25}else{75});
                return Ok(json!(store.search_page(query,offset,limit)));
            },
            "history-remove"=>{
                let url=value.as_str().ok_or("History address missing")?;
                let changed=store.remove(url);
                if changed{store.save(&app)?;let _=app.emit_to("chrome","minternet:history-changed",());}
                return Ok(json!({"ok":true,"changed":changed}));
            },
            "history-clear"=>{
                let changed=store.clear();
                if changed{store.save(&app)?;let _=app.emit_to("chrome","minternet:history-changed",());}
                return Ok(json!({"ok":true,"changed":changed}));
            },
            _=>return Err("Unknown history command".into())
        }
    }
    if name=="auto-unload-check" {
        let minutes=value.as_u64().unwrap_or(1);
        check_idle_tabs(&app,minutes)?;
        return Ok(json!({"ok":true}));
    }
    if name=="firefox-folder-import" {
        let guid=value.get("guid").and_then(Value::as_str).unwrap_or("").to_owned();
        let id=value.get("id").and_then(Value::as_i64);
        let title=value.get("title").and_then(Value::as_str).unwrap_or("").to_owned();
        // The user's explicit folder drop is the only trigger. Reading the
        // local Firefox Places database is performed on a worker thread and
        // restricted to that one folder; no background profile inspection.
        return tauri::async_runtime::spawn_blocking(move||
            firefox_bookmarks::resolve_folder(&guid,id,&title))
            .await.map_err(|e|e.to_string())?;
    }
    if name=="bookmark-site-icons" {
        let url=value.as_str().ok_or("Expected bookmarked HTTPS URL")?;
        if url.len()>4096 {return Err("Bookmark URL too long".into());}
        let target=url.to_owned();
        // Never block the browser's main/IPC executor for favicon discovery.
        let discovered=tauri::async_runtime::spawn_blocking(move||lookup_site_icons(&target))
            .await.map_err(|e|e.to_string())?;
        return Ok(json!(discovered));
    }
    if name=="undo" {
        let result=undo_last(&app)?;
        return Ok(json!({"undone":result.is_some(),"ui":result.clone().unwrap_or(Value::Null)}));
    }
    if name=="undo-ui-checkpoint" {
        let kind=value.get("kind").and_then(Value::as_str).ok_or("Undo state kind required")?;
        if kind!="groups" && kind!="bookmarks" {return Err("Unsupported UI undo kind".into());}
        let size=serde_json::to_vec(&value).map_err(|e|e.to_string())?.len();
        if size>256_000{return Err("Undo change exceeds size budget".into());}
        remember_undo(&app,Some(value));
        return Ok(json!({"ok":true}));
    }
    if matches!(name.as_str(),
        "new"|"new-private"|"new-url"|"new-background-url"|"new-private-background-url"|"pin"|"unpin"|"toggle-pin"|
        "duplicate"|"close"|"close-many"|"navigate"|"home"|"privacy"|
        "back"|"forward"|"split-add"|"split-remove"|"split-clear") {
        remember_undo(&app,None);
    }
    match name.as_str() {
        "downloads-list" => {
            let state=app.state::<DownloadsState>();
            let history=state.0.lock().map_err(|e|e.to_string())?;
            return Ok(json!(history.iter().rev().map(|d|json!({
                "id":d.id,"name":d.name,"status":d.status,"private":d.private
            })).collect::<Vec<_>>()));
        }
        "downloads-clear" => {
            let state=app.state::<DownloadsState>();
            state.0.lock().map_err(|e|e.to_string())?.clear();
            save_recent_downloads(&app);
            return Ok(json!({"ok":true}));
        }
        "downloads-drag" => {
            let id=value.as_u64().ok_or("Invalid download ID")?;
            let path=checked_download_path(&app,id)?;
            #[cfg(any(windows,target_os="macos"))]
            {
                let handle=app.clone();
                // Browser JS never receives file bytes. Initiate a true OS
                // CF_HDROP / Finder file drag on the native window thread.
                app.run_on_main_thread(move||{
                    if let Some(window)=handle.get_window("main"){
                        let item=drag::DragItem::Files(vec![path]);
                        let preview=drag::Image::Raw(include_bytes!("../icons/icon.png").to_vec());
                        let _=drag::start_drag(&window,item,preview,
                            |_result,_position|{},drag::Options::default());
                    }
                }).map_err(|e|e.to_string())?;
                return Ok(json!({"ok":true}));
            }
            #[cfg(not(any(windows,target_os="macos")))]
            {let _=path;return Err("Native file drag is not yet supported on this desktop".into());}
        }
        "downloads-open" | "downloads-reveal" | "downloads-drag-info" => {
            let id=value.as_u64().ok_or("Invalid download ID")?;
            let path=checked_download_path(&app,id)?;
            if name=="downloads-drag-info" {
                let uri=tauri::Url::from_file_path(&path)
                    .map_err(|_|"Cannot create file drag URI")?.to_string();
                return Ok(json!({"uri":uri,"name":path.file_name().and_then(|n|n.to_str()).unwrap_or("Download")}));
            }
            if name=="downloads-open" {
                open_download_file(&path)?;
                return Ok(json!({"ok":true}));
            }
            #[cfg(windows)]
            std::process::Command::new("explorer.exe")
                .arg(format!("/select,{}",path.to_string_lossy()))
                .spawn().map_err(|e|e.to_string())?;
            #[cfg(target_os="macos")]
            std::process::Command::new("open").arg("-R").arg(&path)
                .spawn().map_err(|e|e.to_string())?;
            #[cfg(target_os="linux")]
            std::process::Command::new("xdg-open").arg(path.parent().ok_or("No parent folder")?)
                .spawn().map_err(|e|e.to_string())?;
            return Ok(json!({"ok":true}));
        }
        "vault-status" => {
            let exists=password_vault::file(&app)?.exists();
            let unlocked=app.state::<Mutex<password_vault::Vault>>().lock().map_err(|e|e.to_string())?.unlocked();
            return Ok(json!({"exists":exists,"unlocked":unlocked}));
        }
        "vault-unlock" | "vault-create" => {
            let password=value.as_str().ok_or("Master password required")?;
            let state=app.state::<Mutex<password_vault::Vault>>();
            state.lock().map_err(|e|e.to_string())?.unlock(
                &password_vault::file(&app)?,password,name=="vault-create"
            )?;
            let _=app.emit_to("chrome","minternet:vault-unlocked",());
            return Ok(json!({"ok":true}));
        }
        "vault-lock" => {
            app.state::<Mutex<password_vault::Vault>>().lock().map_err(|e|e.to_string())?.lock();
            return Ok(json!({"ok":true}));
        }
        "vault-card-list" => {
            let state=app.state::<Mutex<password_vault::Vault>>();
            return state.lock().map_err(|e|e.to_string())?.list_cards();
        }
        "vault-card-put" => {
            let label=value.get("label").and_then(Value::as_str).unwrap_or("").to_string();
            let holder=value.get("name").and_then(Value::as_str).ok_or("Cardholder name required")?.to_string();
            let number=value.get("number").and_then(Value::as_str).ok_or("Card number required")?.to_string();
            let month=value.get("month").and_then(Value::as_u64).ok_or("Expiry month required")? as u8;
            let year=value.get("year").and_then(Value::as_u64).ok_or("Expiry year required")? as u16;
            let postal=value.get("postal").and_then(Value::as_str).unwrap_or("").to_string();
            let state=app.state::<Mutex<password_vault::Vault>>();
            let mut vault=state.lock().map_err(|e|e.to_string())?;
            let id=vault.put_card(label,holder,number,month,year,postal)?;
            vault.save(&password_vault::file(&app)?)?;
            let _=app.emit_to("chrome","minternet:vault-changed",());
            return Ok(json!({"ok":true,"id":id}));
        }
        "vault-card-update" => {
            let id=value.get("id").and_then(Value::as_str).ok_or("Missing card identifier")?;
            let label=value.get("label").and_then(Value::as_str).unwrap_or("").to_string();
            let holder=value.get("name").and_then(Value::as_str).ok_or("Cardholder name required")?.to_string();
            let month=value.get("month").and_then(Value::as_u64).ok_or("Expiry month required")? as u8;
            let year=value.get("year").and_then(Value::as_u64).ok_or("Expiry year required")? as u16;
            let postal=value.get("postal").and_then(Value::as_str).unwrap_or("").to_string();
            let state=app.state::<Mutex<password_vault::Vault>>();
            let mut vault=state.lock().map_err(|e|e.to_string())?;
            vault.update_card(id,label,holder,month,year,postal)?;
            vault.save(&password_vault::file(&app)?)?;
            let _=app.emit_to("chrome","minternet:vault-changed",());
            return Ok(json!({"ok":true}));
        }
        "vault-card-remove" => {
            let id=value.as_str().ok_or("Missing card identifier")?;
            let state=app.state::<Mutex<password_vault::Vault>>();
            let mut vault=state.lock().map_err(|e|e.to_string())?;
            vault.remove_card(id)?;
            vault.save(&password_vault::file(&app)?)?;
            let _=app.emit_to("chrome","minternet:vault-changed",());
            return Ok(json!({"ok":true}));
        }
        "vault-card-fill" => {
            let id=value.as_str().ok_or("Choose a saved card")?;
            return Ok(json!({"filled":fill_payment_card(&app,id)?}));
        }
        "vault-list" => {
            let state=app.state::<Mutex<password_vault::Vault>>();
            return state.lock().map_err(|e|e.to_string())?.list();
        }
        "vault-put" => {
            let url=value.get("origin").and_then(Value::as_str).ok_or("Missing site origin")?;
            let origin=password_vault::origin(url)?;
            let username=value.get("username").and_then(Value::as_str).ok_or("Missing username")?;
            let password=value.get("password").and_then(Value::as_str).ok_or("Missing password")?;
            let autofill=value.get("autofill").and_then(Value::as_bool).unwrap_or(true);
            let state=app.state::<Mutex<password_vault::Vault>>();
            let mut vault=state.lock().map_err(|e|e.to_string())?;
            vault.put(origin,username.to_string(),password.to_string(),autofill)?;
            vault.save(&password_vault::file(&app)?)?;
            let _=app.emit_to("chrome","minternet:vault-changed",());
            return Ok(json!({"ok":true}));
        }
        "vault-remove" => {
            let url=value.get("origin").and_then(Value::as_str).ok_or("Missing origin")?;
            let origin=password_vault::origin(url)?;
            let username=value.get("username").and_then(Value::as_str).ok_or("Missing username")?;
            let state=app.state::<Mutex<password_vault::Vault>>();
            let mut vault=state.lock().map_err(|e|e.to_string())?;
            vault.remove(&origin,username)?;
            vault.save(&password_vault::file(&app)?)?;
            let _=app.emit_to("chrome","minternet:vault-changed",());
            return Ok(json!({"ok":true}));
        }
        "vault-fill" => {
            let username=value.as_str().ok_or("Choose a saved username")?;
            let id=app.state::<Mutex<Browser>>().lock().map_err(|e|e.to_string())?.active_id;
            return Ok(json!({"filled":fill_saved_credential(&app,id,true,Some(username))?}));
        }
        "pin-smoke-proof" => {
            if !std::env::args().any(|a|a=="--minternet-pin-smoke"||
                                        a=="--minternet-pin-reopen-smoke") {
                return Err("Pin test is not enabled".into());
            }
            let phase=value.get("phase").and_then(Value::as_str).ok_or("Missing phase")?;
            let state=app.state::<Mutex<Browser>>();
            let browser=state.lock().map_err(|e|e.to_string())?;
            let valid=match phase {
                "pinned"=>browser.tabs.len()==2&&
                    browser.tabs.iter().any(|t|t.pinned&&t.id==1)&&
                    browser.active_id==1&&value.get("pinRendered").and_then(Value::as_bool)==Some(true),
                "restored"=>browser.tabs.len()==1&&browser.tabs[0].pinned&&
                    browser.active_id==browser.tabs[0].id,
                "tabless"=>browser.tabs.is_empty()&&browser.active_id==0&&
                    value.get("homeVisible").and_then(Value::as_bool)==Some(true),
                "new-first"=>browser.tabs.len()==1&&browser.active_id!=0&&
                    !browser.tabs[0].pinned,
                _=>false
            };
            if !valid{return Err(format!("Native pinned-tab {phase} invariant failed"))}
            let marker=std::env::temp_dir()
                .join(format!("minternet-pin-{}-{phase}.ok",std::process::id()));
            std::fs::write(marker,phase).map_err(|e|e.to_string())?;
            return Ok(json!({"ok":true}));
        }
        "pointer-smoke-proof" => {
            if !std::env::args().any(|a|a=="--minternet-pointer-smoke") {
                return Err("Tab drag proof unavailable outside UI smoke".into());
            }
            if value.get("joined").and_then(Value::as_bool)!=Some(true) ||
               value.get("left").and_then(Value::as_bool)!=Some(true) ||
               value.get("noHtmlDrag").and_then(Value::as_bool)!=Some(true) {
                return Err("Pointer-group entry/exit failed".into());
            }
            let marker=std::env::temp_dir()
                .join(format!("minternet-pointer-{}.ok",std::process::id()));
            std::fs::write(marker,"Pointer tab drag joined and left group without native drop")
                .map_err(|e|e.to_string())?;
            return Ok(json!({"ok":true}));
        }
        "search-smoke-stage" => {
            if !std::env::args().any(|a|a=="--minternet-search-smoke"){
                return Err("Search trace unavailable".into());
            }
            let description=value.as_str().unwrap_or("unknown");
            if description.len()>1000 {return Err("Trace too long".into())}
            let destination=std::env::temp_dir()
                .join(format!("minternet-search-stage-{}.txt",std::process::id()));
            use std::io::Write as _;
            let mut file=std::fs::OpenOptions::new().create(true).append(true)
                .open(destination).map_err(|e|e.to_string())?;
            writeln!(file,"{description}").map_err(|e|e.to_string())?;
            return Ok(json!({"ok":true}));
        }
        "search-smoke-proof" => {
            if !std::env::args().any(|a|a=="--minternet-search-smoke"){
                return Err("Search test unavailable outside CI".into());
            }
            let engine=value.get("engine").and_then(Value::as_str).ok_or("Missing engine")?;
            let phrase=value.get("query").and_then(Value::as_str).ok_or("Missing query")?;
            let expected=parse_address_with_engine(phrase,engine)?
                .ok_or("Search URL missing")?.to_string();
            // Search engines can redirect through regional consent or bot-check
            // pages. Verify the *initiated native navigation* rather than the
            // tab's eventual redirected URL, which is outside browser control.
            let request=std::env::temp_dir()
                .join(format!("minternet-search-request-{}-{engine}.txt",std::process::id()));
            let actual=std::fs::read_to_string(request).map_err(|e|format!("No search request for {engine}: {e}"))?;
            let active=app.state::<Mutex<Browser>>().lock().map_err(|e|e.to_string())?
                .active().ok_or("No active tab")?.url.clone();
            let diagnosis=std::env::temp_dir()
                .join(format!("minternet-search-check-{}-{engine}.txt",std::process::id()));
            let _=std::fs::write(diagnosis,format!("requested={actual}; active={active}; expected={expected}"));
            if actual!=expected {return Err(format!("Search requested {actual}, expected {expected}"))}
            let marker=std::env::temp_dir()
                .join(format!("minternet-search-{}-{engine}.ok",std::process::id()));
            std::fs::write(marker,actual).map_err(|e|e.to_string())?;
            return Ok(json!({"ok":true}));
        }
        "window-drag" => {
            // Only trusted local chrome has this IPC bridge.
            let window=app.get_window("main").ok_or("Window unavailable")?;
            window.start_dragging().map_err(|e|e.to_string())?;
            return Ok(json!({"ok":true}));
        }
        "rapid-ui-smoke-stage" => {
            if !std::env::args().any(|a|a=="--minternet-rapid-ui-smoke"){
                return Err("Rapid UI diagnostic disabled".into());
            }
            let stage=value.as_str().unwrap_or("unknown");
            if stage.len()>60 {return Err("Diagnostic stage invalid".into())}
            let path=std::env::temp_dir()
                .join(format!("minternet-rapid-stage-{}-{stage}.txt",std::process::id()));
            std::fs::write(path,stage).map_err(|e|e.to_string())?;
            return Ok(json!({"ok":true}));
        }
        "rapid-ui-smoke-proof" => {
            if !std::env::args().any(|a|a=="--minternet-rapid-ui-smoke") {
                return Err("Not a rapid UI test".into());
            }
            let phase=value.get("phase").and_then(Value::as_str).ok_or("Missing test phase")?;
            let window=app.get_window("main").ok_or("No main window")?;
            let maximized=window.is_maximized().map_err(|e|e.to_string())?;
            let inspect=std::env::temp_dir()
                .join(format!("minternet-rapid-stage-{}-{phase}.txt",std::process::id()));
            let _=std::fs::write(inspect,format!("maximized={maximized},payload={value}"));
            let ui=value.get("ui").ok_or("UI measurements missing")?;
            let width=ui.get("tabWidth").and_then(Value::as_f64).ok_or("No tab width")?;
            for key in ["logoFirst","homeRemoved","kbdRemoved","torOnly","footerRemoved","folderSaveRemoved","compactBookmarks","searchSetting"] {
                if ui.get(key).and_then(Value::as_bool)!=Some(true) {
                    return Err(format!("Rapid chrome invariant failed: {key}"));
                }
            }
            if !(25.0..=65.0).contains(&width) {
                return Err(format!("Expected favicon-only tab width of 25-65px, found {width}"));
            }
            match phase {
                "maximize" if maximized => {},
                "restore" if !maximized => {},
                _ => return Err(format!("Window state incorrect for {phase}: maximized={maximized}"))
            }
            let marker=std::env::temp_dir()
                .join(format!("minternet-rapid-{}-{phase}.ok",std::process::id()));
            std::fs::write(marker,"Window state and condensed chrome verified").map_err(|e|e.to_string())?;
            return Ok(json!({"ok":true}));
        }
        "menu-smoke-stage" => {
            if !std::env::args().any(|a| a == "--minternet-menus-smoke") {
                return Err("Not a native menu test".into());
            }
            use std::io::Write as _;
            let trace = std::env::temp_dir()
                .join(format!("minternet-menus-stage-{}.txt",std::process::id()));
            let mut file = std::fs::OpenOptions::new()
                .create(true).append(true).open(trace).map_err(|e| e.to_string())?;
            writeln!(file,"{}",value.as_str().unwrap_or("unknown").chars().take(120).collect::<String>())
                .map_err(|e|e.to_string())?;
            return Ok(json!({"ok":true}));
        }
        "menu-smoke-proof" => {
            if !std::env::args().any(|a| a == "--minternet-menus-smoke") {
                return Err("Unavailable outside native menu smoke".into());
            }
            let folders = value.get("folders").and_then(Value::as_u64).unwrap_or(0);
            let native = value.get("nativePopups").and_then(Value::as_u64).unwrap_or(0);
            let group_visible = value.get("groupVisible").and_then(Value::as_bool);
            let group_rows = value.get("groupMenuRows").and_then(Value::as_u64).unwrap_or(0);
            // Bookmark context menus intentionally do not contain Tab Groups.
            // Verify the native folder submenu still opens and group state is
            // unaffected by the bookmark menu.
            if folders < 2 || native < 1 || group_visible != Some(false) || group_rows != 0 {
                return Err("Native cascading folder menu or bookmark context isolation check failed".into());
            }
            let marker = std::env::temp_dir()
                .join(format!("minternet-menus-{}.ok",std::process::id()));
            std::fs::write(marker,"Native folder popup and no Tab Groups in bookmark context verified")
                .map_err(|e| e.to_string())?;
            return Ok(json!({"ok":true}));
        }
        "bookmarks-smoke-proof" => {
            // Only enabled for CI's explicit smoke launch; not available during
            // ordinary browsing. Validate nested unnamed folders persisted by
            // the browser UI through its actual DOM form/event handlers.
            if !std::env::args().any(|a|
                a == "--minternet-bookmarks-smoke" || a == "--minternet-bookmarks-reopen"
            ) {
                return Err("Unavailable outside bookmark smoke test".into());
            }
            let entries = value.get("items").and_then(Value::as_array).ok_or("Bookmark data missing")?;
            let root = entries.iter().find(|x|
                x.get("kind").and_then(Value::as_str) == Some("folder") &&
                x.get("name").and_then(Value::as_str) == Some("") &&
                x.get("icon").and_then(Value::as_str) == Some("🌿")
            ).ok_or("Root folder missing")?;
            let children = root.get("children").and_then(Value::as_array).ok_or("Child folder list missing")?;
            if !children.iter().any(|x|
                x.get("kind").and_then(Value::as_str) == Some("folder") &&
                x.get("name").and_then(Value::as_str) == Some("") &&
                x.get("icon").and_then(Value::as_str) == Some("🪐")
            ) {
                return Err("Nested unnamed emoji-icon folder missing".into());
            }
            if value.get("visible").and_then(Value::as_bool) != Some(true) {
                return Err("Bookmark Bar toggle not persisted".into());
            }
            let dropped=entries.iter().find(|x|
                x.get("kind").and_then(Value::as_str)==Some("folder") &&
                x.get("name").and_then(Value::as_str)==Some("Dragged Firefox Folder")
            ).ok_or("Dragged Firefox bookmark folder missing")?;
            let children=dropped.get("children").and_then(Value::as_array)
                .ok_or("Dropped Firefox folder does not contain bookmarks")?;
            if children.len()!=2 ||
               children[0].get("name").and_then(Value::as_str)!=Some("First") ||
               children[1].get("name").and_then(Value::as_str)!=Some("Nested Firefox Folder") ||
               children[1].get("children").and_then(Value::as_array)
                   .and_then(|nodes|nodes.first())
                   .and_then(|node|node.get("name"))
                   .and_then(Value::as_str)!=Some("Second") {
                return Err("Firefox folder drag flattened or lost nested bookmarks".into());
            }
            let marker = std::env::temp_dir()
                .join(format!("minternet-bookmarks-{}.ok", std::process::id()));
            std::fs::write(marker, "Bookmark Bar and nested unnamed folders saved")
                .map_err(|e| e.to_string())?;
            return Ok(json!({"ok":true}));
        }
        "bookmark-bar-visibility" => {
            let visible = value.as_bool().ok_or("Bookmark bar setting must be true or false")?;
            {
                let cache = app.state::<Mutex<LayoutCache>>();
                let mut state = cache.lock().map_err(|e| e.to_string())?;
                state.bookmark_bar_visible = visible;
                state.size_and_home = None;
            }
            display_active(&app);
            return Ok(json!({"ok": true}));
        }
        "chrome-overlay" => {
            let open = value.as_bool().ok_or("Overlay setting must be true or false")?;
            {
                let cache = app.state::<Mutex<LayoutCache>>();
                let mut state = cache.lock().map_err(|e| e.to_string())?;
                state.overlay_open = open;
                state.size_and_home = None;
            }
            display_active(&app);
            return Ok(json!({"ok": true}));
        }
        "split-status" => {
            let ids=app.state::<SplitState>().0.lock().map_err(|e|e.to_string())?.clone();
            return Ok(json!({"ids":ids}));
        }
        "split-add" => {
            let id=value.as_u64().or_else(||value.get("id").and_then(Value::as_u64))
                .ok_or("Expected tab ID")? as u32;
            let nx=value.get("x").and_then(Value::as_f64).unwrap_or(1.0).clamp(0.0,1.0);
            let ny=value.get("y").and_then(Value::as_f64).unwrap_or(0.0).clamp(0.0,1.0);
            let (previous,companion)={
                let state=app.state::<Mutex<Browser>>();
                let b=state.lock().map_err(|e|e.to_string())?;
                let tab=b.tabs.iter().find(|t|t.id==id).ok_or("Unknown tab")?;
                if tab.url==HOME{return Err("Open a webpage before splitting".into());}
                // When the dragged tab is already active, pair it with another
                // existing page of the same privacy mode instead of displaying
                // a nonfunctional single-pane split.
                let companion=b.tabs.iter().find(|t|t.id!=id&&t.url!=HOME&&t.private==tab.private)
                    .map(|t|t.id);
                (b.active_id,companion)
            };
            {
                let state=app.state::<SplitState>();
                let mut split=state.0.lock().map_err(|e|e.to_string())?;
                if split.is_empty() {
                    if previous!=0 && previous!=id {split.push(previous);}
                    else if let Some(other)=companion {split.push(other);}
                }
                if !split.contains(&id){
                    if split.len()>=4{return Err("Split view supports four tabs maximum".into());}
                    let size=split.len()+1;
                    let target=match size {
                        2=>if nx<0.5{0}else{1},
                        3=>if nx<0.5{0}else if ny<0.5{1}else{2},
                        _=>if ny<0.5{if nx<0.5{0}else{1}}
                           else if nx<0.5{2}else{3}
                    };
                    let insert_at=target.min(split.len());
                    split.insert(insert_at,id);
                }else if split.len()>1{
                    let old=split.iter().position(|x|*x==id).unwrap_or(0);
                    split.remove(old);
                    let size=split.len()+1;
                    let target=match size {
                        2=>if nx<0.5{0}else{1},
                        3=>if nx<0.5{0}else if ny<0.5{1}else{2},
                        _=>if ny<0.5{if nx<0.5{0}else{1}}
                           else if nx<0.5{2}else{3}
                    };
                    let insert_at=target.min(split.len());
                    split.insert(insert_at,id);
                }
            }
            let ids=app.state::<SplitState>().0.lock().map_err(|e|e.to_string())?.clone();
            // Prepare only the participating panes, never load unrelated tabs.
            let missing={
                let state=app.state::<Mutex<Browser>>();
                let b=state.lock().map_err(|e|e.to_string())?;
                ids.iter().filter_map(|id|b.tabs.iter()
                    .find(|t|t.id==*id && t.view.is_none() && t.url!=HOME)
                    .map(|t|(t.id,t.url.clone(),t.private))).collect::<Vec<_>>()
            };
            for (id,url,private) in missing {
                let address=tauri::Url::parse(&url).map_err(|e|e.to_string())?;
                create_webview(&app,id,WebviewUrl::External(address),private)?;
            }
            {
                let state=app.state::<Mutex<Browser>>();
                let mut b=state.lock().map_err(|e|e.to_string())?;
                b.active_id=id;
            }
            invalidate_layout(&app);
            display_active(&app);
            return Ok(json!({"ok":true,"ids":ids}));
        }
        "split-remove" => {
            let id=value.as_u64().ok_or("Expected tab ID")? as u32;
            {
                let state=app.state::<SplitState>();
                let mut split=state.0.lock().map_err(|e|e.to_string())?;
                split.retain(|x|*x!=id);
                if split.len()<2{split.clear();}
            }
            invalidate_layout(&app);
            display_active(&app);
            return Ok(json!({"ok":true}));
        }
        "split-clear" => {
            app.state::<SplitState>().0.lock().map_err(|e|e.to_string())?.clear();
            invalidate_layout(&app);
            display_active(&app);
            return Ok(json!({"ok":true}));
        }
        "audio-poll" => {
            #[cfg(windows)]
            {
                let tabs={
                    let state=app.state::<Mutex<Browser>>();
                    let browser=state.lock().map_err(|e|e.to_string())?;
                    browser.tabs.iter().filter_map(|tab|tab.view.as_ref().map(|label|(tab.id,label.clone())))
                        .collect::<Vec<_>>()
                };
                for (id,label) in tabs {let _=native_audio_poll(&app,id,&label);}
            }
            return Ok(json!({"ok":true}));
        }
        "mute-tab" => {
            let id=value.as_u64().ok_or("Invalid tab ID")? as u32;
            let label={
                let state=app.state::<Mutex<Browser>>();
                let browser=state.lock().map_err(|e|e.to_string())?;
                browser.tabs.iter().find(|tab|tab.id==id).and_then(|t|t.view.clone())
                    .ok_or("Tab has no active audio renderer")?
            };
            #[cfg(windows)]
            {
                let view=app.get_webview(&label).ok_or("Tab renderer unavailable")?;
                view.with_webview(move |native| {
                    use windows::core::Interface;
                    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
                    if let Ok(audio)=(unsafe{native.controller().CoreWebView2()}).and_then(|webview|webview.cast::<ICoreWebView2_8>()){
                        let mut current=windows::core::BOOL::default();
                        let _=unsafe{audio.IsMuted(&mut current)};
                        let _=unsafe{audio.SetIsMuted(!current.as_bool())};
                    }
                }).map_err(|e|e.to_string())?;
                native_audio_poll(&app,id,&label)?;
                return Ok(json!({"ok":true}));
            }
            #[cfg(not(windows))]
            {let _=label;return Err("Native tab mute is currently supported on Windows".into());}
        }
        "zoom" => {
            let value=value.as_f64().ok_or("Zoom must be numeric")?;
            if !value.is_finite()|| !(0.25..=5.0).contains(&value){return Err("Zoom out of range".into());}
            *app.state::<ZoomState>().0.lock().map_err(|e|e.to_string())?=value;
            let label=app.state::<Mutex<Browser>>().lock().map_err(|e|e.to_string())?
                .active().and_then(|t|t.view.clone());
            if let Some(label)=label {
                if let Some(view)=app.get_webview(&label){view.set_zoom(value).map_err(|e|e.to_string())?;}
            }
            return Ok(json!({"ok":true,"zoom":value}));
        }
        "zoom-get" => {
            let zoom=*app.state::<ZoomState>().0.lock().map_err(|e|e.to_string())?;
            return Ok(json!({"zoom":zoom}));
        }
        "prepare-tab" => { prepare_active(&app)?; }
        "new" | "new-private" | "new-url" | "new-background-url" | "new-private-background-url" => {
            let private = name == "new-private" || name == "new-private-background-url";
            let background = name == "new-background-url" || name == "new-private-background-url";
            let address = if name == "new-url" || background {
                let raw=value.as_str().or_else(||value.get("url").and_then(Value::as_str))
                    .ok_or("Missing URL")?;
                Some(tauri::Url::parse(raw).map_err(|_|"Invalid URL".to_string())?)
            }else{None};
            if let Some(ref url)=address {
                if url.scheme()!="https" || url.host_str().is_none() ||
                   !url.username().is_empty() || url.password().is_some() {
                    return Err("Only secure HTTPS pages may open in a new tab".into());
                }
            }
            let id={
                let state=app.state::<Mutex<Browser>>();
                let mut b=state.lock().map_err(|e|e.to_string())?;
                if background {
                    // Prefer the actual source WebView (split views included).
                    // A stale or malicious source ID cannot insert across tabs.
                    let claimed=value.get("openerTabId").and_then(Value::as_u64).map(|id|id as u32);
                    let opener=claimed.filter(|id|b.tabs.iter().any(|t|t.id==*id))
                        .unwrap_or(b.active_id);
                    b.add_after(private,opener,true)?
                }else{b.add(private)?}
            };
            if let Some(url)=address {
                navigate_tab(&app,id,Some(url),true)?;
            } else { display_active(&app); }
        }
        "deselect" => {
            {
                let state=app.state::<Mutex<Browser>>();
                let mut b=state.lock().map_err(|e|e.to_string())?;
                b.active_id=0;
            }
            display_active(&app);
            return Ok(json!({"ok":true}));
        }
        "pin" | "unpin" | "toggle-pin" => {
            let id=value.as_u64().ok_or("Invalid tab")? as u32;
            let pinned = {
                let state=app.state::<Mutex<Browser>>();
                let mut b=state.lock().map_err(|e|e.to_string())?;
                let tab=b.tabs.iter_mut().find(|t|t.id==id).ok_or("Tab not found")?;
                tab.pinned=match name.as_str(){
                    "pin"=>true,"unpin"=>false,_=>!tab.pinned
                };
                tab.pinned
            };
            save_pinned(&app)?;
            notify(&app);
            return Ok(json!({"ok":true,"pinned":pinned}));
        }
        "duplicate" => {
            let id=value.as_u64().ok_or("Invalid tab")? as u32;
            let (url,private)={
                let state=app.state::<Mutex<Browser>>();
                let browser=state.lock().map_err(|e|e.to_string())?;
                let tab=browser.tabs.iter().find(|t|t.id==id).ok_or("Unknown tab")?;
                (tab.url.clone(),tab.private)
            };
            let new_id={
                let state=app.state::<Mutex<Browser>>();
                let mut browser=state.lock().map_err(|e|e.to_string())?;
                browser.add(private)?
            };
            if url!=HOME {
                let parsed=tauri::Url::parse(&url).map_err(|e|e.to_string())?;
                if parsed.scheme()!="https" {return Err("Blocked unsafe duplicate URL".into());}
                navigate_tab(&app,new_id,Some(parsed),true)?;
            } else {display_active(&app);}
            return Ok(json!({"ok":true,"id":new_id}));
        }
        "activate" => {
            let id = value.as_u64().ok_or("Invalid tab")? as u32;
            {
                let state = app.state::<Mutex<Browser>>();
                let mut b = state.lock().map_err(|e| e.to_string())?;
                if !b.tabs.iter().any(|t| t.id == id) { return Err("No such tab".into()); }
                b.active_id = id;
            }
            activated(&app)?;
        }
        "navigate" | "home" => {
            let mut pending:Option<PendingChatPrompt>=None;
            let url = if name=="home" { None } else {
                let address=value.as_str()
                    .or_else(||value.get("address").and_then(Value::as_str))
                    .ok_or("Missing address")?;
                let engine=value.get("searchEngine").and_then(Value::as_str).unwrap_or("google");
                let target=parse_address_with_engine(address,engine)?;
                // A plain text address entry intentionally starts a new ChatGPT
                // conversation. Explicit website URLs never auto-submit.
                if let Some(ref target_url)=target {
                    if matches!(engine,"chatgpt"|"chatgpt-private") &&
                       target_url.host_str()==Some("chatgpt.com") &&
                       target_url.query_pairs().any(|(key,val)|key=="q"&&val==address.trim()) {
                        pending=Some(PendingChatPrompt{
                            text:address.trim().to_owned(),
                            temporary:engine=="chatgpt-private",
                        });
                    }
                }
                if std::env::args().any(|a|a=="--minternet-search-smoke") &&
                    matches!(engine,"google"|"brave") {
                    if let Some(ref target_url)=target {
                        let path=std::env::temp_dir()
                            .join(format!("minternet-search-request-{}-{engine}.txt",std::process::id()));
                        let _=std::fs::write(path,target_url.as_str());
                    }
                }
                target
            };
            let id = {
                let state=app.state::<Mutex<Browser>>();
                let mut b=state.lock().map_err(|e|e.to_string())?;
                let should_isolate=pending.as_ref().map(|p|p.temporary).unwrap_or(false)
                    && b.active().map(|t|!t.private).unwrap_or(true);
                let id=if should_isolate {
                    let opener=b.active_id;
                    b.add_after(true,opener,false)?
                }else if b.active().is_none(){b.add(false)?}else{b.active_id};
                if let Some(tab)=b.tabs.iter_mut().find(|tab|tab.id==id){
                    tab.pending_chatgpt=pending;
                }
                id
            };
            navigate_tab(&app,id,url,true)?;
        }
        "close-many" => {
            let ids=value.as_array().ok_or("Expected tab ID array")?;
            if ids.len()>MAX_TABS{return Err("Too many tabs".into());}
            let wanted:HashSet<u32>=ids.iter().map(|v|v.as_u64().map(|x|x as u32)
                .ok_or_else(||"Invalid tab ID".to_string())).collect::<Result<_,_>>()?;
            let labels={
                let state=app.state::<Mutex<Browser>>();
                let mut b=state.lock().map_err(|e|e.to_string())?;
                let mut labels=Vec::new();
                b.tabs.retain(|t|{
                    if wanted.contains(&t.id){if let Some(label)=&t.view{labels.push(label.clone());}false}
                    else{true}
                });
                if !b.tabs.iter().any(|t|t.id==b.active_id){
                    b.active_id=b.tabs.iter().find(|t|t.pinned).or_else(||b.tabs.first()).map(|t|t.id).unwrap_or(0);
                }
                labels
            };
            for label in labels {if let Some(wv)=app.get_webview(&label){let _=wv.close();}}
            prune_splits(&app);
            save_pinned(&app)?;
            activated(&app)?;
            return Ok(json!({"ok":true,"closed":wanted.len()}));
        }
        "close" => {
            let id = value.as_u64().ok_or("Invalid tab")? as u32;
            let label = {
                let state = app.state::<Mutex<Browser>>();
                let mut b = state.lock().map_err(|e| e.to_string())?;
                let ix = b.tabs.iter().position(|t|t.id==id).ok_or("Unknown tab")?;
                let tab = b.tabs.remove(ix);
                if b.active_id==id {
                    // Prefer an existing pinned page; never synthesize a new tab.
                    b.active_id = b.tabs.iter().find(|t|t.pinned).map(|t|t.id)
                        .or_else(||b.tabs.get(ix.min(b.tabs.len().saturating_sub(1))).map(|t|t.id))
                        .unwrap_or(0);
                }
                tab.view
            };
            if let Some(label)=label {
                if let Some(wv)=app.get_webview(&label) { let _=wv.close(); }
            }
            prune_splits(&app);
            save_pinned(&app)?;
            activated(&app)?;
        }
        "back" | "forward" => {
            // Let WebView2 use its own BFCache/history instead of reloading the URL.
            // This preserves scroll position, page state, and avoids repeat requests.
            let back = name == "back";
            let target = {
                let state = app.state::<Mutex<Browser>>();
                let mut b = state.lock().map_err(|e| e.to_string())?;
                let tab = b.active_mut().ok_or("No tab")?;
                let next = tab.at as isize + if back { -1 } else { 1 };
                if next < 0 || next as usize >= tab.history.len() { None }
                else {
                    tab.at = next as usize;
                    let url = tab.history[tab.at].clone();
                    let view = tab.view.clone();
                    tab.url = url.clone();
                    tab.title = title_for(&url);
                    Some((tab.id, url, view))
                }
            };
            if let Some((id, url, label)) = target {
                if url == HOME {
                    navigate_tab(&app, id, None, false)?;
                } else {
                    let mut used_native_history = false;
                    if let Some(label) = label {
                        if let Some(view) = app.get_webview(&label) {
                            // Tauri's stable Webview wrapper does not expose go_back on
                            // the pinned version. WebView2 executes the constant history
                            // operation in the existing renderer, enabling its BFCache.
                            // No page-controlled URL or arbitrary script is interpolated.
                            let operation = if back { "history.back()" } else { "history.forward()" };
                            used_native_history = view.eval(operation).is_ok();
                        }
                    }
                    if !used_native_history {
                        // Suspended/closed tabs or unsupported browser history
                        // fall back to ordinary validated HTTPS navigation.
                        let dest = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
                        if !matches!(dest.scheme(),"http"|"https") { return Err("Unsafe history URL".into()); }
                        navigate_tab(&app, id, Some(dest), false)?;
                    } else {
                        notify(&app);
                    }
                }
            }
        }
        "reload-tab" | "unload-tab" => {
            let id=value.as_u64().ok_or("Invalid tab ID")? as u32;
            let (label,was_active,url)={
                let state=app.state::<Mutex<Browser>>();
                let mut b=state.lock().map_err(|e|e.to_string())?;
                let was_active=b.active_id==id;
                if !b.tabs.iter().any(|t|t.id==id){return Err("Tab not found".into());}
                if name=="unload-tab" && was_active {
                    // Keep the tab itself, but select a different one (or a
                    // tabless home). Reentering it creates a fresh renderer.
                    b.active_id=b.tabs.iter().find(|t|t.id!=id && t.pinned).or_else(||
                        b.tabs.iter().find(|t|t.id!=id)).map(|t|t.id).unwrap_or(0);
                }
                let tab=b.tabs.iter_mut().find(|t|t.id==id).ok_or("Tab not found")?;
                let label=if name=="unload-tab"{
                    tab.loading=false;tab.checking_unload=false;
                    tab.audio_playing=false;tab.audio_muted=false;
                    tab.view.take()
                }else{
                    if tab.view.is_some(){tab.loading=true;}
                    tab.view.clone()
                };
                (label,was_active,tab.url.clone())
            };
            if name=="unload-tab" {
                app.state::<SplitState>().0.lock().map_err(|e|e.to_string())?.retain(|candidate|*candidate!=id);
                prune_splits(&app);
            }
            if let Some(label)=label{
                if let Some(view)=app.get_webview(&label){
                    if name=="unload-tab"{view.close().map_err(|e|e.to_string())?;}
                    else{view.reload().map_err(|e|e.to_string())?;}
                }
            }else if name=="reload-tab" && url!=HOME{
                let dest=tauri::Url::parse(&url).map_err(|e|e.to_string())?;
                navigate_tab(&app,id,Some(dest),false)?;
            }
            if name=="unload-tab" && was_active {activated(&app)?;} else {notify(&app);}
            return Ok(json!({"ok":true}));
        }
        "reload" => {
            let (id,url,label)={
                let state=app.state::<Mutex<Browser>>();
                let b=state.lock().map_err(|e|e.to_string())?;
                let tab=b.active().ok_or("No active tab to reload")?;
                (tab.id,tab.url.clone(),tab.view.clone())
            };
            if url==HOME{return Ok(json!({"ok":true}));}
            // Reload a live renderer; suspended tabs must recreate the
            // WebView rather than silently doing nothing.
            let mut reloaded=false;
            if let Some(label)=label {
                if let Some(view)=app.get_webview(&label){
                    reloaded=view.reload().is_ok();
                }
            }
            if !reloaded {
                let target=tauri::Url::parse(&url).map_err(|e|e.to_string())?;
                if !matches!(target.scheme(),"http"|"https") {
                    return Err("This page cannot be reloaded".into());
                }
                navigate_tab(&app,id,Some(target),false)?;
            }
        }
        "privacy" => {
            let (id, old, url) = {
                let state = app.state::<Mutex<Browser>>();
                let mut b = state.lock().map_err(|e|e.to_string())?;
                let t = b.active_mut().ok_or("No tab")?;
                let old = t.view.take();
                t.private = !t.private;
                t.history = vec![t.url.clone()];
                t.at = 0;
                (t.id, old, t.url.clone())
            };
            if let Some(old)=old {
                if let Some(view)=app.get_webview(&old) { let _=view.close(); }
            }
            let dest=if url==HOME {None} else {Some(tauri::Url::parse(&url).map_err(|e|e.to_string())?)};
            navigate_tab(&app,id,dest,false)?;
            let _=save_pinned(&app);
        }
        "free-memory" => {
            let candidates = {
                let state=app.state::<Mutex<Browser>>();
                let mut b=state.lock().map_err(|e|e.to_string())?;
                let active=b.active_id;
                b.tabs.iter_mut().filter(|t| t.id!=active)
                    .filter_map(|t|t.view.take()).collect::<Vec<_>>()
            };
            let mut n=0;
            for label in candidates {
                if let Some(view)=app.get_webview(&label) {
                    if view.close().is_ok() { n+=1; }
                }
            }
            notify(&app);
            return Ok(json!({"message": format!("{n} inactive tab(s) released; unsaved page content may be lost.")}));
        }
        "extensions" | "extension-install" => {
            return Ok(json!({"message": "Native system webviews do not support the full Chrome or Firefox extension ecosystems."}));
        }
        "tor" => {
            return Ok(json!({"message": "Tor is not integrated. Do not treat this native-webview prototype as Tor Browser."}));
        }
        "restore-window" => {
            let window=app.get_window("main").ok_or("Window unavailable")?;
            if window.is_fullscreen().map_err(|e|e.to_string())?{
                window.set_fullscreen(false).map_err(|e|e.to_string())?;
            }
            if window.is_maximized().map_err(|e|e.to_string())?{
                window.unmaximize().map_err(|e|e.to_string())?;
            }
            return Ok(json!({"ok":true}));
        }
        "minimize" | "maximize" | "quit" => {
            let window=app.get_window("main").ok_or("Window unavailable")?;
            match name.as_str() {
                "minimize" => window.minimize().map_err(|e|e.to_string())?,
                "maximize" => {
                    if window.is_maximized().map_err(|e|e.to_string())? {
                        window.unmaximize().map_err(|e|e.to_string())?
                    } else { window.maximize().map_err(|e|e.to_string())? }
                }
                _=>window.close().map_err(|e|e.to_string())?,
            }
        }
        _ => return Err("Unsupported command".into()),
    }
    notify(&app);
    Ok(json!({"ok": true}))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(PopupDeduper(Mutex::new(HashMap::new())))
        .manage(DownloadsState::default())
        .manage(Mutex::new(browsing_history::History::default()))
        .manage(ZoomState(Mutex::new(1.0)))
        .manage(SplitState::default())
        .manage(SplitRatios(Mutex::new((0.5,0.5))))
        .manage(UndoHistory(Mutex::new(VecDeque::new())))
        .manage(Mutex::new(Browser::new()))
        .manage(Mutex::new(password_vault::Vault::default()))
        .manage(Mutex::new(secret_bookmarks::SecretVault::default()))
        .manage(Mutex::new(google_account::GoogleState::default()))
        .manage(Mutex::new(LayoutCache::default()))
        .invoke_handler(tauri::generate_handler![browser_action, browser_snapshot])
        .setup(|app| {
            if let Ok(mut h)=app.state::<Mutex<browsing_history::History>>().lock(){
                *h=browsing_history::History::load(app.handle());
            }
            restore_recent_downloads(app.handle());
            // Automated tests use a deterministic fresh session. Real users
            // restore their pinned pages or start with a tabless home.
            let smoke=std::env::args().any(|a|a.starts_with("--minternet-")&&a.ends_with("-smoke"));
            if smoke && !std::env::args().any(|a|a=="--minternet-pin-reopen-smoke") {
                let store=app.state::<Mutex<Browser>>();
                let mut b=store.lock().map_err(|e|e.to_string())?;
                b.add(false)?;
            } else {
                restore_session(app.handle());
            }
            let builder = WindowBuilder::new(app, "main")
                .title("Minternet")
                // Request dark OS chrome and native menus where supported.
                .theme(Some(tauri::Theme::Dark))
                .inner_size(1160.0, 760.0)
                .min_inner_size(620.0, 400.0);
            // Windows portable EXE has no separate OS caption above the app.
            // Keep resizing and the existing in-app window buttons functional.
            #[cfg(target_os="windows")]
            let builder=builder.decorations(false).resizable(true);
            let window=builder.build()?;
            let (width,height) = dimensions(&window)?;
            // Smoke mode only: trigger a real navigation through the same
            // frontend IPC bridge used by address-bar submissions. This does
            // not invoke the operating system's default browser.
            let smoke = std::env::args().any(|a| a == "--minternet-smoke");
            let turbo_smoke = std::env::args().any(|a| a == "--minternet-turbo-smoke");
            let bookmarks_smoke = std::env::args().any(|a| a == "--minternet-bookmarks-smoke");
            let bookmarks_reopen = std::env::args().any(|a| a == "--minternet-bookmarks-reopen");
            let menus_smoke = std::env::args().any(|a| a == "--minternet-menus-smoke");
            let search_smoke = std::env::args().any(|a| a == "--minternet-search-smoke");
            let pointer_smoke = std::env::args().any(|a| a == "--minternet-pointer-smoke");
            let rapid_smoke = std::env::args().any(|a| a == "--minternet-rapid-ui-smoke");
            let pin_smoke = std::env::args().any(|a| a == "--minternet-pin-smoke");
            let pin_reopen_smoke = std::env::args().any(|a| a == "--minternet-pin-reopen-smoke");
            window.add_child(
                WebviewBuilder::new("chrome",WebviewUrl::App("index.html".into()))
                    // Tauri's native file-drop handler supersedes HTML5
                    // DataTransfer on Windows. Browser/bookmark drags need
                    // actual text/html, uri-list, and File objects in chrome.
                    .disable_drag_drop_handler()
                    .transparent(true)
                    .on_page_load(move |view, event| {
                        if matches!(event.event(), PageLoadEvent::Finished) {
                            if smoke {
                                let _ = view.eval(
                                    "setTimeout(() => window.minternet?.command('navigate', 'https://example.com'), 200)"
                                );
                            } else if turbo_smoke {
                                // Verifies a warmed controller can navigate normally.
                                let _ = view.eval(
                                    "setTimeout(async () => { await window.minternet?.command('prepare-tab'); await window.minternet?.command('navigate', 'https://example.com'); }, 200)"
                                );
                            } else if bookmarks_smoke {
                                // Exercise real chrome UI actions without touching remote
                                // websites or requiring a physical Windows installation.
                                let _ = view.eval(r#"
                                  setTimeout(async () => {
                                    const $ = id => document.getElementById(id);
                                    $('settings').click();
                                    $('bookmarkBarToggle').checked = false;
                                    $('bookmarkBarToggle').dispatchEvent(new Event('change'));
                                    $('bookmarkBarToggle').checked = true;
                                    $('bookmarkBarToggle').dispatchEvent(new Event('change'));
                                    $('bookmarkSettingsManage').click();
                                    $('bookmarkManageNewFolder').click();
                                    $('bookmarkIcon').value = '🌿';
                                    $('bookmarkIcon').dispatchEvent(new Event('input'));
                                    $('bookmarkEditForm').requestSubmit();
                                    const root = JSON.parse(localStorage.getItem('minternet.bookmark-tree.v1')).items[0];
                                    if (!root || root.kind !== 'folder') return;
                                    // Native folder menus replaced the old full-page folder
                                    // panel. Their "New Subfolder" action calls this controller.
                                    window.minternetBookmarks.newFolder(root.id);
                                    $('bookmarkIcon').value = '🪐';
                                    $('bookmarkIcon').dispatchEvent(new Event('input'));
                                    $('bookmarkEditForm').requestSubmit();
                                    // Real browser-chrome DropEvent regression: one Firefox
                                    // folder must import with both direct links and children
                                    // inside nested subfolders, not as flat bookmarks.
                                    const payload=JSON.stringify({
                                      type:'text/x-moz-place-container',
                                      title:'Dragged Firefox Folder',
                                      children:[
                                        {type:'text/x-moz-place',title:'First',
                                          uri:'https://example.com/a'},
                                        {type:'text/x-moz-place-container',
                                          title:'Nested Firefox Folder',children:[
                                            {type:'text/x-moz-place',title:'Second',
                                              uri:'https://example.org/b'}
                                          ]}
                                      ]
                                    });
                                    const transfer=new DataTransfer();
                                    transfer.setData('application/x-moz-place-container',payload);
                                    $('bookmarkBar').dispatchEvent(new DragEvent('drop',{
                                      bubbles:true,cancelable:true,dataTransfer:transfer
                                    }));
                                    await new Promise(resolve=>setTimeout(resolve,420));
                                    const state = JSON.parse(localStorage.getItem('minternet.bookmark-tree.v1'));
                                    await window.minternet?.command('bookmarks-smoke-proof', state);
                                  }, 550);
                                "#);
                            } else if bookmarks_reopen {
                                let _ = view.eval(r#"
                                  setTimeout(async () => {
                                    const saved = localStorage.getItem('minternet.bookmark-tree.v1');
                                    if (!saved) return;
                                    await window.minternet?.command('bookmarks-smoke-proof', JSON.parse(saved));
                                  }, 550);
                                "#);
                            } else if pin_smoke {
                                let _ = view.eval(r#"
                                  setTimeout(async () => {
                                    const api=window.minternet;
                                    const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
                                    await api.command('navigate','https://example.com');
                                    await api.command('pin',1);
                                    await api.command('new');
                                    await sleep(240);
                                    const groups=window.minternetGroups;
                                    const group=groups.createGroup('Hidden Group Test','violet');
                                    if(!group)return;
                                    groups.assign(2,group.id);
                                    groups.toggleVisible(group.id);
                                    await sleep(450);
                                    // Hiding the active grouped tab must focus pinned #1
                                    // without creating a third phantom tab.
                                    const rendered=!!document.querySelector('.tab[data-tab-id="1"].pinned-tab');
                                    await api.command('pin-smoke-proof',{phase:'pinned',pinRendered:rendered});
                                  },550);
                                "#);
                            } else if pin_reopen_smoke {
                                let _ = view.eval(r#"
                                  setTimeout(async () => {
                                    const api=window.minternet;
                                    const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
                                    await api.command('pin-smoke-proof',{phase:'restored'});
                                    await api.command('unpin',1);
                                    await api.command('close',1);
                                    await sleep(450);
                                    const visible=!document.getElementById('homeScreen').hidden;
                                    await api.command('pin-smoke-proof',{phase:'tabless',homeVisible:visible});
                                    await api.command('navigate','minternet new home page query');
                                    await sleep(350);
                                    await api.command('pin-smoke-proof',{phase:'new-first'});
                                  },550);
                                "#);
                            } else if rapid_smoke {
                                let _ = view.eval(r#"
                                  setTimeout(async () => {
                                    const $ = id => document.getElementById(id);
                                    // An earlier native-menu smoke hides its test group and
                                    // persists it in the same WebView2 profile. Restore a
                                    // visible ungrouped tab before measuring window chrome.
                                    const state=window.minternetGroups?.getLatest();
                                    const first=state?.tabs?.[0];
                                    if(first)window.minternetGroups?.ungroup(first.id);
                                    const row=document.querySelector('.tab-row');
                                    const tab=document.querySelector('.tab');
                                    const group=$('tabGroups'),logo=document.querySelector('.identity');
                                    if (!tab||!group||!logo||!row)return;
                                    const visible=node=>Boolean(node)&&getComputedStyle(node).display!=='none' &&
                                      getComputedStyle(node).visibility!=='hidden';
                                    const ui={
                                      tabWidth:tab.getBoundingClientRect().width,
                                      logoFirst:logo.getBoundingClientRect().left<group.getBoundingClientRect().left,
                                      homeRemoved:!$('home'),
                                      kbdRemoved:!document.querySelector('.kbd'),
                                      torOnly:visible($('tor'))&&!$('private')&&!document.querySelector('.mode-text'),
                                      footerRemoved:!document.querySelector('.statusbar'),
                                      folderSaveRemoved:!$('bookmarkFolderPage'),
                                      compactBookmarks:getComputedStyle($('bookmarkItems')).columnGap==='0px',
                                      searchSetting:$('defaultSearchEngine')?.value==='google'&&!!window.minternetSearch
                                    };
                                    // Regression: double-click the empty RIGHT side of the
                                    // real tab strip, not merely the outer title bar.
                                    const strip=$('tabs');
                                    const fire=()=>{
                                      const bounds=strip.getBoundingClientRect();
                                      strip.dispatchEvent(new MouseEvent('dblclick',{
                                        bubbles:true,button:0,
                                        clientX:bounds.right-5,clientY:bounds.top+bounds.height/2
                                      }));
                                    };
                                    const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
                                    await window.minternet?.command('rapid-ui-smoke-stage','init');
                                    fire();await sleep(550);
                                    await window.minternet?.command('rapid-ui-smoke-proof',{phase:'maximize',ui});
                                    await window.minternet?.command('rapid-ui-smoke-stage','after-max');
                                    fire();await sleep(550);
                                    await window.minternet?.command('rapid-ui-smoke-proof',{phase:'restore',ui});
                                    await window.minternet?.command('rapid-ui-smoke-stage','after-restore');
                                  },750);
                                "#);
                            } else if pointer_smoke {
                                let _ = view.eval(r#"
                                  setTimeout(async () => {
                                    const groups=window.minternetGroups;
                                    const group=groups?.createGroup('Pointer Test','teal');
                                    if(!group)return;
                                    const strip=document.getElementById('tabs');
                                    const emit=(node,type,id,x,y)=>node.dispatchEvent(new PointerEvent(type,{
                                      bubbles:true,cancelable:true,pointerId:id,pointerType:'mouse',
                                      isPrimary:true,button:0,clientX:x,clientY:y
                                    }));
                                    const source=()=>document.querySelector('.tab[data-tab-id="1"]');
                                    const center=node=>{
                                      const r=node.getBoundingClientRect();
                                      return [r.left+r.width/2,r.top+r.height/2];
                                    };
                                    const tab=source(),chip=document.querySelector('.group-chip[data-group-id="'+group.id+'"]');
                                    if(!tab||!chip)return;
                                    let [sx,sy]=center(tab),[dx,dy]=center(chip);
                                    emit(tab.querySelector('.tab-choose'),'pointerdown',71,sx,sy);
                                    emit(document,'pointermove',71,dx,dy);
                                    emit(document,'pointerup',71,dx,dy);
                                    const joined=groups.getState().assignments['1']===group.id;
                                    const next=source();
                                    if(!next)return;
                                    [sx,sy]=center(next);
                                    const stripRect=strip.getBoundingClientRect();
                                    dx=stripRect.right-14;dy=stripRect.top+stripRect.height/2;
                                    emit(next.querySelector('.tab-choose'),'pointerdown',72,sx,sy);
                                    emit(document,'pointermove',72,dx,dy);
                                    emit(document,'pointerup',72,dx,dy);
                                    const left=groups.getState().assignments['1']==null;
                                    const noHtmlDrag=next.draggable===false;
                                    await window.minternet?.command('pointer-smoke-proof',{joined,left,noHtmlDrag});
                                  },650);
                                "#);
                            } else if search_smoke {
                                let _ = view.eval(r#"
                                  setTimeout(async () => {
                                    const phrase='minternet unique smoke phrase';
                                    const stage=s=>window.minternet?.command('search-smoke-stage',s);
                                    const search=window.minternetSearch;
                                    await stage('init-search:'+search?.getEngine?.());
                                    const form=document.getElementById('addressForm');
                                    const address=document.getElementById('address');
                                    const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
                                    for (const engine of ['google','brave']) {
                                      search.setEngine(engine);
                                      await stage('selected:'+engine);
                                      address.value=phrase;
                                      form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
                                      await stage('submitted:'+engine);
                                      await sleep(1000);
                                      const proof=await window.minternet?.command('search-smoke-proof',{engine,query:phrase});
                                      await stage('proof:'+engine+':'+JSON.stringify(proof).slice(0,600));
                                    }
                                  },550);
                                "#);
                            } else if menus_smoke {
                                let _ = view.eval(r#"
                                  setTimeout(async () => {
                                    const $ = id => document.getElementById(id);
                                    const stage = async s => { await window.minternet?.command('menu-smoke-stage',s); };
                                    try {
                                      await stage('init');
                                      $('bookmarkBarManage').click();
                                      $('bookmarkManageNewFolder').click();
                                      $('bookmarkName').value = 'Folder Menu Test';
                                      $('bookmarkEditForm').requestSubmit();
                                      const data = window.minternetBookmarks.getState();
                                      const root = data.items.findLast(n => n.kind === 'folder' && n.name === 'Folder Menu Test');
                                      if (!root) return;
                                      window.minternetBookmarks.newFolder(root.id);
                                      $('bookmarkName').value = 'Subfolder Test';
                                      $('bookmarkEditForm').requestSubmit();
                                      await stage('nested-created');
                                      const group = window.minternetGroups.createGroup('Reading','teal');
                                      window.minternetGroups.assign(1,group.id);
                                      window.minternetGroups.toggleVisible(group.id);
                                      await stage('group-hidden');
                                      const desc=window.minternetMenus.inspectBar();
                                      const groupEntry=desc.find(n => n.text?.includes('Tab Groups'));
                                      const btn=[...document.querySelectorAll('.bookmark-item')].find(n=>n.dataset.bookmarkId===root.id);
                                      if(!btn){await stage('no-button');return;}
                                      window.__minternetMenuSmoke=true;
                                       await stage('before-popup');
                                      await window.minternetMenus.folder(root.id,btn);
                                      await stage('after-popup:'+window.minternetMenus.nativePopupCount());
                                      const result=await window.minternet?.command('menu-smoke-proof',{
                                        folders:root.children.length+1,
                                        nativePopups:window.minternetMenus.nativePopupCount(),
                                        groupVisible:window.minternetGroups.get(group.id).visible,
                                        groupMenuRows:groupEntry?.items?.length||0
                                      });
                                      await stage('proof-response:'+JSON.stringify(result));
                                    } catch (e) {
                                      await stage('exception:'+String(e));
                                      console.warn('Native menu smoke failed',e);
                                    }
                                  },650);
                                "#);
                            }
                        }
                    }),
                LogicalPosition::new(0.0,0.0),
                LogicalSize::new(width,height)
            )?;
            // Restored pinned URLs need their real WebView2 on first launch;
            // without pins, activated displays the true tabless home view.
            activated(app.handle()).map_err(std::io::Error::other)?;
            let handle = app.handle().clone();
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Resized(_)) {
                    refresh_layout(&handle);
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Failed to run Minternet native browser");
}
