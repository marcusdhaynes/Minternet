// WebView2's HTML fullscreen stops at its embedded rectangle.
// Extend a genuine document.fullscreenElement request across the OS display.
use std::sync::atomic::{AtomicU32,Ordering};
use tauri::Manager;
static FULLSCREEN_TAB:AtomicU32=AtomicU32::new(0);

#[cfg(windows)]
pub fn attach(app:&tauri::AppHandle,id:u32,view:&tauri::Webview){
    use windows::Win32::Foundation::BOOL;
    use webview2_com::ContainsFullScreenElementChangedEventHandler;
    let host=app.clone();
    let _=view.with_webview(move|native|{
        let Ok(core)=(unsafe{native.controller().CoreWebView2()})else{return};
        let handler=ContainsFullScreenElementChangedEventHandler::create(
            Box::new(move|sender,_args|{
                let Some(sender)=sender else{return Ok(())};
                let mut full=BOOL::default();
                if unsafe{sender.ContainsFullScreenElement(&mut full)}.is_err(){
                    return Ok(());
                }
                let requested=full.as_bool();
                let app=host.clone();
                let dispatcher=app.clone();
                let _=app.run_on_main_thread(move||{
                    let current=dispatcher.state::<std::sync::Mutex<super::Browser>>()
                        .lock().ok().map(|b|b.active_id==id).unwrap_or(false);
                    if requested&&!current{return;}
                    if !requested && FULLSCREEN_TAB.load(Ordering::SeqCst)!=id{return;}
                    let Some(window)=dispatcher.get_window("main")else{return};
                    if requested{
                        if window.set_fullscreen(true).is_err(){return;}
                        FULLSCREEN_TAB.store(id,Ordering::SeqCst);
                        if let Ok((w,h))=super::dimensions(&window){
                            let _=apply_layout(&dispatcher,w,h);
                        }
                    }else{
                        FULLSCREEN_TAB.store(0,Ordering::SeqCst);
                        let _=window.set_fullscreen(false);
                        if let Some(chrome)=dispatcher.get_webview("chrome"){
                            let _=chrome.show();
                        }
                        super::invalidate_layout(&dispatcher);
                        super::display_active(&dispatcher);
                    }
                });
                Ok(())
            }));
        let mut token=0i64;
        let _=unsafe{core.add_ContainsFullScreenElementChanged(&handler,&mut token)};
    });
}
#[cfg(not(windows))]
pub fn attach(_app:&tauri::AppHandle,_id:u32,_view:&tauri::Webview){}

#[cfg(windows)]
pub fn apply_layout(app:&tauri::AppHandle,width:f64,height:f64)->bool{
    let id=FULLSCREEN_TAB.load(Ordering::SeqCst);
    if id==0{return false;}
    let active=app.state::<std::sync::Mutex<super::Browser>>()
        .lock().ok().map(|b|b.active_id==id).unwrap_or(false);
    if !active{return false;}
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
    if id==0{return;}
    let current=app.state::<std::sync::Mutex<super::Browser>>()
        .lock().ok().map(|b|b.active_id==id).unwrap_or(false);
    if current{return;}
    FULLSCREEN_TAB.store(0,Ordering::SeqCst);
    if let Some(window)=app.get_window("main"){let _=window.set_fullscreen(false);}
    if let Some(chrome)=app.get_webview("chrome"){let _=chrome.show();}
    super::invalidate_layout(app);
}
