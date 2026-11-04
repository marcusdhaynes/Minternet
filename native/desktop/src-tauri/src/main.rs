#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod password_vault;

use std::{sync::Mutex, collections::{HashSet, HashMap, VecDeque}, path::PathBuf, time::{Instant, Duration}};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{
    Emitter, Manager, WebviewUrl, LogicalPosition, LogicalSize,
    webview::{WebviewBuilder, NewWindowResponse, PermissionResponse, PageLoadEvent},
    window::WindowBuilder,
};

const CHROME: f64 = 52.0;
const BOOKMARK_BAR: f64 = 22.0;
const MAX_TABS: usize = 35;
const HOME: &str = "about:blank";

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
    error: String,
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

struct PopupDeduper(Mutex<HashMap<(u32,String),Instant>>);
struct ZoomState(Mutex<f64>);
#[derive(Default)]
struct SplitState(Mutex<Vec<u32>>);
struct UndoState { tabs: Vec<Tab>, active_id:u32, split_ids:Vec<u32> }
struct UndoHistory(Mutex<VecDeque<UndoState>>);

fn remember_undo(app:&tauri::AppHandle) {
    let (tabs,active_id)={
        let state=app.state::<Mutex<Browser>>();
        let Ok(browser)=state.lock() else{return};
        (browser.tabs.clone(),browser.active_id)
    };
    let split_ids=app.state::<SplitState>().0.lock().map(|s|s.clone()).unwrap_or_default();
    let snapshot=UndoState{tabs,active_id,split_ids};
    let history=app.state::<UndoHistory>();
    if let Ok(mut list)=history.0.lock(){
        if list.len()>=100{list.pop_front();}
        list.push_back(snapshot);
    };
}
fn undo_last(app:&tauri::AppHandle)->Result<bool,String> {
    let entry={
        let state=app.state::<UndoHistory>();
        let mut undo=state.0.lock().map_err(|e|e.to_string())?;
        undo.pop_back()
    };
    let Some(mut entry)=entry else{return Ok(false)};
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
    invalidate_layout(app);
    save_pinned(app)?;
    activated(app)?;
    notify(app);
    Ok(true)
}

#[derive(Default)]
struct LayoutCache {
    size_and_home: Option<(u32, u32, bool, bool, bool, u64)>,
    shown: HashSet<String>,
    bookmark_bar_visible: bool,
    overlay_open: bool,
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
        });
        self.active_id = id;
        Ok(id)
    }
    fn snapshot(&self) -> Snapshot {
        Snapshot {
            active_id: self.active_id,
            extensions_count: 0,
            tabs: self.tabs.iter().map(|t| PublicTab {
                id: t.id, title: t.title.clone(), url: t.url.clone(), private: t.private,
                pinned: t.pinned, audio_playing:t.audio_playing,
                audio_muted:t.audio_muted, loading: false, can_back: t.at > 0, can_forward: t.at + 1 < t.history.len(),
                suspended: t.view.is_none() && t.url != HOME, error: String::new(),
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
            json!({"url":tab.url,"pinned":tab.pinned})
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
    if lowered.contains("://") && !lowered.starts_with("https://") {
        return Err("Only HTTPS sites are allowed. Insecure HTTP is not enabled.".into());
    }
    if lowered.starts_with("file:") || lowered.starts_with("javascript:") ||
       lowered.starts_with("data:") || lowered.starts_with("about:") ||
       lowered.starts_with("chrome:") || lowered.starts_with("blob:") {
        return Err("Unsafe navigation blocked".into());
    }
    let candidate = if lowered.starts_with("https://") {
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
            _ => ("https://www.google.com/search?q=", ""),
        };
        format!("{base}{query_param}{}", percent_encode_search(s))
    };
    let url = tauri::Url::parse(&candidate).map_err(|e| e.to_string())?;
    if url.scheme() != "https" || url.host_str().is_none() ||
       !url.username().is_empty() || url.password().is_some() {
        return Err("Blocked unsafe address".into());
    }
    Ok(Some(url))
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

fn split_rect(index:usize,count:usize,width:f64,height:f64,top:f64)->(f64,f64,f64,f64){
    match count {
        2 => {
            let w=width/2.0;
            (index as f64*w,top,w,height)
        }
        3 => {
            let w=width/2.0;
            if index==0{(0.0,top,w,height)}
            else{(w,top+(index-1) as f64*height/2.0,w,height/2.0)}
        }
        4 => {
            let w=width/2.0;let h=height/2.0;
            (((index % 2) as f64)*w,top+((index / 2) as f64)*h,w,h)
        }
        _ => (0.0,top,width,height)
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
        }
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

fn update_split_badges(app:&tauri::AppHandle,window:&tauri::Window,
                       ids:&[u32],width:f64,height:f64,top:f64){
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
        let (x,y,w,_)=split_rect(index,ids.len(),width,height,top);
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
    for view in window.webviews() {
        if view.label() == "chrome" || view.label().starts_with("split-badge-") {continue;}
        let index=if split_count>0 {
            positions.iter().position(|id|view.label()==format!("tab-{id}"))
        }else{None};
        let (x,y,w,h)=if let Some(index)=index {
            split_rect(index,split_count,width,available,top)
        }else{(0.0,top,width,available)};
        let _ = view.set_position(LogicalPosition::new(x,y));
        let _ = view.set_size(LogicalSize::new(w.max(1.0),h.max(1.0)));
    }
    update_split_badges(app,&window,if split_count>1 {positions.as_slice()} else {&[]},width,available,top);
}
fn display_active(app: &tauri::AppHandle) {
    let mut targets=HashSet::new();
    {
        // Keep all site views visible and at identical positions while trusted
        // chrome menus open. The chrome overlay is transparent outside panels.
        let split=visible_split(app);
        let browser=app.state::<Mutex<Browser>>();
        let Ok(b)=browser.lock() else{return};
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
    if !url.starts_with("https://") { return; }
    let mut pinned_change=false;
    {
        let state=app.state::<Mutex<Browser>>();
        if let Ok(mut browser)=state.lock(){
            if let Some(tab)=browser.tabs.iter_mut().find(|tab|tab.id==id){
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

fn create_webview(app: &tauri::AppHandle, id: u32, url: WebviewUrl, private: bool) -> Result<(), String> {
    let Some(window) = app.get_window("main") else { return Err("Missing window".into()) };
    let label = format!("tab-{id}");
    let (width, height) = dimensions(&window)?;
    let top = chrome_top(app);
    let for_load = app.clone();
    let for_title = app.clone();
    let for_popup = app.clone();
    let builder = WebviewBuilder::new(label.clone(), url)
        .incognito(private)
        // Honor Ctrl/Cmd + plus/minus and Ctrl + mouse-wheel when focus is
        // inside the actual website WebView, not just the browser toolbar.
        .zoom_hotkeys_enabled(true)
        .on_navigation(|url| url.scheme() == "https")
        .on_permission_request(|_view, _kind| PermissionResponse::Deny)
        .on_download(|_view, _event| false)
        .on_new_window(move |url, _features| {
            if url.scheme() == "https" {
                // WebView2 may emit both window.open and modifier-click callbacks
                // for the same gesture. Coalesce only the identical source/URL
                // pair within one short event burst, without blocking other URLs.
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
                    let _=for_popup.emit_to("chrome","minternet:open-tab",url.to_string());
                }
            }
            NewWindowResponse::Deny
        })
        .on_page_load(move |_view, event| {
            if matches!(event.event(), PageLoadEvent::Started | PageLoadEvent::Finished) {
                update_from_site(&for_load, id, event.url().as_str());
                if matches!(event.event(), PageLoadEvent::Finished) {
                    let _=fill_saved_credential(&for_load,id,false,None);
                }
            }
        })
        .on_document_title_changed(move |_view, title| {
            let state = for_title.state::<Mutex<Browser>>();
            let mut confirmed_in_app = false;
            if let Ok(mut browser) = state.lock() {
                if let Some(tab) = browser.tabs.iter_mut().find(|tab| tab.id == id) {
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
    if url != HOME && !view_exists {
        navigate_tab(app, id, Some(tauri::Url::parse(&url).map_err(|e| e.to_string())?), false)?;
    } else { display_active(app); }
    Ok(())
}

#[tauri::command]
fn browser_snapshot(app: tauri::AppHandle) -> Result<Snapshot,String> { snapshot(&app) }

#[tauri::command]
async fn browser_action(app: tauri::AppHandle, name: String, value: Value) -> Result<Value, String> {
    if name=="undo" { return Ok(json!({"undone":undo_last(&app)?})); }
    if matches!(name.as_str(),
        "new"|"new-private"|"new-url"|"pin"|"unpin"|"toggle-pin"|
        "duplicate"|"close"|"close-many"|"navigate"|"home"|"privacy"|
        "back"|"forward"|"split-add"|"split-remove"|"split-clear") {
        remember_undo(&app);
    }
    match name.as_str() {
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
            return Ok(json!({"ok":true}));
        }
        "vault-lock" => {
            app.state::<Mutex<password_vault::Vault>>().lock().map_err(|e|e.to_string())?.lock();
            return Ok(json!({"ok":true}));
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
            if !(70.0..=72.0).contains(&width) {
                return Err(format!("Expected 71px tabs, found {width}"));
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
            if folders < 2 || native < 1 || group_visible != Some(false) || group_rows < 1 {
                return Err("Native cascading folder menu / tab-group visibility check failed".into());
            }
            let marker = std::env::temp_dir()
                .join(format!("minternet-menus-{}.ok",std::process::id()));
            std::fs::write(marker,"Native folder popup and hidden tab group verified")
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
        "new" | "new-private" | "new-url" => {
            let private = name == "new-private";
            let id = {
                let state = app.state::<Mutex<Browser>>();
                let mut b = state.lock().map_err(|e| e.to_string())?;
                b.add(private)?
            };
            if name == "new-url" {
                let address = value.as_str().ok_or("Missing URL")?;
                navigate_tab(&app, id, parse_address(address)?, true)?;
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
            let url = if name=="home" { None } else {
                let address=value.as_str()
                    .or_else(||value.get("address").and_then(Value::as_str))
                    .ok_or("Missing address")?;
                let engine=value.get("searchEngine").and_then(Value::as_str).unwrap_or("google");
                let target=parse_address_with_engine(address,engine)?;
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
                let state = app.state::<Mutex<Browser>>();
                let mut b = state.lock().map_err(|e| e.to_string())?;
                if b.active().is_none(){b.add(false)?} else {b.active_id}
            };
            navigate_tab(&app, id, url, true)?;
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
                        if dest.scheme() != "https" { return Err("Unsafe history URL".into()); }
                        navigate_tab(&app, id, Some(dest), false)?;
                    } else {
                        notify(&app);
                    }
                }
            }
        }
        "reload-tab" | "unload-tab" => {
            let id=value.as_u64().ok_or("Invalid tab ID")? as u32;
            let (label,is_active,url)={
                let state=app.state::<Mutex<Browser>>();
                let mut b=state.lock().map_err(|e|e.to_string())?;
                let is_active=b.active_id==id;
                if name=="unload-tab" && is_active {
                    return Err("Select another tab before unloading this one".into());
                }
                let tab=b.tabs.iter_mut().find(|t|t.id==id).ok_or("Tab not found")?;
                let label=if name=="unload-tab"{tab.view.take()}else{tab.view.clone()};
                (label,is_active,tab.url.clone())
            };
            if let Some(label)=label{
                if let Some(view)=app.get_webview(&label){
                    if name=="unload-tab"{view.close().map_err(|e|e.to_string())?;}
                    else{view.reload().map_err(|e|e.to_string())?;}
                }
            }else if name=="reload-tab" && is_active && url!=HOME{
                let dest=tauri::Url::parse(&url).map_err(|e|e.to_string())?;
                navigate_tab(&app,id,Some(dest),false)?;
            }
            notify(&app);
            return Ok(json!({"ok":true}));
        }
        "reload" => {
            let label = {
                let state=app.state::<Mutex<Browser>>();
                let b=state.lock().map_err(|e|e.to_string())?;
                b.active().and_then(|t|t.view.clone())
            };
            if let Some(label)=label {
                if let Some(view)=app.get_webview(&label) {
                    view.reload().map_err(|e|e.to_string())?;
                }
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
        .manage(PopupDeduper(Mutex::new(HashMap::new())))
        .manage(ZoomState(Mutex::new(1.0)))
        .manage(SplitState::default())
        .manage(UndoHistory(Mutex::new(VecDeque::new())))
        .manage(Mutex::new(Browser::new()))
        .manage(Mutex::new(password_vault::Vault::default()))
        .manage(Mutex::new(LayoutCache::default()))
        .invoke_handler(tauri::generate_handler![browser_action, browser_snapshot])
        .setup(|app| {
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
                                    const fire=()=>row.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,button:0}));
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
