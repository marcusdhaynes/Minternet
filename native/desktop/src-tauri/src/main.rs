#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod password_vault;
mod browsing_history;
mod google_account;
mod firefox_bookmarks;
mod secret_bookmarks;
mod privacy_shield;
use base64::Engine as _;
use rand::{rngs::OsRng,RngCore};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;

use std::{sync::{Mutex,atomic::{AtomicBool,AtomicU64,Ordering}}, collections::{HashSet, HashMap, VecDeque}, path::PathBuf, time::{Instant, Duration}};
use serde::{Serialize,Deserialize};
use zeroize::Zeroize;
use serde_json::{json, Value};
use tauri::{
    Emitter, Manager, WebviewUrl, LogicalPosition, LogicalSize,
    webview::{WebviewBuilder, WebviewWindowBuilder, NewWindowResponse, PermissionKind, PermissionResponse, PageLoadEvent, DownloadEvent},
    window::WindowBuilder,
};

const CHROME: f64 = 52.0;
const BOOKMARK_BAR: f64 = 22.0;
const FIND_BAR: f64 = 22.0;
struct FindBarState(Mutex<bool>);
#[derive(Default)]
struct LocalMediaSelection(Mutex<Option<Value>>);
fn find_visible(app:&tauri::AppHandle)->bool{
    app.state::<FindBarState>().0.lock().map(|v|*v).unwrap_or(false)
}
const HOME: &str = "about:blank"; // Internal tab sentinel, never a homepage.
const DEFAULT_HOMEPAGE: &str = "https://www.google.com/";

#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
struct BrowserPreferences {
    homepage:String,
    // Default to a chrome-only dashboard with zero website WebViews.
    #[serde(default="default_new_tab_mode")]
    new_tab_mode:String,
    #[serde(default)]
    tab_limit:usize,
    #[serde(default)]
    download_folder:Option<String>,
    #[serde(default)]
    previous_download_folders:Vec<String>,
}
fn default_new_tab_mode()->String{"dashboard".into()}
fn valid_new_tab_mode(value:&str)->bool{matches!(value,"dashboard"|"website")}
impl Default for BrowserPreferences{
    fn default()->Self{
        Self{homepage:DEFAULT_HOMEPAGE.into(),new_tab_mode:default_new_tab_mode(),tab_limit:0,
            download_folder:None,previous_download_folders:Vec::new()}
    }
}
struct BrowserPreferenceState(Mutex<BrowserPreferences>);

fn validate_homepage(url:&str)->Result<String,String>{
    if url.len()>2048{return Err("Homepage URL too long".into());}
    let candidate=tauri::Url::parse(url)
        .map_err(|_|"Enter a complete http:// or https:// homepage URL")?;
    if !matches!(candidate.scheme(),"http"|"https")||
       candidate.host_str().is_none()||
       !candidate.username().is_empty()||candidate.password().is_some(){
        return Err("Homepage must be a normal HTTP or HTTPS website".into());
    }
    Ok(candidate.to_string())
}
// Zero means unlimited; lowering a positive limit never closes existing tabs.
fn has_tab_capacity(existing:usize, additional:usize, limit:usize)->bool{
    limit==0 || existing.checked_add(additional).is_some_and(|total|total<=limit)
}
#[cfg(test)]
mod tab_limit_tests {
    use super::*;
    #[test]
    fn unlimited_and_positive_limits(){
        assert_eq!(BrowserPreferences::default().tab_limit,0);
        assert!(has_tab_capacity(35,1,0));
        assert!(has_tab_capacity(999,1000,0));
        assert!(has_tab_capacity(34,1,35));
        assert!(!has_tab_capacity(35,1,35));
        assert!(!has_tab_capacity(40,1,35));
        assert!(!has_tab_capacity(usize::MAX,1,35));
        let mut browser=Browser::new();
        for _ in 0..40 {browser.add(false).unwrap();}
        browser.tab_limit=40;
        assert!(browser.add(false).is_err());
        browser.tab_limit=0;
        assert!(browser.add(false).is_ok());
    }
    #[test]
    fn legacy_preferences_default_to_unlimited(){
        let old=r#"{"homepage":"https://www.google.com/","downloadFolder":null}"#;
        let prefs:BrowserPreferences=serde_json::from_str(old).unwrap();
        assert_eq!(prefs.tab_limit,0);
    }
}
fn preferences_file(app:&tauri::AppHandle)->Result<PathBuf,String>{
    Ok(app.path().app_data_dir().map_err(|e|e.to_string())?
        .join("browser-preferences.v1.json"))
}
fn load_preferences(app:&tauri::AppHandle)->BrowserPreferences{
    let Ok(path)=preferences_file(app) else{return BrowserPreferences::default()};
    let Ok(bytes)=std::fs::read(path) else{return BrowserPreferences::default()};
    if bytes.len()>8192{return BrowserPreferences::default();}
    let Ok(mut saved)=serde_json::from_slice::<BrowserPreferences>(&bytes)
        else{return BrowserPreferences::default()};
    saved.homepage=validate_homepage(&saved.homepage)
        .unwrap_or_else(|_|DEFAULT_HOMEPAGE.into());
    if !valid_new_tab_mode(&saved.new_tab_mode){
        saved.new_tab_mode=default_new_tab_mode();
    }
    saved.previous_download_folders.truncate(8);
    saved.tab_limit=saved.tab_limit.min(1_000_000);
    saved
}
fn persist_preferences(app:&tauri::AppHandle,
    value:&BrowserPreferences)->Result<(),String>{
    let path=preferences_file(app)?;
    if let Some(parent)=path.parent(){std::fs::create_dir_all(parent)
        .map_err(|e|e.to_string())?;}
    let bytes=serde_json::to_vec(value).map_err(|e|e.to_string())?;
    let temp=path.with_extension("tmp");
    std::fs::write(&temp,bytes).map_err(|e|e.to_string())?;
    if std::fs::rename(&temp,&path).is_err(){
        std::fs::copy(&temp,&path).map_err(|e|e.to_string())?;
        std::fs::remove_file(&temp).ok();
    }
    Ok(())
}
fn new_tab_is_dashboard(app:&tauri::AppHandle)->bool{
    app.state::<BrowserPreferenceState>().0.lock()
        .map(|p|p.new_tab_mode!="website").unwrap_or(true)
}
fn homepage(app:&tauri::AppHandle)->tauri::Url{
    let saved=app.state::<BrowserPreferenceState>().0.lock()
        .ok().map(|p|p.homepage.clone()).unwrap_or_else(||DEFAULT_HOMEPAGE.into());
    tauri::Url::parse(&saved).unwrap_or_else(|_|
        tauri::Url::parse(DEFAULT_HOMEPAGE).expect("known safe homepage"))
}
#[cfg(test)]
mod home_and_download_tests{
    use super::*;
    #[test]
    fn home_is_google_until_user_changes_it(){
        assert_eq!(BrowserPreferences::default().homepage,DEFAULT_HOMEPAGE);
        assert_eq!(BrowserPreferences::default().new_tab_mode,"dashboard");
        assert_eq!(serde_json::from_str::<BrowserPreferences>(r#"{"homepage":"https://example.org/"}"#)
            .unwrap().new_tab_mode,"dashboard");
        assert_eq!(validate_homepage("https://example.org/start").unwrap(),
            "https://example.org/start");
        assert!(validate_homepage("javascript:alert(1)").is_err());
        assert!(validate_homepage("file:///c:/Windows").is_err());
        assert!(validate_homepage("https://user:password@example.org/").is_err());
    }
    #[test]
    fn warmup_is_not_a_real_tab_or_history_address(){
        assert!(!is_real_page_url("http://tauri.localhost/warmup.html"));
        assert!(!is_real_page_url("tauri://localhost/warmup.html"));
        assert!(!is_real_page_url("about:blank"));
        assert!(is_real_page_url("https://www.google.com/"));
        assert!(is_real_page_url("https://example.org/downloads"));
    }
    #[test]
    fn browser_can_validate_generated_file_download_urls(){
        let blob=tauri::Url::parse("blob:https://example.org/01234567").unwrap();
        let data=tauri::Url::parse("data:application/octet-stream;base64,AA==").unwrap();
        assert_eq!(blob.scheme(),"blob");
        assert_eq!(data.scheme(),"data");
        assert!(tauri::Url::parse("https://example.org/setup.exe").is_ok());
    }
}
fn configured_download_folder(app:&tauri::AppHandle)->Result<PathBuf,String>{
    let value=app.state::<BrowserPreferenceState>().0.lock()
        .map_err(|e|e.to_string())?.download_folder.clone();
    let selected=if let Some(folder)=value {PathBuf::from(folder)}
        else {app.path().download_dir().map_err(|_|"System Downloads folder unavailable")?};
    if !selected.is_absolute(){return Err("Downloads folder must be an absolute path".into());}
    std::fs::create_dir_all(&selected).map_err(|e|format!("Cannot create Downloads folder: {e}"))?;
    let resolved=std::fs::canonicalize(&selected).map_err(|e|e.to_string())?;
    if !resolved.is_dir(){return Err("Downloads path is not a folder".into());}
    // Supply WebView2 a conventional Windows path, not a \\?\ extended
    // canonical path (which some download handlers reject).
    Ok(selected)
}
fn allowed_download_folders(app:&tauri::AppHandle)->Vec<PathBuf>{
    let mut directories=Vec::new();
    if let Ok(dir)=configured_download_folder(app){
        if let Ok(real)=std::fs::canonicalize(dir){directories.push(real);}
    }
    if let Ok(dir)=app.path().download_dir(){
        if let Ok(dir)=std::fs::canonicalize(dir){directories.push(dir);}
    }
    if let Ok(prefs)=app.state::<BrowserPreferenceState>().0.lock(){
        for path in &prefs.previous_download_folders {
            if let Ok(dir)=std::fs::canonicalize(path){
                if dir.is_dir(){directories.push(dir);}
            }
        }
    }
    directories
}


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
    // Suppress late PageLoad events from the previous homepage after a user
    // has entered a new URL. Redirects from the requested URL still work.
    pending_previous_url:Option<String>,
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

// Opening the folder alone never authorizes opening individual sites.
// Successful per-bookmark code entry produces an item-specific, short-lived
// one-time decryption ticket, usable only by the corresponding Secret Tab.
// Best-effort plaintext scrubbing when a revealed secret page is concealed,
// unloaded or closed. The site WebView is separately destroyed by the caller.
fn scrub_secret_tab(tab:&mut Tab){
    if tab.secret_id.is_none(){return;}
    tab.url.zeroize();tab.url=HOME.into();
    tab.pending_previous_url=None;
    for page in &mut tab.history{page.zeroize();}
    tab.history=vec![HOME.into()];
    tab.title.zeroize();tab.title="Secret Tab".into();
    tab.at=0;tab.secret_revealed=false;tab.loading=false;
    tab.audio_playing=false;tab.audio_muted=false;
}

struct AuthorizedSecret {
    id:String,
    key:[u8;32],
    expires:Instant,
}
impl Drop for AuthorizedSecret {
    fn drop(&mut self){self.key.zeroize();}
}
#[derive(Default)]
struct AuthorizedSecrets{
    items:Mutex<HashMap<u32,AuthorizedSecret>>,
    cleanup_running:AtomicBool,
}
fn schedule_secret_access_expiry(app:&tauri::AppHandle){
    let manager=app.state::<AuthorizedSecrets>();
    if manager.cleanup_running.swap(true,Ordering::AcqRel){return;}
    let handle=app.clone();
    std::thread::spawn(move||loop {
        std::thread::sleep(Duration::from_secs(10));
        let manager=handle.state::<AuthorizedSecrets>();
        let Ok(mut tickets)=manager.items.lock() else{break};
        tickets.retain(|_,v|Instant::now()<=v.expires);
        if tickets.is_empty(){
            manager.cleanup_running.store(false,Ordering::Release);
            break;
        }
    });
}

struct Browser {
    tabs: Vec<Tab>,
    active_id: u32,
    next_id: u32,
    last_notified: Option<Snapshot>,
    warming: HashSet<u32>,
    tab_limit: usize,
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

// HTTP(S) attachments, generated blob downloads and data-URI downloads
// should work like ordinary WebView2 browser downloads. Generated downloads
// must come from the exact website tab that initiated the request.
fn download_source_allowed(app:&tauri::AppHandle,id:u32,url:&tauri::Url)->bool{
    if matches!(url.scheme(),"https"|"http"){
        return url.host_str().is_some();
    }
    let address={
        let state=app.state::<Mutex<Browser>>();
        let Ok(browser)=state.lock() else{return false};
        let Some(tab)=browser.tabs.iter().find(|tab|tab.id==id) else{return false};
        // Private downloads can be saved as user-visible files, but secret
        // pages must never yield concealed URLs to the normal download log.
        if tab.secret_id.is_some()&&!tab.secret_revealed{return false;}
        let Ok(source)=tauri::Url::parse(&tab.url) else{return false};
        if !matches!(source.scheme(),"http"|"https")||
            source.host_str().is_none(){return false;}
        true
    };
    // The event originates inside the exact WebView2 page controller,
    // including allowed sandboxed iframes with opaque blob:null origins.
    // Their exports may be byte streams with any file extension.
    address && matches!(url.scheme(),"blob"|"data")
}
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
    let roots=allowed_download_folders(app);
    if roots.is_empty(){return;}
    let state=app.state::<DownloadsState>();
    let Ok(mut history)=state.0.lock() else{return};
    for mut entry in entries.into_iter().rev().take(50).collect::<Vec<_>>().into_iter().rev(){
        if entry.private || entry.name.len()>160 || entry.source.len()>4096 {continue;}
        let path=PathBuf::from(&entry.path);
        let Ok(real_file)=std::fs::canonicalize(&path) else{continue};
        if !roots.iter().any(|root|real_file.starts_with(root))
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
    let dir=configured_download_folder(app)?;
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

#[cfg(windows)]
fn explicit_download_approval(tab_id:u32,url:&tauri::Url,path:&std::path::Path)->bool {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, MB_YESNO, MB_ICONWARNING, MB_DEFBUTTON2, MB_SETFOREGROUND, IDYES
    };
    // Suppress download prompt storms from hostile ad scripts. This is
    // intentionally a per-tab gate; a denied download is never written.
    static LAST_PROMPT:std::sync::OnceLock<Mutex<HashMap<u32,Instant>>> =
        std::sync::OnceLock::new();
    let lock=LAST_PROMPT.get_or_init(||Mutex::new(HashMap::new()));
    if let Ok(mut recent)=lock.lock(){
        let now=Instant::now();
        if recent.get(&tab_id).is_some_and(|t|now.duration_since(*t)<Duration::from_secs(2)){
            return false;
        }
        recent.insert(tab_id,now);
    }else{return false;}
    let name=path.file_name().and_then(|s|s.to_str()).unwrap_or("download")
        .chars().filter(|c|!c.is_control()).take(110).collect::<String>();
    let host=url.host_str().unwrap_or("generated browser content");
    let dangerous=matches!(path.extension().and_then(|s|s.to_str())
        .unwrap_or("").to_ascii_lowercase().as_str(),
        "exe"|"msi"|"msix"|"appx"|"bat"|"cmd"|"com"|"scr"|"ps1"|
        "vbs"|"js"|"jar"|"reg"|"lnk"|"dll");
    let warning=if dangerous {
        "WARNING: This file could execute code on your computer.\\n\\n"
    }else{""};
    let message=format!(
        "{warning}Allow this website download?\\n\\nFile: {name}\\nWebsite: {host}\\n\\nOnly choose Yes if YOU requested this exact file. Clicking Play on a video does not authorize a download.\\n\\nThe default answer is NO."
    );
    let wide=message.encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
    let title="Minternet — Verify Download".encode_utf16()
        .chain(std::iter::once(0)).collect::<Vec<_>>();
    let permitted=unsafe {
        MessageBoxW(None,PCWSTR(wide.as_ptr()),PCWSTR(title.as_ptr()),
            MB_YESNO|MB_ICONWARNING|MB_DEFBUTTON2|MB_SETFOREGROUND)==IDYES
    };
    if let Ok(mut recent)=lock.lock(){recent.insert(tab_id,Instant::now());}
    permitted
}
// Fail closed on non-Windows until an equivalent trusted OS confirmation
// dialog is implemented; the website itself cannot grant permission.
#[cfg(not(windows))]
fn explicit_download_approval(_tab_id:u32,_url:&tauri::Url,_path:&std::path::Path)->bool{
    false
}
fn is_disguised_executable(path:&std::path::Path)->bool{
    download_signature(path)==Some("exe") &&
        !path.extension().and_then(|x|x.to_str())
            .is_some_and(|x|x.eq_ignore_ascii_case("exe"))
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
                // A .txt/.dat file containing a PE executable is rejected,
                // deleted and never reclassified into a runnable .exe.
                if is_disguised_executable(std::path::Path::new(&entry.path)){
                    let _=std::fs::remove_file(&entry.path);
                    entry.status="blocked".into();
                }else{
                    let corrected=repair_download_extension(std::path::Path::new(&entry.path));
                    let is_exe=corrected.extension().and_then(|x|x.to_str())
                        .map(|x|x.eq_ignore_ascii_case("exe")).unwrap_or(false);
                    let valid_binary=!is_exe || download_signature(&corrected)==Some("exe");
                    if !valid_binary {let _=std::fs::remove_file(&corrected);}
                    entry.path=corrected.to_string_lossy().to_string();
                    entry.name=corrected.file_name().and_then(|x|x.to_str()).unwrap_or("Download").to_string();
                    entry.status=if valid_binary{"completed"}else{"blocked"}.into();
                }
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
    let roots=allowed_download_folders(app);
    let path=std::fs::canonicalize(&saved.0).map_err(|_|"Downloaded file no longer exists")?;
    if !path.is_file() || !roots.iter().any(|root|path.starts_with(root))
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
// Every website popup keeps its native WebView2 opener and profile.
static NEXT_POPUP_ID: AtomicU64 = AtomicU64::new(1);

struct PopupDeduper(Mutex<HashMap<(u32,String),Instant>>);
struct ZoomState(Mutex<f64>);
// Keep global output level separate from individually muted site tabs.
struct VolumeConfig { level:u16,muted:bool,manually_muted:HashSet<u32> }
impl Default for VolumeConfig {
    fn default()->Self { Self {level:100,muted:false,manually_muted:HashSet::new()} }
}
#[derive(Default)]
struct VolumeState(Mutex<VolumeConfig>);
#[derive(Default)]
struct SplitState(Mutex<Vec<u32>>);
struct SplitRatios(Mutex<(f64,f64)>);
struct UndoState { tabs: Vec<Tab>, active_id:u32, split_ids:Vec<u32>, ratios:(f64,f64), ui:Option<Value> }
struct UndoHistory(Mutex<VecDeque<UndoState>>);

fn remember_undo(app:&tauri::AppHandle, ui:Option<Value>) {
    let (tabs,active_id)={
        let state=app.state::<Mutex<Browser>>();
        let Ok(browser)=state.lock() else{return};
        let safe=browser.tabs.iter().map(|tab|{
            let mut saved=tab.clone();
            // Undo cannot retain or restore an authenticated secret website.
            if saved.secret_id.is_some(){
                saved.url.zeroize();saved.url=HOME.into();
                for page in &mut saved.history{page.zeroize();}
                saved.history=vec![HOME.into()];
                saved.title.zeroize();saved.title="Secret Tab".into();
                saved.at=0;saved.view=None;saved.secret_revealed=false;
            }
            saved
        }).collect::<Vec<_>>();
        (safe,browser.active_id)
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
    // Restored tabs must re-enter the independent bookmark code even when
    // Undo brings back their opaque tab identity.
    app.state::<AuthorizedSecrets>().items.lock().map_err(|e|e.to_string())?.clear();
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
    size_and_home: Option<(u32, u32, bool, bool, bool, u64, u32)>,
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
            tab_limit: 0,
        }
    }
    fn active(&self) -> Option<&Tab> {
        self.tabs.iter().find(|t| t.id == self.active_id)
    }
    fn active_mut(&mut self) -> Option<&mut Tab> {
        self.tabs.iter_mut().find(|t| t.id == self.active_id)
    }
    fn add(&mut self, private: bool) -> Result<u32, String> {
        if !has_tab_capacity(self.tabs.len(),1,self.tab_limit) {
            return Err(format!("Tab limit reached ({}). Set Tab Limit to 0 for unlimited.",self.tab_limit));
        }
        let id = self.next_id;
        self.next_id += 1;
        self.tabs.push(Tab {
            id, title: "New Tab".into(), url: HOME.into(), private,
            pinned: false, audio_playing:false, audio_muted:false,
            view: None, history: vec![HOME.into()], at: 0,
            inactive_since: None, loading: false, checking_unload: false,
            pending_previous_url:None,
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

#[cfg(test)]
mod secret_tab_privacy_tests {
    use super::*;
    #[test]
    fn secret_urls_titles_and_history_do_not_appear_in_public_snapshot() {
        let mut browser=Browser::new();
        let id=browser.add(true).unwrap();
        let tab=browser.tabs.iter_mut().find(|t|t.id==id).unwrap();
        tab.secret_id=Some("opaque-secret-id".into());
        tab.secret_revealed=true;
        tab.url="https://hidden.example/private?very_secret=token".into();
        tab.title="Top Secret Site".into();
        tab.history=vec![tab.url.clone()];
        let snap=browser.snapshot();
        let public=snap.tabs.first().unwrap();
        assert_eq!(public.url,HOME);
        assert_eq!(public.title,"Secret Tab");
        assert!(public.secret_tab);
        assert!(!public.secret_pending);
        assert!(public.private);
        assert!(!public.can_back && !public.can_forward);
        let bytes=serde_json::to_string(&snap).unwrap();
        assert!(!bytes.contains("hidden.example"));
        assert!(!bytes.contains("Top Secret Site"));
        browser.tabs[0].secret_revealed=false;
        assert!(browser.snapshot().tabs[0].secret_pending);
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
            .map(|tab|tab.url.clone()).collect::<Vec<_>>()
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
    if bytes.len()>16_000_000{return}
    let Ok(pages)=serde_json::from_slice::<Vec<String>>(&bytes) else {return};
    let state=app.state::<Mutex<Browser>>();
    let Ok(mut browser)=state.lock() else {return};
    for address in pages {
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
    // Capture live locations even for background tabs. ChatGPT and other SPAs
    // can change routes without a top-level WebView navigation callback.
    // Never query site DOM or save private / secret URLs.
    let live_views={
        let store=app.state::<Mutex<Browser>>();
        let browser=store.lock().map_err(|e|e.to_string())?;
        browser.tabs.iter().filter(|t|!t.private && t.secret_id.is_none() &&
            !t.loading).filter_map(|t|t.view.as_ref().map(|v|(t.id,v.clone())))
            .collect::<Vec<_>>()
    };
    let mut actual_urls=HashMap::new();
    for (id,label) in live_views {
        if let Some(view)=app.get_webview(&label) {
            if let Ok(url)=view.url() {
                if is_real_page_url(url.as_str()) {
                    actual_urls.insert(id,url.to_string());
                }
            }
        }
    }
    if std::env::args().any(|a|a.starts_with("--minternet-") && a.ends_with("smoke")) {return Ok(());}
    let data={
        let store=app.state::<Mutex<Browser>>();
        let browser=store.lock().map_err(|e|e.to_string())?;
        let tabs=browser.tabs.iter().filter(|tab|!tab.private).map(|tab|{
            let location=actual_urls.get(&tab.id).unwrap_or(&tab.url);
            json!({"url":location,"pinned":tab.pinned,"syncId":tab.sync_id})
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
    if bytes.len()>16_000_000 {restore_pinned(app);return;}
    let Ok(data)=serde_json::from_slice::<Value>(&bytes) else {restore_pinned(app);return};
    let Some(saved)=data.get("tabs").and_then(Value::as_array) else {restore_pinned(app);return};
    let state=app.state::<Mutex<Browser>>();
    let Ok(mut browser)=state.lock() else {return};
    for record in saved.iter() {
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

struct SessionSaveQueued(AtomicBool);
fn schedule_session_save(app:&tauri::AppHandle){
    // Saving session URLs queries native WebView controllers. Doing it inside
    // every tab-state notification/COM callback causes redundant main-thread
    // work and can destabilize WebView2 during rapid navigation.
    let gate=app.state::<SessionSaveQueued>();
    if gate.0.swap(true,Ordering::AcqRel){return;}
    let handle=app.clone();
    std::thread::spawn(move||{
        std::thread::sleep(Duration::from_millis(650));
        let callback_handle=handle.clone();
        if handle.run_on_main_thread(move||{
            let _=save_session(&callback_handle);
            callback_handle.state::<SessionSaveQueued>().0.store(false,Ordering::Release);
        }).is_err(){
            handle.state::<SessionSaveQueued>().0.store(false,Ordering::Release);
        }
    });
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
    schedule_session_save(app);
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

// Fetch a favicon image only, never the page body. Small, validated images
// are converted by trusted chrome to 24px PNG and cached in the local profile.
// This avoids repeated full-page discovery requests (notably to YouTube).
fn fetch_bookmark_icon_data(raw:&str)->Result<String,String>{
    use std::io::Read;
    let url=tauri::Url::parse(raw).map_err(|_|"Invalid icon URL")?;
    if url.scheme()!="https"||url.host_str().is_none()||
       !url.username().is_empty()||url.password().is_some(){
        return Err("Only credential-free HTTPS favicon URLs are allowed".into());
    }
    let host=url.host_str().unwrap_or_default().to_ascii_lowercase();
    if host=="localhost"||host.ends_with(".localhost")||host.ends_with(".local")||
       host.parse::<std::net::IpAddr>().is_ok(){
        return Err("Private or numeric hosts are not valid favicon sources".into());
    }
    let agent=ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(2))
        .timeout_read(Duration::from_secs(3))
        .timeout_write(Duration::from_secs(2))
        .redirects(0)
        .build();
    let response=agent.get(url.as_str())
        .set("Accept","image/png,image/jpeg,image/webp,image/x-icon")
        .call().map_err(|_|"Favicon fetch unavailable")?;
    // Require actual image content by magic bytes, not server-supplied MIME.
    let mut bytes=Vec::new();
    response.into_reader().take(100_001).read_to_end(&mut bytes)
        .map_err(|_|"Could not read favicon")?;
    if bytes.len()>100_000{return Err("Favicon exceeds 100 KB".into());}
    let mime=if bytes.starts_with(b"\x89PNG\r\n\x1a\n"){"image/png"}
       else if bytes.starts_with(&[0xff,0xd8,0xff]){"image/jpeg"}
       else if bytes.len()>=12&&bytes.starts_with(b"RIFF")&&&bytes[8..12]==b"WEBP"{"image/webp"}
       else if bytes.starts_with(&[0,0,1,0]){"image/x-icon"}
       else{return Err("Favicon is not a supported raster image".into());};
    Ok(format!("data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)))
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
    // Windows can report a zero/tiny client area while minimizing or dragging.
    // Never collapse a live WebView2 renderer to a 1-pixel surface: it can
    // become blank until another full layout or an expensive site refresh.
    if physical.width < 64 || physical.height < 64 {
        // A minimized or transiently zero-sized window must invalidate the
        // last successful bounds; otherwise restore-to-same-size can skip
        // the repaint and leave a WebView2 surface blank.
        invalidate_layout(app);
        return;
    }
    let Ok((width, height)) = dimensions(&window) else { return };
    let (show_home, active_id, active_label) = {
        let state = app.state::<Mutex<Browser>>();
        let Ok(browser) = state.lock() else { return };
        let current = browser.active();
        (current.map(|t|t.url == HOME).unwrap_or(true),
         browser.active_id,
         current.and_then(|t|if t.url == HOME {None} else {t.view.clone()}))
    };
    let positions = visible_split(app);
    let split_count = if positions.len()>1 { positions.len() } else { 0 };
    let split_signature = positions.iter().fold(0u64, |hash,id|
        hash.wrapping_mul(37).wrapping_add(*id as u64));
    let (bar_visible, overlay_open) = {
        let cache = app.state::<Mutex<LayoutCache>>();
        let Ok(state) = cache.lock() else { return };
        (state.bookmark_bar_visible, state.overlay_open)
    };
    let top = CHROME + if bar_visible { BOOKMARK_BAR } else { 0.0 }
        + if find_visible(app) {FIND_BAR} else {0.0};
    if height <= top + 1.0 { return; }
    // Include active tab identity: a previously hidden WebView must get its
    // current viewport before being shown, even when window size is unchanged.
    let signature = (physical.width, physical.height, show_home,
        bar_visible, overlay_open, split_signature, active_id);
    {
        let cache = app.state::<Mutex<LayoutCache>>();
        let Ok(state) = cache.lock() else { return };
        if state.size_and_home == Some(signature) { return; }
    }

    let mut applied = true;
    if let Some(chrome) = app.get_webview("chrome") {
        let full = show_home || overlay_open;
        let height_for_chrome = if full { height } else { top.min(height) };
        if chrome.set_size(LogicalSize::new(width, height_for_chrome)).is_err() {
            applied = false;
        }
    } else {
        applied = false;
    }

    let available = height - top;
    let ratios = app.state::<SplitRatios>().0.lock()
        .map(|r|*r).unwrap_or((0.5,0.5));
    // Resizing every background tab triggered many WebView2 COM operations
    // per mouse movement, delaying the active page and sometimes blanking it.
    // Background tabs retain their renderer and are laid out on activation.
    let visible_labels: Vec<String> = if split_count > 1 {
        positions.iter().map(|id|format!("tab-{id}")).collect()
    } else {
        active_label.into_iter().collect()
    };
    for (index, label) in visible_labels.iter().enumerate() {
        let (x,y,w,h) = if split_count > 1 {
            split_rect(index,split_count,width,available,top,ratios.0,ratios.1)
        } else {
            (0.0,top,width,available)
        };
        if let Some(view) = app.get_webview(label) {
            // One atomic parent-relative bounds update, rather than two
            // separate position/size calls that can expose an empty frame.
            let bounds = tauri::Rect {
                position: LogicalPosition::new(x,y).into(),
                size: LogicalSize::new(w.max(1.0),h.max(1.0)).into(),
            };
            if view.set_bounds(bounds).is_err() { applied = false; }
            notify_native_compositor(&view);
        } else {
            applied = false;
        }
    }
    update_split_badges(app,&window,
        if split_count > 1 {positions.as_slice()} else {&[]},
        width,available,top);
    if overlay_open { raise_chrome_above_site(app); }
    // Only cache successful layouts. A transient controller failure should
    // be retried on the next resize/tab switch, never permanently skipped.
    let cache = app.state::<Mutex<LayoutCache>>();
    if let Ok(mut state) = cache.lock() {
        if state.bookmark_bar_visible == bar_visible && state.overlay_open == overlay_open {
            state.size_and_home = if applied {Some(signature)} else {None};
        }
    };
}
// WebView2 can occasionally retain a blank compositor surface after restoring
// the native window, switching tabs, or finishing a large SPA navigation.
// Reapply the *visible* view bounds and visibility without resetting its URL,
// cookies, scroll position or application state.
struct SurfaceRestoreQueued(AtomicBool);
fn schedule_surface_restore(app:&tauri::AppHandle){
    if app.state::<SurfaceRestoreQueued>().0.swap(true,Ordering::AcqRel){return;}
    let handle=app.clone();
    std::thread::spawn(move||{
        std::thread::sleep(Duration::from_millis(32));
        let task=handle.clone();
        if handle.run_on_main_thread(move||{
            restore_visible_surfaces(&task);
            task.state::<SurfaceRestoreQueued>().0.store(false,Ordering::Release);
        }).is_err(){
            handle.state::<SurfaceRestoreQueued>().0.store(false,Ordering::Release);
        }
    });
}
#[cfg(windows)]
fn notify_native_compositor(view:&tauri::Webview){
    // WebView2's HWND composition can keep stale/white surface rectangles
    // after a parent resize, OS snap, tab restore or DPI change. Notify its
    // native controller after setting the child bounds. Never reload a SPA.
    let _=view.with_webview(|native|{
        let _=unsafe{native.controller().NotifyParentWindowPositionChanged()};
    });
}
#[cfg(not(windows))]
fn notify_native_compositor(_view:&tauri::Webview){}
fn restore_visible_surfaces(app:&tauri::AppHandle){
    invalidate_layout(app);
    refresh_layout(app);
    let labels={
        let split=visible_split(app);
        let store=app.state::<Mutex<Browser>>();
        let Ok(browser)=store.lock() else{return};
        if split.len()>1 {
            split.iter().filter_map(|id|browser.tabs.iter().find(|t|t.id==*id)
                .and_then(|tab|tab.view.clone())).collect::<Vec<_>>()
        }else{
            browser.active().and_then(|tab|tab.view.clone()).into_iter().collect::<Vec<_>>()
        }
    };
    for label in labels {
        if let Some(view)=app.get_webview(&label){
            let _=view.show();
            notify_native_compositor(&view);
        }
    }
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

fn is_real_page_url(url:&str)->bool{
    // Internal prepared controllers must never become a visible browser URL.
    let Ok(actual)=tauri::Url::parse(url) else{return false};
    matches!(actual.scheme(),"http"|"https") &&
        actual.host_str().is_some() &&
        !(matches!(actual.host_str(),Some("tauri.localhost")|Some("localhost"))
          && actual.path()=="/warmup.html")
}
fn update_from_site(app: &tauri::AppHandle, id: u32, url: &str) {
    if !is_real_page_url(url){return;}
    let mut pinned_change=false;
    {
        let state=app.state::<Mutex<Browser>>();
        if let Ok(mut browser)=state.lock(){
            if let Some(tab)=browser.tabs.iter_mut().find(|tab|tab.id==id){
                if tab.secret_id.is_some(){return;}
                if tab.pending_previous_url.as_deref()==Some(url)&&tab.url!=url{
                    // The old homepage finished after the new address was
                    // submitted; don't revert its address bar or history.
                    return;
                }
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

// Periodically inspect only native WebView URLs, not DOM text or website scripts.
// React/Vue/ChatGPT history.pushState changes the current path without a
// PageLoadEvent; saving the last load event would reopen a landing page.
fn refresh_session_urls(app:&tauri::AppHandle)->usize{
    let candidates={
        let store=app.state::<Mutex<Browser>>();
        let Ok(browser)=store.lock() else{return 0};
        browser.tabs.iter().filter(|t|!t.private && t.secret_id.is_none())
            .filter_map(|t|t.view.as_ref().map(|label|(t.id,label.clone(),t.url.clone())))
            .collect::<Vec<_>>()
    };
    let mut changed=0;
    for (id,label,previous) in candidates{
        let Some(view)=app.get_webview(&label) else{continue};
        let Ok(actual)=view.url() else{continue};
        let address=actual.as_str();
        if address!=previous && is_real_page_url(address){
            update_from_site(app,id,address);
            // SPAs change routes with history.pushState and never generate a
            // new PageLoadEvent. Check the new active login route as well.
            let login_route=actual.path().to_ascii_lowercase();
            if ["login","sign-in","signin","authentication"].iter()
                .any(|part|login_route.contains(part)) {
                let active=app.state::<Mutex<Browser>>().lock()
                    .map(|browser|browser.active_id==id).unwrap_or(false);
                if active {let _=fill_saved_credential(app,id,false,None);}
            }
            changed+=1;
        }
    }
    changed
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


#[cfg(windows)]
fn emit_browser_favicon(app:tauri::AppHandle,id:u32,
    source:webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2) {
    use windows::core::Interface;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_15, COREWEBVIEW2_FAVICON_IMAGE_FORMAT_PNG
    };
    let mut url=windows::core::PWSTR::null();
    if (unsafe{source.Source(&mut url)}).is_err(){return;}
    let page=webview2_com::take_pwstr(url);
    let Ok(mut address)=tauri::Url::parse(&page) else{return};
    if !matches!(address.scheme(),"http"|"https") || address.host_str().is_none(){return;}
    address.set_query(None);
    address.set_fragment(None);
    let Ok(favicon)=source.cast::<ICoreWebView2_15>() else{return};
    let page=address.to_string();
    let callback=webview2_com::GetFaviconCompletedHandler::create(Box::new(move |result,stream|{
        if !result.is_ok(){return Ok(());}
        let Some(stream)=stream else{return Ok(())};
        let mut bytes=Vec::new();
        loop {
            let mut chunk=[0u8;8192];
            let mut count=0u32;
            if (unsafe{stream.Read(chunk.as_mut_ptr().cast(),8192,Some(&mut count))}).is_err(){break;}
            if count==0{break;}
            if bytes.len()+count as usize>90_000{return Ok(());}
            bytes.extend_from_slice(&chunk[..count as usize]);
        }
        if bytes.len()<8 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n"){return Ok(());}
        let encoded=base64::engine::general_purpose::STANDARD.encode(bytes);
        let _=app.emit_to("chrome","minternet:native-favicon",
            json!({"tabId":id,"page":page,"image":format!("data:image/png;base64,{encoded}")}));
        Ok(())
    }));
    let _=unsafe{favicon.GetFavicon(COREWEBVIEW2_FAVICON_IMAGE_FORMAT_PNG,&callback)};
}
#[cfg(windows)]
fn attach_browser_favicon(app:&tauri::AppHandle,id:u32,view:&tauri::Webview){
    use windows::core::Interface;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_15;
    let caller=app.clone();
    let _=view.with_webview(move |native|{
        let Ok(web)=(unsafe{native.controller().CoreWebView2()}) else{return};
        let Ok(favicon)=web.cast::<ICoreWebView2_15>() else{return};
        let handler=webview2_com::FaviconChangedEventHandler::create(Box::new(move |source,_|{
            if let Some(source)=source {
                emit_browser_favicon(caller.clone(),id,source);
            }
            Ok(())
        }));
        let mut token=0i64;
        let _=unsafe{favicon.add_FaviconChanged(&handler,&mut token)};
    });
}
#[cfg(windows)]
fn refresh_browser_favicon(app:&tauri::AppHandle,id:u32,label:&str){
    let Some(view)=app.get_webview(label) else{return};
    let handle=app.clone();
    let _=view.with_webview(move |native|{
        if let Ok(source)=unsafe{native.controller().CoreWebView2()} {
            emit_browser_favicon(handle,id,source);
        }
    });
}

fn create_webview(app: &tauri::AppHandle, id: u32, url: WebviewUrl, private: bool) -> Result<(), String> {
    let Some(window) = app.get_window("main") else { return Err("Missing window".into()) };
    let label = format!("tab-{id}");
    let (width, height) = dimensions(&window)?;
    let top = chrome_top(app);
    let for_load = app.clone();
    let for_navigation = app.clone();
    let for_title = app.clone();
    let for_popup = app.clone();
    let for_download=app.clone();
    let shield_preferences=app.state::<privacy_shield::ShieldState>().0.lock()
        .map(|s|s.clone()).unwrap_or_default();
    let builder = WebviewBuilder::new(label.clone(), url)
        .incognito(private)
        .initialization_script(privacy_shield::script(&shield_preferences))
        // A remote page never receives native commands. This reserved
        // non-loading popup URL is a narrowly scoped Ctrl+F signal that
        // the native new-window handler consumes without navigating.
        .initialization_script(r#"(() => {
          const nativeOpen=window.open;
          window.addEventListener('keydown',event => {
            if((event.ctrlKey||event.metaKey)&&
               !event.altKey&&!event.shiftKey&&
               event.key.toLowerCase()==='f'){
              event.preventDefault();
              event.stopImmediatePropagation();
              Reflect.apply(nativeOpen,window,
                ['https://minternet-find.invalid/__open','_blank']);
            }
          },true);
          // A focus signal does not contain a username, password, or page text.
          // Native code will enforce exact HTTPS origin and unlocked vault.
          let lastLoginSignal=0;
          window.addEventListener('focusin',event=>{
            const field=event.target;
            if(!field||field.tagName!=='INPUT')return;
            const type=(field.type||'').toLowerCase();
            const auto=(field.autocomplete||'').toLowerCase();
            const login=type==='password'||auto.includes('username')||
              (type==='email'&&/login|signin|sign-in|auth|account|session/i.test(location.pathname));
            if(!login||Date.now()-lastLoginSignal<800)return;
            lastLoginSignal=Date.now();
            Reflect.apply(nativeOpen,window,
              ['https://minternet-autofill.invalid/__retry','_blank']);
          },true);
        })();"#)
        // Honor Ctrl/Cmd + plus/minus and Ctrl + mouse-wheel when focus is
        // inside the actual website WebView, not just the browser toolbar.
        .zoom_hotkeys_enabled(true)
        // Do not block internal warmup.html: the prepared WebView2 controller
        // must actually load before its first HTTPS navigation. Ordinary HTTP
        // is legitimate browser content but remains visibly marked insecure.
        .on_navigation(move |url| {
            if matches!(url.scheme(), "https"|"http") {
                let blocked=for_navigation.state::<privacy_shield::ShieldState>().0.lock()
                    .map(|settings|privacy_shield::block_navigation(&settings,url)).unwrap_or(false);
                if blocked {
                    let _=for_navigation.emit_to("chrome","minternet:shield-blocked",json!({"kind":"navigation"}));
                    return false;
                }
                return url.host_str().is_some();
            }
            if url.scheme()=="blob" {
                return download_source_allowed(&for_navigation,id,&url);
            }
            url.as_str()=="about:blank" ||
                ((url.scheme()=="tauri" || url.host_str()==Some("tauri.localhost"))
                 && url.path()=="/warmup.html")
        })
        // PermissionKind::Other includes browser-managed identity/storage requests
        // (FedCM and Storage Access). Denying it globally silently breaks
        // third-party Google sign-in. Keep explicit dangerous permissions
        // denied; let WebView2 handle identity permissions normally.
        .on_permission_request(|_view, kind| match kind {
            PermissionKind::Other => PermissionResponse::Default,
            _ => PermissionResponse::Deny,
        })
        .on_download(move |_view,event|{
            match event {
                DownloadEvent::Requested{url,destination}=>{
                    // WebView2 decides whether to render inline (PDFs, images,
                    // media) or download. Don't reject ordinary HTTP, blob:
                    // exports, data: attachments, or user-clicked .exe files.
                    if !download_source_allowed(&for_download,id,&url){return false;}
                    match download_path(&for_download,&url,destination.as_path()){
                        Ok(path)=>{
                            if !explicit_download_approval(id,&url,&path){
                                let _=for_download.emit_to("chrome","minternet:download-blocked",
                                    json!({"kind":"unapproved-download"}));
                                return false;
                            }
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
            if url.as_str()=="https://minternet-find.invalid/__open" {
                let _=for_popup.emit_to("chrome","minternet:find-open",json!({}));
                return NewWindowResponse::Deny;
            }
            if url.as_str()=="https://minternet-autofill.invalid/__retry" {
                // A website may request a retry, but it cannot specify the
                // credential or receive any native response. The vault and
                // exact visible HTTPS origin are checked again in native code.
                let proceed=for_popup.state::<PopupDeduper>().0.lock().map(|mut state|{
                    let key=(id,String::from("autofill"));
                    let now=Instant::now();
                    if state.get(&key).is_some_and(|last|
                        now.duration_since(*last)<Duration::from_millis(700)){return false;}
                    state.insert(key,now);
                    true
                }).unwrap_or(false);
                if proceed {
                    let app=for_popup.clone();
                    std::thread::spawn(move||{
                        std::thread::sleep(Duration::from_millis(100));
                        let main=app.clone();
                        let _=app.run_on_main_thread(move||{
                            let _=fill_saved_credential(&main,id,false,None);
                        });
                    });
                }
                return NewWindowResponse::Deny;
            }
            // All site-created popup windows are allowed. No origin policy,
            // host list, user-gesture check, rate limit or window cap.
            let label=format!("site-popup-{}",
                NEXT_POPUP_ID.fetch_add(1,Ordering::Relaxed));
            let builder=WebviewWindowBuilder::new(
                    &for_popup,label,WebviewUrl::External(
                        tauri::Url::parse("about:blank").expect("valid blank URL")))
                .window_features(features)
                .title("Minternet Popup")
                // Site popup windows cannot silently download files.
                .on_download(|_view,event|match event{
                    DownloadEvent::Requested{..}=>false,
                    _=>true
                })
                .inner_size(540.0,680.0)
                .resizable(true)
                .on_navigation(|destination| {
                    (matches!(destination.scheme(),"https"|"http")
                        && destination.host_str().is_some())
                    || destination.as_str()=="about:blank"
                    || (destination.scheme()=="blob"
                        && (destination.as_str().starts_with("blob:https://")
                            || destination.as_str().starts_with("blob:http://")))
                })
                .on_document_title_changed(|window,title| {
                    let safe=title.chars().take(100).collect::<String>();
                    if !safe.is_empty(){let _=window.set_title(&safe);}
                    if safe=="Minternet OAuth Popup Smoke" &&
                        std::env::args().any(|a|a=="--minternet-auth-popup-smoke") {
                        let marker=std::env::temp_dir().join(format!(
                            "minternet-auth-popup-{}.ok",std::process::id()));
                        let _=std::fs::write(marker,
                            "Native WebView2 popup retained opener and rendered title");
                    }
                });
            match builder.build(){
                Ok(window)=>NewWindowResponse::Create{window},
                Err(error)=>{
                    eprintln!("Cannot open related Minternet popup: {error}");
                    NewWindowResponse::Deny
                }
            }
        })
        .on_page_load(move |view, event| {
            if matches!(event.event(), PageLoadEvent::Started | PageLoadEvent::Finished) {
                let mut stale=false;
                {
                    let state=for_load.state::<Mutex<Browser>>();
                    if let Ok(mut b)=state.lock(){
                        if let Some(tab)=b.tabs.iter_mut().find(|tab|tab.id==id){
                            if tab.pending_previous_url.as_deref()==Some(event.url().as_str())
                                && tab.url!=event.url().as_str() {
                                stale=true;
                            }else{
                                tab.pending_previous_url=None;
                                tab.loading=matches!(event.event(),PageLoadEvent::Started);
                                tab.checking_unload=false;
                            }
                        }
                    };
                }
                if stale{return;}
                update_from_site(&for_load, id, event.url().as_str());
                if matches!(event.event(), PageLoadEvent::Finished) {
                    // A completed navigation can still display an unrepainted
                    // WebView2 surface. Restore its bounds without reloading.
                    let is_active=for_load.state::<Mutex<Browser>>().lock().ok()
                        .is_some_and(|browser|browser.active_id==id);
                    // Layout/shows from inside a WebView2 load callback can
                    // re-enter its COM controller. Queue a repaint instead.
                    if is_active {schedule_surface_restore(&for_load);}
                    record_page_history(&for_load,id,event.url().as_str(),None);
                    #[cfg(windows)]
                    if event.url().scheme()=="https" || event.url().scheme()=="http" {
                        let app=for_load.clone();
                        let label=view.label().to_string();
                        std::thread::spawn(move||{
                            std::thread::sleep(Duration::from_millis(380));
                            let worker=app.clone();
                            let _=app.run_on_main_thread(move||refresh_browser_favicon(&worker,id,&label));
                        });
                    }
                    // Automatically fill one enabled, encrypted saved login
                    // after the exact HTTPS page has loaded. Locked vaults,
                    // private/secret tabs and ambiguous accounts are skipped.
                    if is_active && event.url().scheme()=="https" {
                        // Never evaluate more JS synchronously while WebView2
                        // is emitting navigation completion callbacks.
                        let handle=for_load.clone();
                        std::thread::spawn(move||{
                            std::thread::sleep(Duration::from_millis(180));
                            let task=handle.clone();
                            let _=handle.run_on_main_thread(move||{
                                let _=fill_saved_credential(&task,id,false,None);
                            });
                        });
                    }
                    // ChatGPT can occasionally finish a WebView2 navigation
                    // while leaving an empty document surface. Retry the same
                    // conversation URL exactly once if it remains textless and
                    // noninteractive for twenty seconds. Do not reload a page
                    // with any active input, media or visible application text.
                    if event.url().host_str()==Some("chatgpt.com") {
                        let _=view.eval(r#"
                          (() => {
                            const marker='minternet-blank-surface-retry-v1';
                            setTimeout(() => {
                              try {
                                if(document.visibilityState!=='visible')return;
                                if(document.readyState!=='complete')return;
                                if(sessionStorage.getItem(marker)==='done')return;
                                const body=document.body;
                                if(!body || (body.innerText||'').trim().length>=32)return;
                                if(document.querySelector('textarea,input:not([type="hidden"]),[contenteditable="true"],video,canvas'))return;
                                sessionStorage.setItem(marker,'done');
                                location.reload();
                              } catch {}
                            },20000);
                          })();
                        "#);
                    }
                    if is_real_page_url(event.url().as_str()) {
                        apply_volume_to_site(&for_load,id,view.label(),true);
                    }
                    // CI only: open about:blank exactly as OAuth popup libraries
                    // do, then assert a same-origin opener can write to it.
                    // No Google account or sign-in secrets are used.
                    if event.url().host_str()==Some("example.com") &&
                        std::env::args().any(|a|a=="--minternet-auth-popup-smoke") {
                        let _=view.eval(r#"
                            setTimeout(() => {
                              const popup=window.open('about:blank',
                                'minternet-auth-popup-smoke','width=480,height=600');
                              if (!popup) return;
                              popup.document.open();
                              popup.document.write('<!doctype html><html><head><title>OAuth popup</title></head><body>Checking opener</body></html>');
                              popup.document.close();
                              if (popup.opener===window)
                                popup.document.title='Minternet OAuth Popup Smoke';
                            }, 250);
                        "#);
                    }
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
        .on_document_title_changed(move |view, title| {
            // A SPA may change its route and title without reloading WebView2.
            if let Ok(address)=view.url(){update_from_site(&for_title,id,address.as_str());}
            let state = for_title.state::<Mutex<Browser>>();
            let mut confirmed_in_app = false;
            if let Ok(mut browser) = state.lock() {
                if let Some(tab) = browser.tabs.iter_mut().find(|tab| tab.id == id) {
                    if tab.secret_id.is_some()||tab.url==HOME{return;}
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
    // WebView2 has already selected the page's actual favicon (including
    // dynamic icons, custom paths and CDN icons). Subscribe to changes
    // instead of guessing /favicon.ico like the old toolbar did.
    #[cfg(windows)]
    attach_browser_favicon(app,id,&created);
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
// Apply volume without handing any native IPC capability to remote documents.
// Web Audio amplifies eligible HTML5 audio; Windows native audio mute also
// silences unsupported streams, cross-origin frames, and DRM protected media.
fn apply_volume_to_site(app:&tauri::AppHandle,id:u32,label:&str,initialize:bool) {
    let Some(view)=app.get_webview(label) else{return};
    let (level,mute)={
        let state=app.state::<VolumeState>();
        let Ok(config)=state.0.lock() else{return};
        (config.level,config.muted||config.level==0||config.manually_muted.contains(&id))
    };
    let ratio=level as f64/100.0;
    if initialize {
        let script=format!("{}\nwindow.__minternetAudioGain?.setLevel({ratio});",
            include_str!("../../../../ui/audio-gain.js"));
        let _=view.eval(&script);
    }else{
        let _=view.eval(&format!("window.__minternetAudioGain?.setLevel({ratio});"));
    }
    #[cfg(windows)]
    {
        let _=view.with_webview(move |native|{
            use windows::core::Interface;
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
            if let Ok(audio)=(unsafe{native.controller().CoreWebView2()})
                .and_then(|webview|webview.cast::<ICoreWebView2_8>()){
                let _=unsafe{audio.SetIsMuted(mute)};
            }
        });
    }
    #[cfg(not(windows))]
    let _=mute;
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
        (tab.view.clone(),tab.url.clone(),tab.private||tab.secret_id.is_some())
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
    let data=serde_json::json!({"origin":actual_origin,"username":entry.username,"password":entry.password});
    // Exact-origin login forms only. A short, bounded observer accommodates
    // React/SPA forms added after the load event; never submit automatically,
    // change existing input, or select an arbitrary login on multi-account sites.
    const LOGIN_FILL_JS:&str=r###"(function(){
      'use strict';
      const credential=__MINTERNET_LOGIN_PAYLOAD__;
      if(location.protocol!=='https:'||location.origin!==credential.origin||
         window!==window.top)return;
      const register=/(?:sign.?up|register|create.?account|join|forgot.?password|reset.?password|change.?password)/i;
      const signin=/(?:log.?in|sign.?in|auth|account|session|identify)/i;
      const safeRoute=()=>!register.test(location.pathname);
      const visible=el=>el instanceof HTMLInputElement&&
        !el.disabled&&!el.readOnly&&el.getClientRects().length>0&&
        el.type!=='hidden'&&el.type!=='file';
      const token=el=>(el.getAttribute('autocomplete')||'').toLowerCase().split(/\s+/);
      const hint=el=>[
        el.name||'',el.id||'',el.placeholder||'',el.getAttribute('aria-label')||'',
        el.labels?.[0]?.textContent||'',el.closest('label')?.textContent||''
      ].join(' ').toLowerCase();
      function roots(){
        const result=[document],seen=new Set(result),queue=[document];
        let budget=0;
        while(queue.length&&budget<6000&&result.length<28){
          const root=queue.shift();
          let nodes;
          try{nodes=root.querySelectorAll('*');}catch{continue;}
          for(const node of nodes){
            if(++budget>6000)break;
            if(node.shadowRoot&&!seen.has(node.shadowRoot)){
              seen.add(node.shadowRoot);queue.push(node.shadowRoot);result.push(node.shadowRoot);
            }
            if(node.tagName==='IFRAME'){
              try{
                const frame=node.contentDocument;
                if(frame&&frame.defaultView?.location.origin===credential.origin&&!seen.has(frame)){
                  seen.add(frame);queue.push(frame);result.push(frame);
                }
              }catch{}
            }
          }
        }
        return result;
      }
      function fields(){
        const list=[];
        for(const root of roots()){
          try{list.push(...root.querySelectorAll('input'));}catch{}
        }
        return list.filter(visible);
      }
      const put=(element,value)=>{
        if(!element||element.value||typeof value!=='string'||!value)return false;
        const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
        if(setter)setter.call(element,value);else element.value=value;
        element.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
        element.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
        return true;
      };
      const userCandidate=el=>
        token(el).includes('username') ||
        el.type==='email' || (el.type==='text' && /user|email|e.?mail|login|account/i.test(hint(el)));
      const dangerousForm=el=>{
        const form=el?.form;
        return form instanceof HTMLFormElement &&
          register.test([form.getAttribute('action')||'',form.id,form.className].join(' '));
      };
      let usernamePrepared=false,done=false,observer=null,delayed=0;
      const stop=()=>{
        done=true;
        if(observer)observer.disconnect();
        document.removeEventListener('focusin',onFocus,true);
        window.removeEventListener('pageshow',attempt);
        window.removeEventListener('popstate',attempt);
        window.removeEventListener('hashchange',attempt);
        if(delayed)clearTimeout(delayed);
        // Avoid retaining the password in a long-lived page closure.
        credential.password='';
      };
      function tryFill(){
        if(done)return true;
        if(location.origin!==credential.origin||!safeRoute()){stop();return true;}
        const inputs=fields(),passwords=inputs.filter(el=>el.type==='password');
        const current=passwords.filter(el=>token(el).includes('current-password'));
        // A register/reset form can expose multiple new password inputs:
        // never choose an arbitrary field.
        const newPasswords=passwords.filter(el=>token(el).includes('new-password')||
          token(el).includes('one-time-code'));
        if(newPasswords.length && current.length===0)return false;
        const password=current.length===1?current[0]:
          (passwords.length===1&&newPasswords.length===0?passwords[0]:null);
        if(password){
          if(dangerousForm(password)){stop();return true;}
          const form=password.form;
          const local=form?inputs.filter(el=>el.form===form):inputs;
          const account=local.find(userCandidate)||inputs.find(userCandidate);
          // Never replace anything the person has already entered.
          if(password.value || (account?.value&&account.value!==credential.username)){
            stop();return true;
          }
          if(account)put(account,credential.username);
          if(put(password,credential.password)){stop();return true;}
          return false;
        }
        // Username-first providers (Google, Microsoft and many SPAs) show
        // the email field before creating a password input.
        const username=inputs.find(el=>token(el).includes('username'))||
          inputs.find(el=>userCandidate(el)&&
            (signin.test(location.pathname)||signin.test(
              (el.form?.getAttribute('action')||'')+' '+
              (el.form?.id||'')+' '+(el.form?.className||''))));
        if(username&&!dangerousForm(username) &&
           !usernamePrepared && !username.value){
          usernamePrepared=put(username,credential.username);
        }
        // Retain the bounded observer until the password step mounts.
        return false;
      }
      let last=0;
      function attempt(){
        if(done)return;
        const now=Date.now();
        if(now-last<70){
          if(!delayed)delayed=setTimeout(()=>{delayed=0;attempt();},75);
          return;
        }
        last=now;
        tryFill();
      }
      function onFocus(event){
        if(!event.target || event.target.tagName!=='INPUT')return;
        attempt();
      }
      attempt();
      if(done||!document.documentElement)return;
      observer=new MutationObserver(attempt);
      observer.observe(document.documentElement,
        {childList:true,subtree:true,attributes:true,attributeFilter:['type','autocomplete','style','class']});
      document.addEventListener('focusin',onFocus,true);
      window.addEventListener('pageshow',attempt);
      window.addEventListener('popstate',attempt);
      window.addEventListener('hashchange',attempt);
      setTimeout(stop,90000);
    })()"###;
    let mut payload=data.to_string();
    let mut script=LOGIN_FILL_JS.replace("__MINTERNET_LOGIN_PAYLOAD__",&payload);
    use zeroize::Zeroize;
    entry.password.zeroize();
    payload.zeroize();
    let result=view.eval(&script).map_err(|e|e.to_string());
    script.zeroize();
    result?;
    Ok(true)
}

// Prepare one lightweight WebView2 controller only after the user focuses a
// blank tab's address input. This does not connect to sites or leak typed URLs.
// Site pages never receive the user's identity list. Only one explicitly
// chosen record reaches the already selected, exact HTTPS page.
const IDENTITY_FILL_JS:&str=r#"(function(){
  'use strict';
  const profile=__MINTERNET_IDENTITY_PAYLOAD__;
  if(window!==window.top || location.origin!==profile.origin)return;
  const all=[...document.querySelectorAll('input,textarea,select')].filter(el=>{
    if(el.disabled||el.readOnly||['hidden','password','file'].includes(el.type))return false;
    const r=el.getBoundingClientRect();
    return r.width>0&&r.height>0;
  });
  const auto=el=>(el.autocomplete||'').toLowerCase().split(/\s+/);
  const tag=el=>[
    el.name||'',el.id||'',el.placeholder||'',
    el.getAttribute('aria-label')||'',el.labels?.[0]?.textContent||'',
    el.closest('label')?.textContent||''
  ].join(' ').toLowerCase();
  const rules={
    'full-name':/^(?:name)$/,'given-name':/^(?:given-name)$/,'family-name':/^(?:family-name)$/,
    'middle-name':/^(?:additional-name)$/,'nickname':/^(?:nickname)$/,
    'email':/^(?:email)$/,'phone':/^(?:tel|tel-national)$/,
    'company':/^(?:organization)$/,'job-title':/^(?:organization-title)$/,
    'street-address':/^(?:street-address)$/,'address-line1':/^(?:address-line1)$/,
    'address-line2':/^(?:address-line2)$/,'city':/^(?:address-level2)$/,
    'region':/^(?:address-level1)$/,'postal-code':/^(?:postal-code)$/,
    'country':/^(?:country-name|country)$/,'date-of-birth':/^(?:bday)$/,
    'website':/^(?:url)$/
  };
  const descriptions={
    'full-name':/\bfull.?name\b|\byour.?name\b/i,
    'given-name':/\bfirst.?name\b|\bgiven.?name\b/i,
    'family-name':/\blast.?name\b|\bsurname\b|\bfamily.?name\b/i,
    'middle-name':/\bmiddle.?name\b/i,
    'nickname':/\bnick.?name\b/i,
    'email':/\bemail\b|\be-mail\b/i,
    'phone':/\bphone\b|\bmobile\b|\btelephone\b/i,
    'company':/\bcompany\b|\borganization\b/i,
    'job-title':/\bjob.?title\b|\boccupation\b/i,
    'street-address':/\bstreet.?address\b|\bfull.?address\b/i,
    'address-line1':/\baddress.?1\b|\baddress.?line.?1\b/i,
    'address-line2':/\baddress.?2\b|\baddress.?line.?2\b|\bapt\b|\bsuite\b/i,
    'city':/\bcity\b|\btown\b/i,'region':/\bstate\b|\bprovince\b|\bregion\b/i,
    'postal-code':/\bzip\b|\bpostal\b/i,'country':/\bcountry\b/i,
    'date-of-birth':/\bdate.?of.?birth\b|\bdob\b/i,
    'national-id':/\bnational.?id\b|\bidentity.?number\b/i,
    'passport-number':/\bpassport\b.{0,20}\b(number|no|id)\b|\bpassport.?no\b/i,
    'passport-country':/\bpassport.?country\b|\bissuing.?country\b/i,
    'passport-expiry':/\bpassport\b.{0,20}\b(expir|valid)\b/i,
    'drivers-license':/\bdriver.s?.?licen[cs]e\b.{0,20}\b(number|no|id)\b/i,
    'drivers-license-state':/\bdriver.s?.?licen[cs]e\b.{0,20}\b(state|region)\b/i,
    'vehicle-make':/\bvehicle.?make\b|\bcar.?make\b/i,
    'vehicle-model':/\bvehicle.?model\b|\bcar.?model\b/i,
    'vehicle-year':/\bmodel.?year\b|\bvehicle.?year\b/i,
    'vehicle-color':/\bvehicle.?colou?r\b/i,
    'license-plate':/\blicen[cs]e.?plate\b|\bplate.?number\b/i,
    'vin':/\bvin\b|\bvehicle.?identification.?number\b/i,
    'tax-id':/\btax.?id\b|\btaxpayer.?number\b/i,
    'website':/\bweb.?site\b|\burl\b/i
  };
  const put=(el,v)=>{
    if(!el||el.value||typeof v!=='string'||!v)return false;
    if(el.tagName==='SELECT'){
      const option=[...el.options].find(o=>o.value.toLowerCase()===v.toLowerCase()||
        o.text.toLowerCase()===v.toLowerCase());
      if(!option)return false;
      el.value=option.value;
    }else{
      const setter=Object.getOwnPropertyDescriptor(
        el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value')?.set;
      if(setter)setter.call(el,v);else el.value=v;
    }
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  };
  for(const [key,value] of Object.entries(profile.fields)){
    if(!descriptions[key]&&!rules[key])continue;
    // Explicit HTML autocomplete semantics outrank vague labels.
    const automatic=rules[key]&&all.find(el=>auto(el).some(token=>rules[key].test(token)));
    const named=all.find(el=>descriptions[key]?.test(tag(el)));
    const element=automatic||named;
    if(element&&put(element,value))all.splice(all.indexOf(element),1);
  }
})()"#;

// Low-cost, read-only inspection of the currently focused website form field.
// The browser chrome receives only semantic type, position and booleans; never
// passwords, PANs, IDs or typed identity values.
const FORM_FIELD_CONTEXT_JS:&str=r#"(function(){
  'use strict';
  if(window!==window.top||!document.hasFocus())return null;
  const field=document.activeElement;
  if(!field||!['INPUT','TEXTAREA','SELECT'].includes(field.tagName)||
      field.disabled||field.readOnly||['hidden','file'].includes(field.type))return null;
  const r=field.getBoundingClientRect();
  if(r.width<16||r.height<10)return null;
  const auto=(field.autocomplete||'').toLowerCase().split(/\s+/);
  const desc=[
    field.name||'',field.id||'',field.placeholder||'',
    field.getAttribute('aria-label')||'',field.labels?.[0]?.textContent||'',
    field.closest('label')?.textContent||''
  ].join(' ').toLowerCase();
  const hasPassword=[...document.querySelectorAll('input[type="password"]')]
    .filter(e=>!e.disabled&&e.getBoundingClientRect().width>0);
  const loginUser=document.querySelector('input[autocomplete="username"],input[type="email"],input[name*="user" i],input[id*="user" i]');
  const login=hasPassword.length===1 &&
    (field.type==='password'||auto.includes('username')||
      (loginUser===field));
  let kind='',key='';
  if(login){kind='login';key='login';}
  else if(auto.some(x=>x.startsWith('cc-'))||/credit.?card|card.?number|cc.?number|expir/i.test(desc)){
    kind='payment';key='payment';
  }else{
    const pairs=[
      ['passport-number',/passport.{0,25}(number|no|id)/],
      ['passport-country',/passport.{0,25}country|issuing.?country/],
      ['passport-expiry',/passport.{0,25}(expir|valid)/],
      ['drivers-license',/driver.s?.?licen[cs]e.{0,25}(number|no|id)/],
      ['drivers-license-state',/driver.s?.?licen[cs]e.{0,25}(state|region)/],
      ['national-id',/national.?id|identity.?number/],
      ['tax-id',/tax.?id|taxpayer.?number/],
      ['vehicle-make',/vehicle.?make|car.?make/],
      ['vehicle-model',/vehicle.?model|car.?model/],
      ['vehicle-year',/vehicle.?year|model.?year/],
      ['vehicle-color',/vehicle.?colou?r/],
      ['license-plate',/licen[cs]e.?plate|plate.?number/],
      ['vin',/\bvin\b|vehicle.?identification.?number/],
      ['given-name',/first.?name|given.?name/],
      ['family-name',/last.?name|surname|family.?name/],
      ['middle-name',/middle.?name/],
      ['full-name',/full.?name|your.?name/],
      ['street-address',/street.?address|full.?address/],
      ['address-line1',/address.?1|address.?line.?1/],
      ['address-line2',/address.?2|address.?line.?2|apartment|suite/],
      ['city',/\bcity\b|\btown\b/],
      ['region',/state|province|region/],
      ['postal-code',/zip|postal/],
      ['country',/\bcountry\b/],
      ['date-of-birth',/date.?of.?birth|\bdob\b/],
      ['email',/email|e-mail/],
      ['phone',/phone|mobile|telephone/],
      ['company',/company|organization/],
      ['job-title',/job.?title|occupation/],
      ['website',/web.?site|\burl\b/]
    ];
    const tokens={
      name:'full-name','given-name':'given-name','family-name':'family-name',
      'additional-name':'middle-name','nickname':'nickname',email:'email',
      tel:'phone','tel-national':'phone',organization:'company',
      'organization-title':'job-title','street-address':'street-address',
      'address-line1':'address-line1','address-line2':'address-line2',
      'address-level2':'city','address-level1':'region','postal-code':'postal-code',
      country:'country','country-name':'country',bday:'date-of-birth',url:'website'
    };
    key=auto.map(x=>tokens[x]).find(Boolean)||pairs.find(p=>p[1].test(desc))?.[0]||'';
    if(key)kind='identity';
  }
  if(!kind)return null;
  const entered=Boolean(field.value);
  const loginReady=kind==='login'&&hasPassword.length===1&&
    Boolean(hasPassword[0].value)&&(!loginUser||Boolean(loginUser.value));
  const fieldIndex=[...document.querySelectorAll('input,textarea,select')].indexOf(field);
  return {kind,key,fieldIndex,hasValue:entered,saveReady:loginReady,
    x:Math.round(r.left),y:Math.round(r.bottom),width:Math.round(r.width),
    height:Math.round(r.height)};
})()"#;

const CAPTURE_LOGIN_JS:&str=r#"(function(){
  'use strict';
  if(window!==window.top)return null;
  const pw=[...document.querySelectorAll('input[type="password"]')]
    .filter(e=>!e.disabled&&e.getBoundingClientRect().width>0);
  if(pw.length!==1||!pw[0].value||pw[0].value.length>4096)return null;
  const form=pw[0].form||document;
  const inputs=[...form.querySelectorAll('input')].filter(e=>!e.disabled);
  const username=inputs.find(e=>e.autocomplete==='username')||
    inputs.find(e=>e.type==='email')||
    inputs.find(e=>/user|email|login/i.test(e.name+' '+e.id)&&e.type!=='password');
  if(username&&username.value.length>320)return null;
  return {username:username?.value||'',password:pw[0].value};
})()"#;

const CAPTURE_IDENTITY_JS:&str=r#"(function(){
  'use strict';
  if(window!==window.top)return null;
  const index=__IDENTITY_FIELD_INDEX__;
  const all=[...document.querySelectorAll('input,textarea,select')];
  const el=all[index]||document.activeElement;
  if(!el||!['INPUT','TEXTAREA','SELECT'].includes(el.tagName)||
     el.type==='password'||el.type==='hidden'||el.disabled||el.readOnly||
     !el.value||el.value.length>400)return null;
  return {value:el.value};
})()"#;

fn browser_page_eval(app:&tauri::AppHandle,script:&str)->Result<(String,Value),String>{
    let (label,tab_url,private)={
        let browser=app.state::<Mutex<Browser>>();
        let b=browser.lock().map_err(|e|e.to_string())?;
        let tab=b.active().ok_or("No active tab")?;
        (tab.view.clone().ok_or("No active webpage")?,tab.url.clone(),tab.private)
    };
    if private{return Err("Form assistance is disabled in private and Secret Tabs".into());}
    let origin=password_vault::origin(&tab_url)?;
    let view=app.get_webview(&label).ok_or("No active webpage")?;
    let actual=view.url().map_err(|e|e.to_string())?;
    if password_vault::origin(actual.as_str())?!=origin{
        return Err("Website navigation changed".into());
    }
    let (sender,receiver)=std::sync::mpsc::sync_channel(1);
    view.eval_with_callback(script,move |answer|{let _=sender.send(answer.to_string());})
        .map_err(|e|e.to_string())?;
    let mut reply=receiver.recv_timeout(Duration::from_millis(850))
        .map_err(|_|"Form inspection was unavailable".to_string())?;
    let parsed=serde_json::from_str::<Value>(&reply)
        .map_err(|_|"Invalid form inspection response".to_string())?;
    reply.zeroize();
    // The WebView2 callback may return JSON text or an already serialized
    // object. Neither representation can initiate native commands.
    let parsed=if let Some(inner)=parsed.as_str(){
        serde_json::from_str::<Value>(inner).unwrap_or(Value::Null)
    }else{parsed};
    Ok((origin,parsed))
}

fn fill_identity(app:&tauri::AppHandle,id:&str)->Result<bool,String>{
    let (label,url,private)={
        let browser=app.state::<Mutex<Browser>>();
        let browser=browser.lock().map_err(|e|e.to_string())?;
        let tab=browser.active().ok_or("No active tab")?;
        (tab.view.clone().ok_or("No active webpage")?,tab.url.clone(),tab.private)
    };
    if private{return Err("Identities cannot autofill private or Secret Tabs".into());}
    let origin=password_vault::origin(&url)?;
    let view=app.get_webview(&label).ok_or("No active webpage")?;
    let actual=view.url().map_err(|e|e.to_string())?;
    if password_vault::origin(actual.as_str())?!=origin{
        return Err("Website changed; choose the identity again".into());
    }
    let identity={
        let state=app.state::<Mutex<password_vault::Vault>>();
        let vault=state.lock().map_err(|e|e.to_string())?;
        vault.identity(id).ok_or("Unlock the vault and choose an identity")?
    };
    let payload=json!({"origin":origin,"fields":identity.fields.clone()}).to_string();
    // A script cannot be evaluated for a different origin, even if the page
    // navigates between the click and the browser's native evaluate call.
    view.eval(&IDENTITY_FILL_JS.replace("__MINTERNET_IDENTITY_PAYLOAD__",&payload))
        .map_err(|e|e.to_string())?;
    Ok(true)
}

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
        if tab.url != HOME || tab.view.is_some() || tab.secret_id.is_some() || b.warming.contains(&tab.id) {
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
        tab.pending_previous_url=if url.is_some()&&tab.url!=str_url &&
            tab.url!=HOME {Some(tab.url.clone())}else{None};
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

// The website is a separate native WebView: DOM.focus alone cannot reclaim
// keyboard focus from that child on Windows. Focus the chrome controller first.
fn focus_address_bar(app:&tauri::AppHandle) {
    if let Some(chrome)=app.get_webview("chrome"){
        let _=chrome.set_focus();
        let _=chrome.eval(r#"(() => {
            const field=document.getElementById('address');
            if(!field)return;
            const previouslyTyped=field.dataset.minternetTyped==='true';
            field.focus({preventScroll:true});
            if(!previouslyTyped)field.select();
        })()"#);
    }
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

// Google sessions can hold live, transient authentication state in a WebView2
// controller. Closing the controller shortly after a tab goes idle is not a
// real logout, but can force a new Google challenge when the tab is selected.
// Preserve such controllers until the user closes the tab or browser.
fn google_session_page(url:&str)->bool{
    let Ok(address)=tauri::Url::parse(url) else{return false};
    if !matches!(address.scheme(),"https"|"http"){return false;}
    let Some(host)=address.host_str() else{return false};
    let host=host.to_ascii_lowercase();
    ["google.com","youtube.com","youtu.be","gmail.com","googleusercontent.com"]
        .iter().any(|domain|host==*domain||host.ends_with(&format!(".{domain}")))
}

#[cfg(test)]
mod google_session_page_tests{
    use super::google_session_page;
    #[test]
    fn exact_google_hosts_only(){
        for url in ["https://accounts.google.com/","https://mail.google.com/mail/",
            "https://www.youtube.com/watch?v=test","https://youtu.be/a","https://gmail.com"]{
            assert!(google_session_page(url),"{url}");
        }
        for url in ["https://notgoogle.com/","https://google.com.example.org/",
            "https://evil.org/?next=google.com","about:blank","https://youtube.com.evil.com/"]{
            assert!(!google_session_page(url),"{url}");
        }
    }
}

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
                tab.loading || tab.audio_playing || tab.checking_unload || tab.url==HOME ||
                google_session_page(&tab.url) {
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
            // Preserve the route before taking the WebView from its tab.
            if eligible {
                if let Some(view)=handle.get_webview(&captured){
                    if let Ok(location)=view.url(){
                        if is_real_page_url(location.as_str()){
                            update_from_site(&handle,id,location.as_str());
                        }
                    }
                }
            }
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
                            !google_session_page(&tab.url) &&
                            Instant::now().duration_since(since)>=idle {
                            tab.loading=false;tab.audio_playing=false;tab.audio_muted=false;
                            if tab.secret_id.is_some(){tab.secret_revealed=false;}
                            tab.view.take()
                        }else{None}
                    }else{None}
                }else{None};
                result
            };
            if let Some(label)=released {
                // Never close the very WebView2 controller from inside its
                // ExecuteScript completion callback: defer teardown to a
                // later UI-loop turn to avoid COM reentrancy/use-after-close.
                let closer=handle.clone();
                std::thread::spawn(move||{
                    std::thread::sleep(Duration::from_millis(40));
                    let task=closer.clone();
                    let _=closer.run_on_main_thread(move||{
                        if let Some(view)=task.get_webview(&label){let _=view.close();}
                        notify(&task);
                    });
                });
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

// Open the Windows native picker before showing a media window. Serve only
// the user-selected file over Tauri's range-capable local asset protocol.
fn local_media_mime(path:&std::path::Path)->&'static str {
    match path.extension().and_then(|s|s.to_str()).unwrap_or("")
        .to_ascii_lowercase().as_str(){
        "mp3"=>"audio/mpeg","wav"=>"audio/wav","flac"=>"audio/flac",
        "m4a"|"aac"=>"audio/mp4","ogg"|"oga"=>"audio/ogg",
        "opus"=>"audio/opus","aif"|"aiff"=>"audio/aiff",
        "wma"=>"audio/x-ms-wma","mid"|"midi"=>"audio/midi",
        "mp4"|"m4v"=>"video/mp4","webm"=>"video/webm",
        "mov"=>"video/quicktime","mkv"=>"video/x-matroska",
        "avi"=>"video/x-msvideo","wmv"=>"video/x-ms-wmv",
        "mpg"|"mpeg"=>"video/mpeg","3gp"=>"video/3gpp",
        "ts"|"m2ts"=>"video/mp2t",
        _=>"application/octet-stream",
    }
}
fn open_local_media(app:&tauri::AppHandle,selected:&std::path::Path,smoke:bool)
    ->Result<Value,String>{
    let path=std::fs::canonicalize(selected)
        .map_err(|e|format!("Unable to open selected media file: {e}"))?;
    if !std::fs::metadata(&path).map_err(|e|e.to_string())?.is_file(){
        return Err("Select a file, not a directory".into());
    }
    // Scope starts empty and is expanded only for paths the user picked.
    // Media streams from disk with byte ranges; no multi-GB JS Blob copy.
    app.state::<tauri::scope::Scopes>().allow_file(&path).map_err(|e|e.to_string())?;
    let player=if let Some(existing)=app.get_webview_window("minternet-media-player"){
        existing
    }else{
        WebviewWindowBuilder::new(
                app,"minternet-media-player",
                WebviewUrl::App("media-player.html".into()))
            .title("Minternet Local Media Player")
            .inner_size(368.0,116.0)
            .min_inner_size(80.0,45.0)
            .resizable(true)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .build().map_err(|e|format!("Unable to open floating media player: {e}"))?
    };
    let url=player.convert_file_src(&path,None).map_err(|e|e.to_string())?;
    let name=path.file_name().map(|s|s.to_string_lossy().to_string())
        .unwrap_or_else(||"Local Media".into());
    let selected=json!({"url":url,"name":name,"mime":local_media_mime(&path),"smoke":smoke});
    *app.state::<LocalMediaSelection>().0.lock()
        .map_err(|e|e.to_string())?=Some(selected.clone());
    let _=app.emit_to("minternet-media-player","minternet:media-selected",selected);
    player.show().map_err(|e|e.to_string())?;
    let _=player.set_focus();
    Ok(json!({"ok":true,"cancelled":false,"name":name}))
}
#[cfg(test)]
mod local_media_tests{
    use super::*;
    #[test]
    fn mime_classification(){
        assert_eq!(local_media_mime(std::path::Path::new("track.MP3")),"audio/mpeg");
        assert_eq!(local_media_mime(std::path::Path::new("clip.mp4")),"video/mp4");
        assert_eq!(local_media_mime(std::path::Path::new("sample.wav")),"audio/wav");
    }
}

#[tauri::command]
fn browser_snapshot(app: tauri::AppHandle) -> Result<Snapshot,String> { snapshot(&app) }

#[tauri::command]
async fn browser_action(app: tauri::AppHandle, name: String, value: Value) -> Result<Value, String> {
    // OAuth, Drive and Gmail are only available to the trusted local chrome.
    // All remote network calls run on worker threads so they never pause the
    // native browser event loop. No Google token is returned to web content.
    if name=="media-player-current" {
        let current=app.state::<LocalMediaSelection>().0.lock()
            .map_err(|e|e.to_string())?.clone();
        return Ok(current.unwrap_or(Value::Null));
    }
    if name=="media-player-pick" {
        // This is the OS dialog, parented to the Minternet main window.
        // It is independent of the WebView's invisible HTML file chooser.
        let picked=tauri::async_runtime::spawn_blocking({
            let handle=app.clone();
            move || {
                let picker=handle.dialog().file().set_title("Open Audio or Video File");
                if let Some(main)=handle.get_window("main"){
                    picker.set_parent(&main).blocking_pick_file()
                }else{
                    picker.blocking_pick_file()
                }
            }
        }).await.map_err(|e|format!("Windows file picker unavailable: {e}"))?;
        let Some(selection)=picked else{
            return Ok(json!({"ok":true,"cancelled":true}));
        };
        let path=selection.into_path()
            .map_err(|e|format!("Only a local file can be selected: {e}"))?;
        return open_local_media(&app,&path,false);
    }
    if name=="media-player-smoke-open" {
        if !std::env::args().any(|a|a=="--minternet-media-smoke"){
            return Err("Media test mode is disabled".into());
        }
        let samples=vec![128u8;4000];
        let mut wav=Vec::with_capacity(44+samples.len());
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36u32+samples.len() as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&8000u32.to_le_bytes());
        wav.extend_from_slice(&8000u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&8u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(samples.len() as u32).to_le_bytes());
        wav.extend_from_slice(&samples);
        let path=std::env::temp_dir().join(format!("minternet-smoke-media-{}.wav",std::process::id()));
        std::fs::write(&path,wav).map_err(|e|e.to_string())?;
        return open_local_media(&app,&path,true);
    }
    if name=="media-player-smoke-proof" {
        if !std::env::args().any(|a|a=="--minternet-media-smoke"){
            return Err("Media test mode is disabled".into());
        }
        let duration=value.get("duration").and_then(Value::as_f64).unwrap_or(0.);
        let smoke_selected=app.state::<LocalMediaSelection>().0.lock()
            .ok().and_then(|v|v.as_ref().and_then(|v|v.get("smoke")).and_then(Value::as_bool));
        if duration<0.4 || smoke_selected!=Some(true){
            return Err("The selected local WAV was not decoded".into());
        }
        let marker=std::env::temp_dir().join(format!("minternet-media-{}.ok",std::process::id()));
        std::fs::write(&marker,format!("Native local media player loaded WAV {duration:.3}s"))
            .map_err(|e|e.to_string())?;
        return Ok(json!({"ok":true}));
    }
    if name=="volume-get" {
        let state=app.state::<VolumeState>();
        let config=state.0.lock().map_err(|e|e.to_string())?;
        return Ok(json!({"level":config.level,"muted":config.muted}));
    }
    if name=="volume-set" {
        let level=value.get("level").and_then(Value::as_u64)
            .filter(|v|*v<=300).ok_or("Volume must be 0–300%")? as u16;
        let muted=value.get("muted").and_then(Value::as_bool)
            .ok_or("Mute setting must be a boolean")?;
        let changed={
            let state=app.state::<VolumeState>();
            let mut config=state.0.lock().map_err(|e|e.to_string())?;
            let changed=config.level!=level||config.muted!=muted;
            config.level=level;config.muted=muted;changed
        };
        if changed {
            let active={
                let browser=app.state::<Mutex<Browser>>();
                let b=browser.lock().map_err(|e|e.to_string())?;
                b.tabs.iter().filter_map(|t|t.view.as_ref().map(|l|(t.id,l.clone())))
                    .collect::<Vec<_>>()
            };
            for (id,label) in active {apply_volume_to_site(&app,id,&label,false);}
            let _=app.emit_to("minternet-media-player","minternet:media-volume",
                json!({"level":level,"muted":muted}));
        }
        return Ok(json!({"ok":true,"level":level,"muted":muted}));
    }
    if name=="browser-form-context" {
        let handle=app.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            let (origin,mut field)=browser_page_eval(&handle,FORM_FIELD_CONTEXT_JS)?;
            if let Some(data)=field.as_object_mut(){
                data.insert("origin".into(),Value::String(origin));
                data.insert("top".into(),json!(chrome_top(&handle)));
                return Ok(Value::Object(data.clone()));
            }
            Ok(Value::Null)
        }).await.map_err(|e|e.to_string())?;
    }
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
        let mut code=value.get("code").and_then(Value::as_str)
            .ok_or("Enter the Secret Bookmarks code")?.to_owned();
        let create=value.get("create").and_then(Value::as_bool)==Some(true);
        let handle=app.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            let path=secret_bookmarks::file(&handle)?;
            let state=handle.state::<Mutex<secret_bookmarks::SecretVault>>();
            let result=state.lock().map_err(|e|e.to_string())?.open(&path,&code,create);
            code.zeroize(); // discard raw code immediately after Argon2id
            result
        }).await.map_err(|e|e.to_string())?;
    }
    if name=="secret-change-password"{
        let mut current=value.get("current").and_then(Value::as_str)
            .ok_or("Enter your current Secret Folder password")?.to_owned();
        let mut next=value.get("next").and_then(Value::as_str)
            .ok_or("Enter a new Secret Folder password")?.to_owned();
        let handle=app.clone();
        let result=tauri::async_runtime::spawn_blocking(move||{
            let path=secret_bookmarks::file(&handle)?;
            let vault=handle.state::<Mutex<secret_bookmarks::SecretVault>>();
            let result=vault.lock().map_err(|e|e.to_string())?
                .change_password(&path,&current,&next);
            current.zeroize();next.zeroize();
            result
        }).await.map_err(|e|e.to_string())?;
        if result.is_ok(){
            // Password rotation revokes every old secret browsing session,
            // including already-loaded sites and unused decryption tickets.
            let labels={
                let browser=app.state::<Mutex<Browser>>();
                let mut state=browser.lock().map_err(|e|e.to_string())?;
                let mut labels=Vec::new();
                for tab in &mut state.tabs{
                    if tab.secret_id.is_some(){
                        if let Some(label)=tab.view.take(){labels.push(label);}
                        scrub_secret_tab(tab);
                    }
                }
                labels
            };
            for label in labels{
                if let Some(view)=app.get_webview(&label){let _=view.close();}
            }
            app.state::<AuthorizedSecrets>().items.lock()
                .map_err(|e|e.to_string())?.clear();
            display_active(&app);
            notify(&app);
        }
        return result;
    }
    if name=="secret-reset"{
        // A forgotten password is not bypassed. Only complete deletion is
        // permitted, with two independent explicit confirmations.
        if value.get("phrase").and_then(Value::as_str)!=Some("DELETE SECRET BOOKMARKS") ||
            value.get("acknowledged").and_then(Value::as_bool)!=Some(true) ||
            value.get("confirm").and_then(Value::as_str)!=Some("PERMANENTLY DELETE") {
            return Err("Full destructive-reset confirmation is required".into());
        }
        let labels={
            let state=app.state::<Mutex<Browser>>();
            let mut b=state.lock().map_err(|e|e.to_string())?;
            let mut labels=Vec::new();
            for tab in &mut b.tabs {
                if tab.secret_id.is_some(){
                    if let Some(view)=tab.view.take(){labels.push(view);}
                    scrub_secret_tab(tab);
                }
            }
            b.tabs.retain(|tab|tab.secret_id.is_none());
            if !b.tabs.iter().any(|tab|tab.id==b.active_id){
                b.active_id=b.tabs.iter().find(|tab|tab.pinned)
                    .or_else(||b.tabs.first()).map(|tab|tab.id).unwrap_or(0);
            }
            b.last_notified=None;
            labels
        };
        for label in labels{
            if let Some(view)=app.get_webview(&label){let _=view.close();}
        }
        // Remove secret authorization tickets and any historical UI snapshots
        // that might retain a copy of a previously revealed secret URL.
        app.state::<AuthorizedSecrets>().items.lock()
            .map_err(|e|e.to_string())?.clear();
        app.state::<UndoHistory>().0.lock()
            .map_err(|e|e.to_string())?.clear();
        let handle=app.clone();
        let result=tauri::async_runtime::spawn_blocking(move||{
            let path=secret_bookmarks::file(&handle)?;
            let vault=handle.state::<Mutex<secret_bookmarks::SecretVault>>();
            let result=vault.lock().map_err(|e|e.to_string())?
                .reset_without_password(&path);
            result
        }).await.map_err(|e|e.to_string())?;
        display_active(&app);
        notify(&app);
        return result;
    }
    if name=="secret-lock"{
        // Locking must also conceal already-open secrets, not just erase the
        // encryption key. Keep only opaque secret IDs for a later unlock.
        let labels={
            let store=app.state::<Mutex<Browser>>();
            let mut b=store.lock().map_err(|e|e.to_string())?;
            let mut labels=Vec::new();
            for tab in b.tabs.iter_mut().filter(|tab|tab.secret_id.is_some()){
                if let Some(label)=tab.view.take(){labels.push(label);}
                scrub_secret_tab(tab);
            }
            labels
        };
        for label in labels{
            if let Some(view)=app.get_webview(&label){let _=view.close();}
        }
        let vault=app.state::<Mutex<secret_bookmarks::SecretVault>>();
        vault.lock().map_err(|e|e.to_string())?.lock();
        // Destroy all per-site decryption keys as well as the folder key.
        app.state::<AuthorizedSecrets>().items.lock().map_err(|e|e.to_string())?.clear();
        display_active(&app);
        notify(&app);
        return Ok(json!({"ok":true}));
    }
    if matches!(name.as_str(),"secret-put"|"secret-delete"|"secret-edit"|"secret-move"){
        let path=secret_bookmarks::file(&app)?;
        let vault=app.state::<Mutex<secret_bookmarks::SecretVault>>();
        let mut secret=vault.lock().map_err(|e|e.to_string())?;
        let result=match name.as_str(){
            "secret-put" => secret.put(
                &path,
                value.get("kind").and_then(Value::as_str).ok_or("Missing bookmark kind")?,
                value.get("parent").and_then(Value::as_str),
                value.get("visibleName").and_then(Value::as_str).unwrap_or(""),
                value.get("url").and_then(Value::as_str),
                value.get("title").and_then(Value::as_str),
                value.get("bindVisibleName").and_then(Value::as_bool).unwrap_or(true)
            ),
            "secret-delete" => secret.delete(&path,
                value.get("id").and_then(Value::as_str).ok_or("Missing bookmark ID")?),
            "secret-edit" => secret.edit(&path,
                value.get("id").and_then(Value::as_str).ok_or("Missing bookmark ID")?,
                value.get("visibleName").and_then(Value::as_str).unwrap_or(""),
                value.get("bindVisibleName").and_then(Value::as_bool).unwrap_or(true)),
            "secret-move" => secret.move_inside(&path,
                value.get("id").and_then(Value::as_str).ok_or("Missing bookmark ID")?,
                value.get("parent").and_then(Value::as_str)),
            _ => unreachable!()
        };
        drop(secret);
        if result.is_ok() && matches!(name.as_str(),"secret-edit"|"secret-delete"){
            app.state::<AuthorizedSecrets>().items.lock()
                .map_err(|e|e.to_string())?.clear();
        }
        return result;
    }
    if name=="secret-preview"{
        let title=value.get("title").and_then(Value::as_str).unwrap_or("");
        let url=value.get("url").and_then(Value::as_str).unwrap_or("");
        let state=app.state::<Mutex<secret_bookmarks::SecretVault>>();
        let vault=state.lock().map_err(|e|e.to_string())?;
        let visible_name=value.get("visibleName").and_then(Value::as_str).unwrap_or("");
        let bind=value.get("bindVisibleName").and_then(Value::as_bool).unwrap_or(true);
        return vault.preview(title,url,visible_name,bind);
    }
    if name=="secret-migrate" {
        let mut code=value.get("code").and_then(Value::as_str)
            .ok_or("Enter the former bookmark code to migrate older entries")?.to_owned();
        let handle=app.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            let path=secret_bookmarks::file(&handle)?;
            let state=handle.state::<Mutex<secret_bookmarks::SecretVault>>();
            let result=state.lock().map_err(|e|e.to_string())?.migrate(&path,&code);
            code.zeroize();
            result
        }).await.map_err(|e|e.to_string())?;
    }
    if name=="secret-open"{
        let items=value.get("ids").and_then(Value::as_array)
            .ok_or("Select Secret Bookmarks")?;
        if items.is_empty(){return Err("Select at least one bookmark".into());}
        let ids=items.iter().map(|x|x.as_str()
            .map(str::to_owned).ok_or_else(||"Invalid Secret Bookmark ID".to_string()))
            .collect::<Result<Vec<_>,_>>()?;
        {
            let store=app.state::<Mutex<Browser>>();
            if !{let b=store.lock().map_err(|e|e.to_string())?;
                has_tab_capacity(b.tabs.len(),ids.len(),b.tab_limit)}{
                return Err("Not enough available tabs".into());
            }
        }
        // Keys are derived from the unlocked folder key and optional name.
        // Authenticate the entire batch before creating tabs; no URL leaves Rust.
        let handle=app.clone();
        let keys=tauri::async_runtime::spawn_blocking(move||{
            let vault=handle.state::<Mutex<secret_bookmarks::SecretVault>>();
            let result=vault.lock().map_err(|e|e.to_string())?.authorize(&ids);
            result.map(|keys|(ids,keys))
        }).await.map_err(|e|e.to_string())??;
        let (ids,mut keys)=keys;
        let browser=app.state::<Mutex<Browser>>();
        let mut b=browser.lock().map_err(|e|e.to_string())?;
        let selected=b.active_id;
        if !has_tab_capacity(b.tabs.len(),ids.len(),b.tab_limit){
            for key in &mut keys{key.zeroize();}
            return Err("Not enough available tabs".into());
        }
        let mut created=Vec::with_capacity(ids.len());
        let mut authorized=Vec::with_capacity(ids.len());
        for (entry_id,mut key) in ids.into_iter().zip(keys.into_iter()){
            let tab_id=b.add(true)?;
            let tab=b.tabs.iter_mut().find(|t|t.id==tab_id).ok_or("Tab missing")?;
            tab.secret_id=Some(entry_id.clone());
            tab.secret_revealed=false;
            tab.title="Secret Tab".into();
            tab.url=HOME.into();
            tab.view=None;
            created.push(tab_id);
            authorized.push((tab_id,AuthorizedSecret{
                id:entry_id,key:std::mem::replace(&mut key,[0u8;32]),
                expires:Instant::now()+Duration::from_secs(300)
            }));
            key.zeroize();
        }
        b.active_id=selected;
        drop(b);
        app.state::<AuthorizedSecrets>().items.lock().map_err(|e|e.to_string())?
            .extend(authorized);
        schedule_secret_access_expiry(&app);
        notify(&app);
        return Ok(json!({"tabIds":created,"authorizationSeconds":300}));
    }
    if name=="secret-authorize-tab"{
        let tab_id=value.get("tabId").and_then(Value::as_u64)
            .ok_or("Missing Secret Tab ID")? as u32;
        let entry_id={
            let browser=app.state::<Mutex<Browser>>();
            let state=browser.lock().map_err(|e|e.to_string())?;
            let tab=state.tabs.iter().find(|t|t.id==tab_id).ok_or("Tab missing")?;
            if tab.secret_revealed{return Err("Secret Tab is already revealed".into());}
            tab.secret_id.clone().ok_or("Not a Secret Tab")?
        };
        let handle=app.clone();
        let (entry_id,mut key)=tauri::async_runtime::spawn_blocking(move||{
            let state=handle.state::<Mutex<secret_bookmarks::SecretVault>>();
            let result=state.lock().map_err(|e|e.to_string())?
                .authorize(&[entry_id.clone()]);
            let mut keys=result?;
            Ok::<_,String>((entry_id,keys.remove(0)))
        }).await.map_err(|e|e.to_string())??;
        let entry_unchanged={
            let browser=app.state::<Mutex<Browser>>();
            let state=browser.lock().map_err(|e|e.to_string())?;
            state.tabs.iter().any(|t|t.id==tab_id&&t.secret_id.as_deref()==Some(entry_id.as_str())
                &&!t.secret_revealed)
        };
        if !entry_unchanged{key.zeroize();return Err("Secret Tab changed or closed".into());}
        app.state::<AuthorizedSecrets>().items.lock().map_err(|e|e.to_string())?
            .insert(tab_id,AuthorizedSecret{
                id:entry_id,key,expires:Instant::now()+Duration::from_secs(300)
            });
        schedule_secret_access_expiry(&app);
        return Ok(json!({"ok":true}));
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
        let authorization=app.state::<AuthorizedSecrets>().items.lock()
            .map_err(|e|e.to_string())?.remove(&id)
            .ok_or("Secret tab authorization expired; unlock the folder to reauthorize")?;
        if Instant::now()>authorization.expires||authorization.id!=secret_id{
            return Err("Secret tab authorization expired; unlock the folder to reauthorize".into());
        }
        let mut url={
            let state=app.state::<Mutex<secret_bookmarks::SecretVault>>();
            let result=state.lock().map_err(|e|e.to_string())?
                .link_with_key(&secret_id,&authorization.key)?;
            result
        };
        // The item-specific ticket is destroyed as soon as the URL is
        // authenticated and the eye is pressed.
        drop(authorization);
        let parsed=tauri::Url::parse(&url).map_err(|_|"Secret URL invalid")?;
        url.zeroize();
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
    if name=="shield-get"{
        let current=app.state::<privacy_shield::ShieldState>().0.lock()
            .map_err(|e|e.to_string())?.clone();
        return Ok(serde_json::to_value(current).map_err(|e|e.to_string())?);
    }
    if name=="shield-set"{
        let next=privacy_shield::parse_config(&value)?;
        privacy_shield::save(&app,&next)?;
        *app.state::<privacy_shield::ShieldState>().0.lock()
            .map_err(|e|e.to_string())?=next.clone();
        // Apply immediately to existing pages. New WebViews receive it at
        // document start, without granting remote sites access to native APIs.
        let injection=privacy_shield::script(&next);
        let labels=app.state::<Mutex<Browser>>().lock()
            .map_err(|e|e.to_string())?.tabs.iter()
            .filter_map(|t|t.view.clone()).collect::<Vec<_>>();
        for label in labels {if let Some(view)=app.get_webview(&label){let _=view.eval(&injection);}}
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
            google_account::login(&handle,&handle.state::<Mutex<google_account::GoogleState>>(),&client,mail))
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
        if !matches!(kind,"login"|"payment"|"identity") {return Err("Not a vault record".into());}
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
            }else if !deleted && has_tab_capacity(b.tabs.len(),1,b.tab_limit) {
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
                if !has_tab_capacity(b.tabs.len(),1,b.tab_limit){break;}
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
    if name=="bookmark-icon-data" {
        let url=value.as_str().ok_or("Expected HTTPS favicon URL")?;
        if url.len()>4096{return Err("Favicon URL too long".into());}
        let target=url.to_owned();
        let result=tauri::async_runtime::spawn_blocking(move||
            fetch_bookmark_icon_data(&target))
            .await.map_err(|e|e.to_string())??;
        return Ok(json!(result));
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
        "browser-preferences" => {
            let state=app.state::<BrowserPreferenceState>();
            let prefs=state.0.lock().map_err(|e|e.to_string())?;
            let selected=prefs.homepage.clone();
            let new_tab_mode=prefs.new_tab_mode.clone();
            let tab_limit=prefs.tab_limit;
            let system=prefs.download_folder.is_none();
            drop(prefs);
            let destination=configured_download_folder(&app)?;
            return Ok(json!({
                "homepage":selected,
                "newTabMode":new_tab_mode,
                "tabLimit":tab_limit,
                "downloadFolder":destination.to_string_lossy(),
                "usingSystemDownloads":system
            }));
        }
        "tab-limit-set" => {
            let requested=value.as_u64().ok_or("Tab Limit must be a nonnegative whole number")?;
            if requested>1_000_000{return Err("Enter a Tab Limit from 0 to 1000000".into());}
            let selected=requested as usize;
            let state=app.state::<BrowserPreferenceState>();
            let mut prefs=state.0.lock().map_err(|e|e.to_string())?;
            let mut updated=prefs.clone();
            updated.tab_limit=selected;
            persist_preferences(&app,&updated)?;
            *prefs=updated;
            drop(prefs);
            app.state::<Mutex<Browser>>().lock().map_err(|e|e.to_string())?.tab_limit=selected;
            return Ok(json!({"ok":true,"tabLimit":selected}));
        }
        "browser-new-tab-mode-set" => {
            let mode=value.as_str().ok_or("Select Dashboard or Website")?;
            if !valid_new_tab_mode(mode){return Err("Unknown New Tab mode".into());}
            let state=app.state::<BrowserPreferenceState>();
            let mut settings=state.0.lock().map_err(|e|e.to_string())?;
            let mut updated=settings.clone();
            updated.new_tab_mode=mode.into();
            persist_preferences(&app,&updated)?;
            *settings=updated;
            return Ok(json!({"ok":true,"newTabMode":mode}));
        }
        "browser-homepage-set" => {
            let submitted=value.as_str().ok_or("Enter a homepage URL")?.trim();
            let selected=validate_homepage(submitted)?;
            let state=app.state::<BrowserPreferenceState>();
            let mut prefs=state.0.lock().map_err(|e|e.to_string())?;
            let mut updated=prefs.clone();
            updated.homepage=selected.clone();
            persist_preferences(&app,&updated)?;
            *prefs=updated;
            return Ok(json!({"ok":true,"homepage":selected}));
        }
        "downloads-folder-set" => {
            let raw=value.as_str().ok_or("Enter an absolute Downloads folder path")?.trim();
            let chosen=if raw.is_empty(){
                None // Reset to the operating system's Downloads folder.
            }else{
                let requested=PathBuf::from(raw);
                if !requested.is_absolute(){
                    return Err("Downloads folder must be an absolute path".into());
                }
                if !requested.is_dir(){
                    return Err("Choose an existing folder for downloads".into());
                }
                let folder=std::fs::canonicalize(&requested)
                    .map_err(|e|format!("Downloads folder is unavailable: {e}"))?;
                if !folder.is_dir(){return Err("Downloads folder must be a directory".into());}
                // Persist the user's normal path. Canonicalization is used
                // only when checking that download records stay in a root.
                Some(requested.to_string_lossy().to_string())
            };
            let state=app.state::<BrowserPreferenceState>();
            let mut prefs=state.0.lock().map_err(|e|e.to_string())?;
            let mut updated=prefs.clone();
            if updated.download_folder!=chosen {
                if let Some(previous)=updated.download_folder.take(){
                    updated.previous_download_folders.retain(|folder|folder!=&previous);
                    updated.previous_download_folders.push(previous);
                    if updated.previous_download_folders.len()>8{
                        updated.previous_download_folders.remove(0);
                    }
                }
                updated.download_folder=chosen;
            }
            persist_preferences(&app,&updated)?;
            *prefs=updated;
            let system=prefs.download_folder.is_none();
            drop(prefs);
            // Already-downloaded files are still accessible from their
            // original known folders through Downloads history.
            let current=configured_download_folder(&app)?;
            return Ok(json!({"ok":true,"downloadFolder":current.to_string_lossy(),
                "usingSystemDownloads":system}));
        }
        "session-refresh-urls" => {
            let count=refresh_session_urls(&app);
            return Ok(json!({"ok":true,"updated":count}));
        }
        "downloads-list" => {
            let state=app.state::<DownloadsState>();
            let history=state.0.lock().map_err(|e|e.to_string())?;
            return Ok(json!(history.iter().rev().map(|d|{
                let received=if d.status=="downloading" {
                    std::fs::metadata(&d.path).ok().map(|m|m.len()).unwrap_or(0)
                }else if d.status=="completed"{
                    std::fs::metadata(&d.path).ok().map(|m|m.len()).unwrap_or(0)
                }else{0};
                json!({"id":d.id,"name":d.name,"status":d.status,
                       "private":d.private,"receivedBytes":received})
            }).collect::<Vec<_>>()));
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
            {
                // Uses Shell32 SHOpenFolderAndSelectItems (PIDL selection),
                // so Explorer highlights the exact completed file. Simple
                // explorer.exe /select arguments can silently open only the folder,
                // especially for extended-length paths or an existing Explorer.
                // showfile dispatches the native SHOpenFolderAndSelectItems API.
                // It returns (), and can block while Explorer starts; run on a
                // COM-compatible worker rather than the browser UI thread.
                tauri::async_runtime::spawn_blocking(move||{
                    showfile::show_path_in_file_manager(&path);
                }).await.map_err(|e|format!("Could not open Explorer: {e}"))?;
            }
            #[cfg(target_os="macos")]
            std::process::Command::new("open").arg("-R").arg(&path)
                .spawn().map_err(|e|e.to_string())?;
            #[cfg(target_os="linux")]
            std::process::Command::new("xdg-open").arg(path.parent().ok_or("No parent folder")?)
                .spawn().map_err(|e|e.to_string())?;
            return Ok(json!({"ok":true}));
        }
        "vault-import" => {
            // Only trusted browser chrome can call this command. A person must
            // select an export file and unlock the local encrypted vault first.
            // Import once into memory and encrypt once, not per CSV row.
            let kind=value.get("kind").and_then(Value::as_str)
                .ok_or("Import type required")?;
            if kind!="password"&&kind!="card"{
                return Err("Unsupported credential import type".into());
            }
            let records=value.get("entries").and_then(Value::as_array)
                .ok_or("Import records required")?;
            if records.is_empty()||records.len()>2000{
                return Err("Import supports 1–2,000 records per file".into());
            }
            let state=app.state::<Mutex<password_vault::Vault>>();
            let mut vault=state.lock().map_err(|e|e.to_string())?;
            if !vault.unlocked(){return Err("Unlock the encrypted vault before importing".into());}
            let mut imported=0usize;
            let mut skipped=0usize;
            if kind=="password" {
                let current=vault.list()?;
                let mut existing=HashSet::<String>::new();
                if let Some(saved)=current.as_array(){
                    for login in saved {
                        if let (Some(origin),Some(username))=(
                            login.get("origin").and_then(Value::as_str),
                            login.get("username").and_then(Value::as_str)){
                            existing.insert(format!("{origin}\u{0}{username}"));
                        }
                    }
                }
                for record in records {
                    let origin=record.get("origin").and_then(Value::as_str).unwrap_or("");
                    let username=record.get("username").and_then(Value::as_str).unwrap_or("");
                    let password=record.get("password").and_then(Value::as_str).unwrap_or("");
                    let Ok(origin)=password_vault::origin(origin) else{skipped+=1;continue};
                    if username.len()>320||password.is_empty()||password.len()>4096{
                        skipped+=1;continue;
                    }
                    let key=format!("{origin}\u{0}{username}");
                    if !existing.insert(key){skipped+=1;continue;}
                    if vault.put(origin,username.to_owned(),password.to_owned(),false).is_ok(){
                        imported+=1;
                    }else{skipped+=1;}
                }
            }else{
                let current=vault.list_cards()?;
                let mut existing=HashSet::<String>::new();
                if let Some(saved)=current.as_array(){
                    for card in saved {
                        let name=card.get("name").and_then(Value::as_str).unwrap_or("");
                        let last=card.get("last4").and_then(Value::as_str).unwrap_or("");
                        let month=card.get("month").and_then(Value::as_u64).unwrap_or(0);
                        let year=card.get("year").and_then(Value::as_u64).unwrap_or(0);
                        existing.insert(format!("{name}:{last}:{month}:{year}"));
                    }
                }
                for record in records {
                    let number=record.get("number").and_then(Value::as_str).unwrap_or("");
                    let name=record.get("name").and_then(Value::as_str).unwrap_or("");
                    let label=record.get("label").and_then(Value::as_str).unwrap_or("");
                    let postal=record.get("postal").and_then(Value::as_str).unwrap_or("");
                    let month=record.get("month").and_then(Value::as_u64).unwrap_or(0);
                    let year=record.get("year").and_then(Value::as_u64).unwrap_or(0);
                    let last=number.chars().rev().take(4).collect::<String>().chars().rev().collect::<String>();
                    let key=format!("{name}:{last}:{month}:{year}");
                    if existing.contains(&key) || month>u8::MAX as u64 || year>u16::MAX as u64{
                        skipped+=1;continue;
                    }
                    if vault.put_card(label.to_owned(),name.to_owned(),number.to_owned(),
                                      month as u8,year as u16,postal.to_owned()).is_ok(){
                        existing.insert(key);imported+=1;
                    }else{skipped+=1;}
                }
            }
            if imported>0 {
                vault.save(&password_vault::file(&app)?)?;
                let _=app.emit_to("chrome","minternet:vault-changed",());
            }
            return Ok(json!({"ok":true,"imported":imported,"skipped":skipped}));
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
            // A login page may already be open when the vault is unlocked.
            let active=app.state::<Mutex<Browser>>().lock().map_err(|e|e.to_string())?.active_id;
            let _=fill_saved_credential(&app,active,false,None);
            return Ok(json!({"ok":true}));
        }
        "vault-lock" => {
            app.state::<Mutex<password_vault::Vault>>().lock().map_err(|e|e.to_string())?.lock();
            return Ok(json!({"ok":true}));
        }
        "vault-capture-login" => {
            // Only the trusted chrome's explicit Save action executes this.
            // Password values never cross the chrome IPC or appear in a toast.
            let handle=app.clone();
            return tauri::async_runtime::spawn_blocking(move||{
                let (origin,mut value)=browser_page_eval(&handle,CAPTURE_LOGIN_JS)?;
                let username=value.get("username").and_then(Value::as_str)
                    .ok_or("No completed login form was found")?.to_owned();
                let mut password=value.get("password").and_then(Value::as_str)
                    .ok_or("No password was entered")?.to_owned();
                value=Value::Null;
                let state=handle.state::<Mutex<password_vault::Vault>>();
                let mut vault=state.lock().map_err(|e|e.to_string())?;
                let result=vault.put(origin,username,password.clone(),true)
                    .and_then(|_|vault.save(&password_vault::file(&handle)?));
                password.zeroize();
                result?;
                let _=handle.emit_to("chrome","minternet:vault-changed",());
                Ok(json!({"ok":true}))
            }).await.map_err(|e|e.to_string())?;
        }
        "vault-identity-capture" => {
            let identity_id=value.get("id").and_then(Value::as_str).map(str::to_owned);
            let key=value.get("key").and_then(Value::as_str)
                .ok_or("Field type required")?.to_owned();
            let index=value.get("index").and_then(Value::as_u64)
                .ok_or("Focused field identifier required")?;
            if index>500{return Err("Field index too large".into());}
            let handle=app.clone();
            return tauri::async_runtime::spawn_blocking(move||{
                let (_origin,field)=browser_page_eval(&handle,&CAPTURE_IDENTITY_JS.replace("__IDENTITY_FIELD_INDEX__",&index.to_string()))?;
                let value=field.get("value").and_then(Value::as_str)
                    .ok_or("No field value was found")?.to_owned();
                let state=handle.state::<Mutex<password_vault::Vault>>();
                let mut vault=state.lock().map_err(|e|e.to_string())?;
                let existing=identity_id.as_deref().and_then(|id|vault.identity(id));
                let mut fields=existing.as_ref()
                    .map(|item|item.fields.clone()).unwrap_or_default();
                fields.insert(key,value);
                let name=existing.as_ref().map(|item|item.label.clone())
                    .unwrap_or_else(||"New Identity".into());
                let id=vault.put_identity(identity_id.as_deref(),name,fields)?;
                vault.save(&password_vault::file(&handle)?)?;
                let _=handle.emit_to("chrome","minternet:vault-changed",());
                Ok(json!({"ok":true,"id":id}))
            }).await.map_err(|e|e.to_string())?;
        }
        "vault-card-list" => {
            let state=app.state::<Mutex<password_vault::Vault>>();
            return state.lock().map_err(|e|e.to_string())?.list_cards();
        }
        "vault-identity-list" => {
            let state=app.state::<Mutex<password_vault::Vault>>();
            return state.lock().map_err(|e|e.to_string())?.list_identities();
        }
        "vault-identity-get" => {
            let id=value.as_str().ok_or("Choose an identity")?;
            let state=app.state::<Mutex<password_vault::Vault>>();
            let vault=state.lock().map_err(|e|e.to_string())?;
            let identity=vault.identity(id).ok_or("Unlock the vault and choose an identity")?;
            return Ok(serde_json::to_value(identity).map_err(|e|e.to_string())?);
        }
        "vault-identity-put" => {
            let id=value.get("id").and_then(Value::as_str);
            let label=value.get("label").and_then(Value::as_str)
                .ok_or("Identity label required")?.to_owned();
            let fields=value.get("fields").and_then(Value::as_object)
                .ok_or("Identity fields required")?;
            let mut values=std::collections::BTreeMap::new();
            for (key,content) in fields {
                let text=content.as_str().ok_or("Identity field must be text")?;
                if !text.trim().is_empty(){values.insert(key.clone(),text.to_owned());}
            }
            let state=app.state::<Mutex<password_vault::Vault>>();
            let mut vault=state.lock().map_err(|e|e.to_string())?;
            let id=vault.put_identity(id,label,values)?;
            vault.save(&password_vault::file(&app)?)?;
            let _=app.emit_to("chrome","minternet:vault-changed",());
            return Ok(json!({"ok":true,"id":id}));
        }
        "vault-identity-remove" => {
            let id=value.as_str().ok_or("Choose an identity")?;
            let state=app.state::<Mutex<password_vault::Vault>>();
            let mut vault=state.lock().map_err(|e|e.to_string())?;
            vault.remove_identity(id)?;
            vault.save(&password_vault::file(&app)?)?;
            let _=app.emit_to("chrome","minternet:vault-changed",());
            return Ok(json!({"ok":true}));
        }
        "vault-identity-fill" => {
            let id=value.as_str().ok_or("Choose an identity")?;
            return Ok(json!({"filled":fill_identity(&app,id)?}));
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
            let active=app.state::<Mutex<Browser>>().lock()
                .map_err(|e|e.to_string())?.active_id;
            let _=fill_saved_credential(&app,active,false,None);
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
        "stability-smoke-proof" | "stability-smoke-failure" => {
            if !std::env::args().any(|a|a=="--minternet-stability-smoke"){
                return Err("Stability smoke is not enabled".into());
            }
            let suffix=if name=="stability-smoke-proof"{"ok"}else{"failed"};
            let path=std::env::temp_dir().join(format!(
                "minternet-stability-{}.{suffix}",std::process::id()));
            let report=if suffix=="ok"{
                let created=value.get("created").and_then(Value::as_u64).unwrap_or(0);
                let switched=value.get("switched").and_then(Value::as_u64).unwrap_or(0);
                if created<6||switched<18{return Err("Incomplete stress checks".into());}
                "Repeated native WebView2 tab creation, switching and closure succeeded".to_owned()
            }else{
                value.as_str().unwrap_or("Unspecified error").chars().take(400).collect()
            };
            std::fs::write(path,report).map_err(|e|e.to_string())?;
            return Ok(json!({"ok":true}));
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
            if std::env::args().any(|arg|arg=="--minternet-bookmarks-smoke"){
                if value.get("settingsKeepBookmarks").and_then(Value::as_bool)!=Some(true){
                    return Err("Settings incorrectly hides or disables Bookmark Bar".into());
                }
                if value.get("secretOnlyInManager").and_then(Value::as_bool)!=Some(true){
                    return Err("Secret Bookmarks must appear only inside Manage Bookmarks".into());
                }
                if value.get("reorderVerified").and_then(Value::as_bool)!=Some(true){
                    return Err("Bookmark Bar folder drag reorder did not persist original folders".into());
                }
            }
            let folders=value.get("items").and_then(Value::as_array).ok_or("Bookmark data missing")?;
            let bar=folders.iter().find(|x|
                x.get("id").and_then(Value::as_str)==Some("minternet-bookmark-bar")
            ).ok_or("Permanent Bookmark Bar folder missing")?;
            let entries=bar.get("children").and_then(Value::as_array).ok_or("Bookmark Bar children missing")?;
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
                if tab.secret_id.is_some(){return Err("Secret tabs cannot enter split view".into());}
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
            let muted={
                let state=app.state::<VolumeState>();
                let mut config=state.0.lock().map_err(|e|e.to_string())?;
                if !config.manually_muted.insert(id){config.manually_muted.remove(&id);false}
                else{true}
            };
            apply_volume_to_site(&app,id,&label,false);
            #[cfg(windows)]
            native_audio_poll(&app,id,&label)?;
            return Ok(json!({"ok":true,"muted":muted}));
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
        "focus-address" => {focus_address_bar(&app);return Ok(json!({"ok":true}));}
        "find-bar-set" => {
            let visible=value.as_bool().ok_or("Expected true/false")?;
            *app.state::<FindBarState>().0.lock().map_err(|e|e.to_string())?=visible;
            invalidate_layout(&app);
            refresh_layout(&app);
            return Ok(json!({"ok":true,"visible":visible}));
        }
        "find-page" => {
            let query=value.get("query").and_then(Value::as_str)
                .ok_or("Missing find text")?.trim();
            if query.len()>256 {return Err("Find query is too long".into());}
            let backward=value.get("backward").and_then(Value::as_bool)==Some(true);
            let label=app.state::<Mutex<Browser>>().lock().map_err(|e|e.to_string())?
                .active().and_then(|t|t.view.clone());
            if let Some(label)=label {
                if let Some(view)=app.get_webview(&label) {
                    let term=serde_json::to_string(query).map_err(|e|e.to_string())?;
                    let script=format!(r#"(function(){{
                      try{{
                        if(typeof window.find!=='function')return false;
                        return Boolean(window.find({term},false,{backward},true,false,false,false));
                      }}catch{{return false;}}
                    }})()"#);
                    let handle=app.clone();
                    let needle=query.to_owned();
                    view.eval_with_callback(&script,move|result|{
                        let _=handle.emit_to("chrome","minternet:find-result",
                            json!({"found":result.trim()=="true","query":needle}));
                    }).map_err(|e|e.to_string())?;
                }
            }
            return Ok(json!({"ok":true}));
        }
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
            } else if name=="new" || name=="new-private" {
                if new_tab_is_dashboard(&app) {
                    // Chrome-only dashboard: no empty WebView2 controller,
                    // network request, renderer process or idle polling.
                    display_active(&app);
                }else{
                    navigate_tab(&app,id,Some(homepage(&app)),true)?;
                }
            } else { display_active(&app); }
            if !background && matches!(name.as_str(),"new"|"new-private") {
                focus_address_bar(&app);
            }
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
                if tab.secret_id.is_some(){return Err("Secret tabs cannot be pinned".into());}
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
                if tab.secret_id.is_some(){return Err("Secret tabs cannot be duplicated outside the vault".into());}
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
            // A tab may have loaded in the background while the vault was
            // locked, or the user may have just switched to a login form.
            let _=fill_saved_credential(&app,id,false,None);
        }
        "navigate" | "home" => {
            if name=="home" && new_tab_is_dashboard(&app){
                // Dashboard is a separate no-WebView command hub. Do not
                // navigate or destroy the current tab, especially when pinned.
                let state=app.state::<Mutex<Browser>>();
                state.lock().map_err(|e|e.to_string())?.active_id=0;
                display_active(&app);
                return Ok(json!({"ok":true}));
            }
            let mut pending:Option<PendingChatPrompt>=None;
            let url = if name=="home" {
                if new_tab_is_dashboard(&app){None}else{Some(homepage(&app))}
            } else {
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
                }else if b.active().is_none()||b.active().is_some_and(|t|t.secret_id.is_some()){
                    // Address-bar navigation from a secret tab creates a
                    // normal tab; it cannot silently load a concealed tab.
                    b.add(false)?
                }else{b.active_id};
                if let Some(tab)=b.tabs.iter_mut().find(|tab|tab.id==id){
                    tab.pending_chatgpt=pending;
                }
                id
            };
            navigate_tab(&app,id,url,true)?;
        }
        "close-many" => {
            let ids=value.as_array().ok_or("Expected tab ID array")?;
            let wanted:HashSet<u32>=ids.iter().map(|v|v.as_u64().map(|x|x as u32)
                .ok_or_else(||"Invalid tab ID".to_string())).collect::<Result<_,_>>()?;
            let labels={
                let state=app.state::<Mutex<Browser>>();
                let mut b=state.lock().map_err(|e|e.to_string())?;
                let mut labels=Vec::new();
                for tab in b.tabs.iter_mut().filter(|t|wanted.contains(&t.id)){
                    scrub_secret_tab(tab);
                }
                b.tabs.retain(|t|{
                    if wanted.contains(&t.id){if let Some(label)=&t.view{labels.push(label.clone());}false}
                    else{true}
                });
                if !b.tabs.iter().any(|t|t.id==b.active_id){
                    b.active_id=0; // Keep loaded/suspended remaining tabs untouched.
                }
                labels
            };
            app.state::<AuthorizedSecrets>().items.lock().map_err(|e|e.to_string())?
                .retain(|id,_|!wanted.contains(id));
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
                let mut tab = b.tabs.remove(ix);
                let closed_view=tab.view.take();
                scrub_secret_tab(&mut tab);
                if b.active_id==id {
                    // Never wake an old suspended tab just because the current
                    // one closed. The zero-cost tabless dashboard is a stable
                    // fallback until the user selects a specific website.
                    b.active_id=0;
                }
                closed_view
            };
            app.state::<AuthorizedSecrets>().items.lock().map_err(|e|e.to_string())?
                .remove(&id);
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
        "unload-others" => {
            refresh_session_urls(&app);
            let keep_id=value.as_u64().ok_or("Invalid tab ID")? as u32;
            if app.state::<DownloadsState>().0.lock().map_err(|e|e.to_string())?
                .iter().any(|d|d.status=="downloading"){
                return Err("Wait until active downloads finish before unloading other tabs".into());
            }
            let labels={
                let state=app.state::<Mutex<Browser>>();
                let mut browser=state.lock().map_err(|e|e.to_string())?;
                if !browser.tabs.iter().any(|t|t.id==keep_id){
                    return Err("Selected tab no longer exists".into());
                }
                browser.active_id=keep_id;
                let mut labels=Vec::new();
                for tab in &mut browser.tabs{
                    if tab.id==keep_id{continue;}
                    tab.loading=false;
                    tab.checking_unload=false;
                    tab.audio_playing=false;
                    tab.audio_muted=false;
                    if tab.secret_id.is_some(){scrub_secret_tab(tab);}
                    if let Some(label)=tab.view.take(){labels.push(label);}
                }
                labels
            };
            *app.state::<SplitState>().0.lock().map_err(|e|e.to_string())?=Vec::new();
            prune_splits(&app);
            for label in labels.iter(){
                if let Some(view)=app.get_webview(label){let _=view.close();}
            }
            activated(&app)?;
            return Ok(json!({"ok":true,"unloaded":labels.len()}));
        }
        "reload-tab" | "unload-tab" => {
            if name=="unload-tab" { refresh_session_urls(&app); }
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
                if name=="reload-tab"&&tab.secret_id.is_some()&&!tab.secret_revealed{
                    return Err("Press the privacy eye before loading this Secret Tab".into());
                }
                let label=if name=="unload-tab"{
                    tab.loading=false;tab.checking_unload=false;
                    tab.audio_playing=false;tab.audio_muted=false;
                    if tab.secret_id.is_some(){scrub_secret_tab(tab);}
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
                if t.secret_id.is_some(){return Err("Secret tabs cannot change privacy mode".into());}
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
            refresh_session_urls(&app);
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
            return Ok(json!({"message": "Chrome and Firefox stores are browse-only in Minternet. WebView2 cannot run their one-click installers or Firefox XPI files. Do not install unknown extension packages."}));
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
                _=>{
                    // Persist current SPA routes immediately on an in-app quit.
                    refresh_session_urls(&app);
                    save_session(&app)?;
                    window.close().map_err(|e|e.to_string())?
                },
            }
        }
        _ => return Err("Unsupported command".into()),
    }
    notify(&app);
    Ok(json!({"ok": true}))
}

// A previous process that disappeared without a CloseRequested event may
// have been killed by the OS or crashed in WebView2. Preserve every saved URL
// but avoid automatically reopening the suspect site on the next start.
fn running_guard(app:&tauri::AppHandle)->Option<PathBuf>{
    app.path().app_data_dir().ok().map(|dir|dir.join("minternet-running.v1"))
}
fn start_crash_guard(app:&tauri::AppHandle)->bool{
    let Some(path)=running_guard(app) else{return false};
    if let Some(parent)=path.parent(){let _=std::fs::create_dir_all(parent);}
    let prior=path.exists();
    let _=std::fs::write(&path,format!("pid={}\\n",std::process::id()));
    prior
}
fn clear_crash_guard(app:&tauri::AppHandle){
    if let Some(path)=running_guard(app){let _=std::fs::remove_file(path);}
}
fn install_panic_diagnostics(app:&tauri::AppHandle){
    use std::io::Write;
    let Ok(dir)=app.path().app_data_dir() else{return};
    let _=std::fs::create_dir_all(&dir);
    let log=dir.join("minternet-crashes.log");
    std::panic::set_hook(Box::new(move|info|{
        // Never include credential values, URLs or panic payloads in logs.
        // Keep only the source location and process ID.
        let where_at=info.location().map(|loc|format!("{}:{}",loc.file(),loc.line()))
            .unwrap_or_else(||"unknown".into());
        if std::fs::metadata(&log).map(|m|m.len()>131072).unwrap_or(false){
            let _=std::fs::rename(&log,log.with_extension("previous.log"));
        }
        if let Ok(mut file)=std::fs::OpenOptions::new().create(true).append(true).open(&log){
            let _=writeln!(file,"Minternet Rust panic at {where_at}; process={}",std::process::id());
        }
    }));
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(PopupDeduper(Mutex::new(HashMap::new())))
        .manage(DownloadsState::default())
        .manage(Mutex::new(browsing_history::History::default()))
        .manage(ZoomState(Mutex::new(1.0)))
        .manage(VolumeState::default())
        .manage(SplitState::default())
        .manage(SplitRatios(Mutex::new((0.5,0.5))))
        .manage(UndoHistory(Mutex::new(VecDeque::new())))
        .manage(Mutex::new(Browser::new()))
        .manage(BrowserPreferenceState(Mutex::new(BrowserPreferences::default())))
        .manage(Mutex::new(password_vault::Vault::default()))
        .manage(Mutex::new(secret_bookmarks::SecretVault::default()))
        .manage(AuthorizedSecrets::default())
        .manage(Mutex::new(google_account::restore()))
        .manage(Mutex::new(LayoutCache::default()))
        .manage(SessionSaveQueued(AtomicBool::new(false)))
        .manage(SurfaceRestoreQueued(AtomicBool::new(false)))
        .manage(FindBarState(Mutex::new(false)))
        .manage(LocalMediaSelection::default())
        .manage(privacy_shield::ShieldState(Mutex::new(privacy_shield::ShieldConfig::default())))
        .invoke_handler(tauri::generate_handler![browser_action, browser_snapshot])
        .setup(|app| {
            let real_launch=!std::env::args().any(|arg|
                arg.starts_with("--minternet-")&&(arg.ends_with("-smoke")||arg.ends_with("-reopen")));
            if real_launch {install_panic_diagnostics(app.handle());}
            let previous_crash=real_launch&&start_crash_guard(app.handle());
            let shield=privacy_shield::load(app.handle());
            if let Ok(mut state)=app.state::<privacy_shield::ShieldState>().0.lock(){
                *state=shield;
            }
            let preferences=load_preferences(app.handle());
            if let Ok(mut saved)=app.state::<BrowserPreferenceState>().0.lock(){
                *saved=preferences.clone();
            }
            if let Ok(mut b)=app.state::<Mutex<Browser>>().lock(){
                b.tab_limit=preferences.tab_limit;
            }
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
            if previous_crash {
                if let Ok(mut b)=app.state::<Mutex<Browser>>().lock(){
                    // Existing tabs remain in the strip, but no page is
                    // opened until the user explicitly selects one.
                    b.active_id=0;
                }
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
            let auth_popup_smoke = std::env::args().any(|a| a == "--minternet-auth-popup-smoke");
            let media_smoke = std::env::args().any(|a| a == "--minternet-media-smoke");
            let bookmarks_smoke = std::env::args().any(|a| a == "--minternet-bookmarks-smoke");
            let bookmarks_reopen = std::env::args().any(|a| a == "--minternet-bookmarks-reopen");
            let menus_smoke = std::env::args().any(|a| a == "--minternet-menus-smoke");
            let search_smoke = std::env::args().any(|a| a == "--minternet-search-smoke");
            let pointer_smoke = std::env::args().any(|a| a == "--minternet-pointer-smoke");
            let rapid_smoke = std::env::args().any(|a| a == "--minternet-rapid-ui-smoke");
            let stability_smoke = std::env::args().any(|a| a == "--minternet-stability-smoke");
            let pin_smoke = std::env::args().any(|a| a == "--minternet-pin-smoke");
            let pin_reopen_smoke = std::env::args().any(|a| a == "--minternet-pin-reopen-smoke");
            if !std::env::args().any(|a|a.starts_with("--minternet-") &&
                (a.ends_with("-smoke")||a.ends_with("-reopen"))) {
                let target=homepage(app.handle()).to_string();
                if let Ok(mut browser)=app.state::<Mutex<Browser>>().lock(){
                    if browser.tabs.is_empty(){let _=browser.add(false);}
                    // The dashboard is the legitimate HOME sentinel; never
                    // replace it with Google or create a native website view
                    // unless Website is the selected New Tab preference.
                    if !new_tab_is_dashboard(app.handle()){
                    for tab in &mut browser.tabs {
                        if tab.url==HOME&&tab.secret_id.is_none(){
                            tab.url=target.clone();
                            tab.title=title_for(&target);
                            tab.history=vec![target.clone()];
                            tab.at=0;
                        }
                    }
                    }
                }
            }
            window.add_child(
                WebviewBuilder::new("chrome",WebviewUrl::App("index.html".into()))
                    // Tauri's native file-drop handler supersedes HTML5
                    // DataTransfer on Windows. Browser/bookmark drags need
                    // actual text/html, uri-list, and File objects in chrome.
                    .disable_drag_drop_handler()
                    .transparent(true)
                    .on_page_load(move |view, event| {
                        if matches!(event.event(), PageLoadEvent::Finished) {
                            if previous_crash {
                                let _=view.eval(r#"setTimeout(() =>
                                    window.minternetToast?.('Previous session ended unexpectedly. All saved tabs were preserved. Select a tab to reopen it.'),400)"#);
                            }
                            if stability_smoke {
                                // Exercise the real trusted-chrome IPC, native
                                // WebView2 creation, SPA URL capture and tab
                                // controller teardown under rapid alternation.
                                let _ = view.eval(r#"
                                  setTimeout(async () => {
                                    const command=window.minternet?.command;
                                    const pause=ms=>new Promise(ok=>setTimeout(ok,ms));
                                    const check=async(name,value)=>{
                                      const output=await command(name,value);
                                      if(output?.message)throw Error(output.message);
                                      return output;
                                    };
                                    try {
                                      for(let i=0;i<7;i++){
                                        await check('new');
                                        await check('navigate','https://example.com/?minternet-stability='+i);
                                        await pause(180);
                                      }
                                      const state=await window.__TAURI__.core.invoke('browser_snapshot');
                                      const ids=state.tabs.map(tab=>tab.id);
                                      if(ids.length<7)throw Error('Native tabs were not created');
                                      let switched=0;
                                      for(let pass=0;pass<3;pass++){
                                        for(const id of ids){
                                          await check('activate',id);
                                          switched++;
                                        }
                                      }
                                      await check('session-refresh-urls');
                                      for(const id of ids.slice(1)){
                                        await check('close',id);
                                      }
                                      await pause(1250);
                                      await check('stability-smoke-proof',{created:ids.length,switched});
                                    } catch(error) {
                                      await command('stability-smoke-failure',String(error));
                                    }
                                  },800);
                                "#);
                            } else if media_smoke {
                                let _=view.eval(r#"
                                  setTimeout(async()=>{
                                    try{
                                      await window.__TAURI__.core.invoke('browser_action',
                                        {name:'media-player-smoke-open',value:null});
                                    }catch(error){
                                      window.minternetToast?.('Native media smoke failed: '+error);
                                    }
                                  },300);
                                "#);
                            } else if smoke || auth_popup_smoke {
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
                                    // Settings must not make the Bookmark Bar
                                    // disappear or disable its existing items.
                                    const settingsKeepBookmarks=
                                      getComputedStyle($('bookmarkItems')).visibility==='visible' &&
                                      getComputedStyle($('bookmarkItems')).display!=='none' &&
                                      getComputedStyle($('bookmarkItems')).pointerEvents!=='none';
                                    const secretOnlyInManager=
                                      !$('secretBookmarksBar')&&!$('secretSettingsOpen')&&
                                      Boolean($('secretBookmarksManager'));
                                    $('bookmarkSettingsManage').click();
                                    $('bookmarkManageNewFolder').click();
                                    $('bookmarkIcon').value = '🌿';
                                    $('bookmarkIcon').dispatchEvent(new Event('input'));
                                    $('bookmarkEditForm').requestSubmit();
                                    const root = JSON.parse(localStorage.getItem('minternet.bookmark-tree.v1'))
                                      .items[0]?.children?.find(node=>node.icon==='🌿');
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
                                    // Drag one real Bookmark Bar folder to the RIGHT of
                                    // the imported folder. Use the same WebView2 event
                                    // path as human drags, including insertion hit tests.
                                    const before=window.minternetBookmarks.getState();
                                    const beforeBar=window.MinternetBookmarks.barItems(before);
                                    const importedFolder=beforeBar.find(n=>n.name==='Dragged Firefox Folder');
                                    const source=[...document.querySelectorAll('#bookmarkItems .bookmark-item')]
                                      .find(n=>n.dataset.bookmarkId===root.id);
                                    const target=[...document.querySelectorAll('#bookmarkItems .bookmark-item')]
                                      .find(n=>n.dataset.bookmarkId===importedFolder?.id);
                                    let reorderVerified=false;
                                    if(source?.draggable&&target?.draggable&&
                                      beforeBar.findIndex(n=>n.id===root.id)<
                                      beforeBar.findIndex(n=>n.id===importedFolder.id)){
                                      const drag=new DataTransfer();
                                      source.dispatchEvent(new DragEvent('dragstart',{
                                        bubbles:true,cancelable:true,dataTransfer:drag
                                      }));
                                      const rect=target.getBoundingClientRect();
                                      const clientX=rect.right-1;
                                      target.dispatchEvent(new DragEvent('dragover',{
                                        bubbles:true,cancelable:true,dataTransfer:drag,clientX
                                      }));
                                      target.dispatchEvent(new DragEvent('drop',{
                                        bubbles:true,cancelable:true,dataTransfer:drag,clientX
                                      }));
                                      source.dispatchEvent(new DragEvent('dragend',{
                                        bubbles:true,dataTransfer:drag
                                      }));
                                      const after=window.minternetBookmarks.getState();
                                      const order=window.MinternetBookmarks.barItems(after)
                                        .map(n=>n.id);
                                      reorderVerified=order.indexOf(root.id)>order.indexOf(importedFolder.id)
                                        && order.indexOf(importedFolder.id)>=0
                                        && !!window.MinternetBookmarks.find(after,root.id)
                                          ?.children?.find(n=>n.icon==='🪐');
                                    }
                                    const state = JSON.parse(localStorage.getItem('minternet.bookmark-tree.v1'));
                                    state.reorderVerified=reorderVerified;
                                    state.settingsKeepBookmarks=settingsKeepBookmarks;
                                    state.secretOnlyInManager=secretOnlyInManager;
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
                                      const root = window.MinternetBookmarks.barItems(data).findLast(n => n.kind === 'folder' && n.name === 'Folder Menu Test');
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
            // Coalesce Windows resize storms to at most one native WebView2
            // bounds pass per display frame. Do not block the UI event handler
            // on repeated COM resizing while a border is being dragged.
            let resize_pending=std::sync::Arc::new(AtomicBool::new(false));
            window.on_window_event(move |event| {
                match event {
                    tauri::WindowEvent::Resized(_) => {
                        if resize_pending.swap(true, Ordering::AcqRel) { return; }
                        let app=handle.clone();
                        let pending=resize_pending.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(Duration::from_millis(16));
                            let callback_app=app.clone();
                            let callback_pending=pending.clone();
                            if app.run_on_main_thread(move || {
                                callback_pending.store(false,Ordering::Release);
                                refresh_layout(&callback_app);
                                schedule_surface_restore(&callback_app);
                            }).is_err() {
                                pending.store(false,Ordering::Release);
                            }
                        });
                    },
                    tauri::WindowEvent::Moved(_) => {
                        // A parent HWND move, including cross-monitor dragging,
                        // can invalidate WebView2's DirectComposition surfaces.
                        schedule_surface_restore(&handle);
                    },
                    tauri::WindowEvent::CloseRequested { .. } => {
                        // On title-bar close / Alt-F4, capture the last SPA path
                        // before the WebView2 controllers and their URLs vanish.
                        // Ordinary browser state is retained; private URLs are excluded.
                        refresh_session_urls(&handle);
                        let _=save_session(&handle);
                        clear_crash_guard(&handle);
                    },
                    tauri::WindowEvent::Focused(true) => {
                        // Force a compositor refresh on restore/focus even when
                        // the physical dimensions match the cached dimensions.
                        schedule_surface_restore(&handle);
                    },
                    _=>{}
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Failed to run Minternet native browser");
}
