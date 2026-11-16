// True fullscreen in Minternet: WebView2 document fullscreen must promote
// the NATIVE containing window, hide Chrome, and lay the site out at (0,0).
// A redundant DOM fullscreenchange message repairs missed WebView2 events,
// but is only accepted if WebView2 independently confirms fullscreen state.
use std::sync::atomic::{AtomicU32,Ordering};
use tauri::Manager;
static FULLSCREEN_TAB:AtomicU32=AtomicU32::new(0);

pub fn active(app:&tauri::AppHandle)->bool{
    let tab=FULLSCREEN_TAB.load(Ordering::SeqCst);
    if tab==0{return false;}
    app.state::<std::sync::Mutex<super::Browser>>().lock().ok()
        .is_some_and(|b|b.active_id==tab)
}
#[cfg(windows)]
fn send_ack(app:&tauri::AppHandle,id:u32,active:bool){
    if let Some(view)=app.get_webview(&format!("tab-{id}")){
        let content=format!(
            "{{\"minternetFullscreen\":{{\"active\":{active},\"native\":true}}}}"
        );
        let _=view.with_webview(move|native|{
            let Ok(core)=(unsafe{native.controller().CoreWebView2()})else{return};
            let message:Vec<u16>=content.encode_utf16().chain(Some(0)).collect();
            let _=unsafe{core.PostWebMessageAsJson(windows::core::PCWSTR(message.as_ptr()))};
        });
    }
}
#[cfg(windows)]
fn change(app:tauri::AppHandle,id:u32,requested:bool){
    let main=app.clone();
    let _=app.run_on_main_thread(move||{
        let current=main.state::<std::sync::Mutex<super::Browser>>().lock().ok()
            .is_some_and(|b|b.active_id==id);
        if requested&&!current{return;}
        if !requested&&FULLSCREEN_TAB.load(Ordering::SeqCst)!=id{return;}
        let Some(window)=main.get_window("main")else{return};
        if requested{
            if FULLSCREEN_TAB.load(Ordering::SeqCst)!=id{
                if window.set_fullscreen(true).is_err(){
                    send_ack(&main,id,false);return;
                }
                FULLSCREEN_TAB.store(id,Ordering::SeqCst);
            }
            if let Ok((w,h))=super::dimensions(&window){
                let _=apply_layout(&main,w,h);
            }
            send_ack(&main,id,true);
        }else{
            FULLSCREEN_TAB.store(0,Ordering::SeqCst);
            let _=window.set_fullscreen(false);
            if let Some(chrome)=main.get_webview("chrome"){let _=chrome.show();}
            super::invalidate_layout(&main);
            super::display_active(&main);
            send_ack(&main,id,false);
        }
    });
}
#[cfg(windows)]
pub fn attach(app:&tauri::AppHandle,id:u32,view:&tauri::Webview){
    use windows::core::{BOOL,PWSTR};
    use webview2_com::{ContainsFullScreenElementChangedEventHandler,
       WebMessageReceivedEventHandler};
    let owner=app.clone();
    let _=view.with_webview(move|native|{
        let Ok(core)=(unsafe{native.controller().CoreWebView2()})else{return};
        let first=owner.clone();
        let handler=ContainsFullScreenElementChangedEventHandler::create(
            Box::new(move|sender,_args|{
                let Some(sender)=sender else{return Ok(())};
                let mut fullscreen=BOOL::default();
                if unsafe{sender.ContainsFullScreenElement(&mut fullscreen)}.is_ok(){
                    change(first.clone(),id,fullscreen.as_bool());
                }
                Ok(())
            }));
        let mut token=0i64;
        let _=unsafe{core.add_ContainsFullScreenElementChanged(&handler,&mut token)};
        // WebView2 event callbacks can be missed on early/late child WebView
        // attachment. The page also reports every fullscreenchange, which
        // is validated against the native WebView2 fullscreen property.
        let second=owner.clone();
        let message=WebMessageReceivedEventHandler::create(Box::new(move|sender,args|{
            let Some(args)=args else{return Ok(())};
            let Some(sender)=sender else{return Ok(())};
            let mut raw=PWSTR::null();
            if unsafe{args.WebMessageAsJson(&mut raw)}.is_err(){return Ok(());}
            let body=unsafe{raw.to_string().unwrap_or_default()};
            if !raw.is_null(){unsafe{
                windows::Win32::System::Com::CoTaskMemFree(Some(raw.0.cast()));
            }}
            if body.len()>256{return Ok(());}
            let Ok(value)=serde_json::from_str::<serde_json::Value>(&body)else{return Ok(())};
            if value.get("minternetFullscreen").and_then(serde_json::Value::as_str)
                !=Some("change"){return Ok(());}
            let mut origin=PWSTR::null();
            if unsafe{args.Source(&mut origin)}.is_err(){return Ok(());}
            let from=unsafe{origin.to_string().unwrap_or_default()};
            if !origin.is_null(){unsafe{
                windows::Win32::System::Com::CoTaskMemFree(Some(origin.0.cast()));
            }}
            let top=second.get_webview(&format!("tab-{id}"))
                .and_then(|v|v.url().ok()).map(|u|u.to_string());
            if top.as_deref()!=Some(from.as_str()){return Ok(());}
            let mut full=BOOL::default();
            if unsafe{sender.ContainsFullScreenElement(&mut full)}.is_ok(){
                change(second.clone(),id,full.as_bool());
            }
            Ok(())
        }));
        let mut other=0i64;
        let _=unsafe{core.add_WebMessageReceived(&message,&mut other)};
    });
}
#[cfg(not(windows))]
pub fn attach(_app:&tauri::AppHandle,_id:u32,_view:&tauri::Webview){}

#[cfg(windows)]
pub fn apply_layout(app:&tauri::AppHandle,width:f64,height:f64)->bool{
    let id=FULLSCREEN_TAB.load(Ordering::SeqCst);
    if id==0||!active(app){return false;}
    let Some(view)=app.get_webview(&format!("tab-{id}"))else{return false};
    let bounds=tauri::Rect{
        position:tauri::LogicalPosition::new(0.0,0.0).into(),
        size:tauri::LogicalSize::new(width.max(1.0),height.max(1.0)).into()
    };
    let _=view.set_bounds(bounds);
    let _=view.show();
    if let Some(chrome)=app.get_webview("chrome"){let _=chrome.hide();}
    true
}
#[cfg(not(windows))]
pub fn apply_layout(_app:&tauri::AppHandle,_width:f64,_height:f64)->bool{false}

pub fn cancel_if_tab_changed(app:&tauri::AppHandle){
    let id=FULLSCREEN_TAB.load(Ordering::SeqCst);
    if id==0||active(app){return;}
    FULLSCREEN_TAB.store(0,Ordering::SeqCst);
    if let Some(window)=app.get_window("main"){let _=window.set_fullscreen(false);}
    if let Some(chrome)=app.get_webview("chrome"){let _=chrome.show();}
    super::invalidate_layout(app);
}
