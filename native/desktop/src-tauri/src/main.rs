#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{sync::Mutex, collections::HashSet};
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

#[derive(Default)]
struct LayoutCache {
    size_and_home: Option<(u32, u32, bool, bool, bool)>,
    shown: Option<String>,
    bookmark_bar_visible: bool,
    overlay_open: bool,
}

impl Browser {
    fn new() -> Self {
        Self {
            tabs: vec![Tab {
                id: 1, title: "New Tab".into(), url: HOME.into(),
                private: false, view: None, history: vec![HOME.into()], at: 0,
            }],
            active_id: 1,
            next_id: 2,
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
                loading: false, can_back: t.at > 0, can_forward: t.at + 1 < t.history.len(),
                suspended: t.view.is_none() && t.url != HOME, error: String::new(),
            }).collect(),
        }
    }
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

fn refresh_layout(app: &tauri::AppHandle) {
    let Some(window) = app.get_window("main") else { return };
    let Ok(physical) = window.inner_size() else { return };
    let Ok((width, height)) = dimensions(&window) else { return };
    let show_home = app.state::<Mutex<Browser>>()
        .lock()
        .map(|b| b.active().map(|t| t.url == HOME).unwrap_or(true))
        .unwrap_or(true);
    let (bar_visible, overlay_open) = {
        let cache = app.state::<Mutex<LayoutCache>>();
        let Ok(mut state) = cache.lock() else { return };
        let signature = (
            physical.width, physical.height, show_home,
            state.bookmark_bar_visible, state.overlay_open
        );
        if state.size_and_home == Some(signature) { return; }
        state.size_and_home = Some(signature);
        (state.bookmark_bar_visible, state.overlay_open)
    };
    let top = CHROME + if bar_visible { BOOKMARK_BAR } else { 0.0 };
    // When a folder/settings popover opens, temporarily show the full local
    // chrome surface; website views remain alive but hidden, never reloaded.
    if let Some(chrome) = app.get_webview("chrome") {
        let full = show_home || overlay_open;
        let height_for_chrome = if full { height } else { top.min(height) };
        let _ = chrome.set_size(LogicalSize::new(width, height_for_chrome));
    }
    let available = (height - top).max(1.0);
    for view in window.webviews() {
        if view.label() == "chrome" { continue; }
        let _ = view.set_position(LogicalPosition::new(0.0, top));
        let _ = view.set_size(LogicalSize::new(width, available));
    }
}

fn display_active(app: &tauri::AppHandle) {
    let overlay = {
        let cache = app.state::<Mutex<LayoutCache>>();
        cache.lock().map(|s| s.overlay_open).unwrap_or(false)
    };
    let target = if overlay { None } else {
        let store = app.state::<Mutex<Browser>>();
        let Ok(b) = store.lock() else { return };
        b.active().and_then(|tab| if tab.url == HOME { None } else { tab.view.clone() })
    };
    refresh_layout(app);
    // Only change visibility of the old and new browser views.
    let previous = {
        let cache = app.state::<Mutex<LayoutCache>>();
        let Ok(mut state) = cache.lock() else { return };
        if state.shown == target {
            notify(app);
            return;
        }
        let old = state.shown.clone();
        state.shown = target.clone();
        old
    };
    if let Some(label) = previous {
        if let Some(view) = app.get_webview(&label) { let _ = view.hide(); }
    }
    if let Some(label) = target {
        if let Some(view) = app.get_webview(&label) { let _ = view.show(); }
    }
    notify(app);
}

fn update_from_site(app: &tauri::AppHandle, id: u32, url: &str) {
    if !url.starts_with("https://") { return; }
    {
        let state = app.state::<Mutex<Browser>>();
        if let Ok(mut browser) = state.lock() {
            if let Some(tab) = browser.tabs.iter_mut().find(|tab| tab.id == id) {
                if tab.url != url {
                    tab.url = url.to_string();
                    if tab.history.get(tab.at).map(|s| s.as_str()) != Some(url) {
                        tab.history.truncate(tab.at + 1);
                        tab.history.push(url.into());
                        tab.at = tab.history.len() - 1;
                    }
                }
                if tab.title == "New Tab" { tab.title = title_for(url); }
            }
        };
    }
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
        .on_navigation(|url| url.scheme() == "https")
        .on_permission_request(|_view, _kind| PermissionResponse::Deny)
        .on_download(|_view, _event| false)
        .on_new_window(move |url, _features| {
            if url.scheme() == "https" {
                let _ = for_popup.emit_to("chrome", "minternet:open-tab", url.to_string());
            }
            NewWindowResponse::Deny
        })
        .on_page_load(move |_view, event| {
            if matches!(event.event(), PageLoadEvent::Started | PageLoadEvent::Finished) {
                update_from_site(&for_load, id, event.url().as_str());
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
    window.add_child(
        builder,
        LogicalPosition::new(0.0, top),
        LogicalSize::new(width, (height - top).max(1.0)),
    ).map_err(|e| e.to_string())?;
    let state = app.state::<Mutex<Browser>>();
    let mut browser = state.lock().map_err(|e| e.to_string())?;
    if let Some(tab) = browser.tabs.iter_mut().find(|tab| tab.id == id) {
        tab.view = Some(label);
    }
    Ok(())
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
    let (existing, private, warming) = {
        let state = app.state::<Mutex<Browser>>();
        let mut browser = state.lock().map_err(|e| e.to_string())?;
        let warming = browser.warming.contains(&id);
        let tab = browser.tabs.iter_mut().find(|t| t.id == id).ok_or("Tab not found")?;
        if append && tab.url != str_url {
            tab.history.truncate(tab.at + 1);
            tab.history.push(str_url.clone());
            tab.at = tab.history.len()-1;
        }
        tab.url = str_url.clone();
        tab.title = title_for(&str_url);
        (tab.view.clone(), tab.private, warming)
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
    display_active(app);
    Ok(())
}

fn activated(app: &tauri::AppHandle) -> Result<(), String> {
    let (id, url, view_exists) = {
        let state = app.state::<Mutex<Browser>>();
        let b = state.lock().map_err(|e| e.to_string())?;
        let tab = b.active().ok_or("No active tab")?;
        (tab.id, tab.url.clone(), tab.view.is_some())
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
    match name.as_str() {
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
                let b = state.lock().map_err(|e| e.to_string())?;
                b.active_id
            };
            navigate_tab(&app, id, url, true)?;
        }
        "close" => {
            let id = value.as_u64().ok_or("Invalid tab")? as u32;
            let label = {
                let state = app.state::<Mutex<Browser>>();
                let mut b = state.lock().map_err(|e| e.to_string())?;
                let ix = b.tabs.iter().position(|t|t.id==id).ok_or("Unknown tab")?;
                let tab = b.tabs.remove(ix);
                if b.tabs.is_empty() { b.add(false)?; }
                else if b.active_id==id { b.active_id = b.tabs[ix.min(b.tabs.len()-1)].id; }
                tab.view
            };
            if let Some(label)=label {
                if let Some(wv)=app.get_webview(&label) { let _=wv.close(); }
            }
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
        .manage(Mutex::new(Browser::new()))
        .manage(Mutex::new(LayoutCache::default()))
        .invoke_handler(tauri::generate_handler![browser_action, browser_snapshot])
        .setup(|app| {
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
            window.add_child(
                WebviewBuilder::new("chrome",WebviewUrl::App("index.html".into()))
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
                            } else if rapid_smoke {
                                let _ = view.eval(r#"
                                  setTimeout(async () => {
                                    const $ = id => document.getElementById(id);
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
