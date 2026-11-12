// WebView2's own ContextMenuRequested target gives a trusted link URL and
// selection. Always mark the default menu handled and render Minternet's
// compact DOM menu above the webpage, even if the page blocks DOM events.
#[cfg(windows)]
pub fn attach(app:&tauri::AppHandle,id:u32,view:&tauri::Webview){
    use tauri::{Emitter,Manager};
    use windows::core::{Interface,PWSTR};
    use windows::Win32::Foundation::{BOOL,POINT};
    use windows::Win32::System::Com::CoTaskMemFree;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_11;
    let handle=app.clone();
    let _=view.with_webview(move |native|{
        let Ok(core)=(unsafe{native.controller().CoreWebView2()})else{return};
        let Ok(ext)=core.cast::<ICoreWebView2_11>()else{return};
        let handler=webview2_com::ContextMenuRequestedEventHandler::create(Box::new(move |_,args|{
            let Some(args)=args else{return Ok(())};
            // We always suppress the WebView2/Windows context menu. If
            // an event cannot be decoded, a minimal Minternet page menu
            // will be shown instead of falling back to OS UI.
            let _=unsafe{args.SetHandled(true)};
            let mut point=POINT::default();
            let _=unsafe{args.Location(&mut point)};
            let mut href=String::new();
            let mut selection=String::new();
            let mut page=String::new();
            let mut editable=false;
            if let Ok(target)=unsafe{args.ContextMenuTarget()}{
                let mut bool_flag=BOOL::default();
                if unsafe{target.HasLinkUri(&mut bool_flag)}.is_ok()&&bool_flag.as_bool(){
                    let mut value=PWSTR::null();
                    if unsafe{target.LinkUri(&mut value)}.is_ok(){
                        href=unsafe{value.to_string().unwrap_or_default()};
                        if !value.is_null(){
                            unsafe{CoTaskMemFree(Some(value.0 as *const _));}
                        }
                    }
                }
                bool_flag=BOOL::default();
                if unsafe{target.HasSelection(&mut bool_flag)}.is_ok()&&bool_flag.as_bool(){
                    let mut value=PWSTR::null();
                    if unsafe{target.SelectionText(&mut value)}.is_ok(){
                        selection=unsafe{value.to_string().unwrap_or_default()};
                        if !value.is_null(){
                            unsafe{CoTaskMemFree(Some(value.0 as *const _));}
                        }
                    }
                }
                let mut value=PWSTR::null();
                if unsafe{target.PageUri(&mut value)}.is_ok(){
                    page=unsafe{value.to_string().unwrap_or_default()};
                    if !value.is_null(){
                        unsafe{CoTaskMemFree(Some(value.0 as *const _));}
                    }
                }
                bool_flag=BOOL::default();
                if unsafe{target.IsEditable(&mut bool_flag)}.is_ok(){
                    editable=bool_flag.as_bool();
                }
            }
            // Child webviews are below the Minternet title/address chrome.
            // Coordinates are expressed in logical window pixels so the DOM
            // menu renders at the pointer regardless of monitor scaling.
            let scale=handle.get_window("main").and_then(|w|w.scale_factor().ok())
                .unwrap_or(1.0);
            let _=handle.emit_to("chrome","minternet:site-context",serde_json::json!({
                "tabId":id,
                "x":(point.x as f64/scale).max(0.0),
                "y":(super::chrome_top(&handle)+point.y as f64/scale).max(0.0),
                "linkUrl":href.chars().take(4000).collect::<String>(),
                "selection":selection.chars().take(2048).collect::<String>(),
                "pageUrl":page.chars().take(4000).collect::<String>(),
                "editable":editable
            }));
            Ok(())
        }));
        let mut token=0i64;
        let _=unsafe{ext.add_ContextMenuRequested(&handler,&mut token)};
    });
}
#[cfg(not(windows))]
pub fn attach(_app:&tauri::AppHandle,_id:u32,_view:&tauri::Webview){}
