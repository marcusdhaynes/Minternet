// Browser-native page context menus presented in Minternet's own UI.
//
// WebView2 supplies *context-specific* command IDs, including image bitmap
// clipboard copy, image save, link, selection, editing, spellcheck, media,
// document, and extension commands. We forward the actual menu tree instead
// of guessing actions from a URL or reimplementing clipboard formats.
// SelectedCommandId + GetDeferral/Complete executes the selected action in
// the originating page and frame, including blob/data images and iframes.
#[cfg(windows)]
mod windows_menu {
    use std::{
        cell::RefCell,
        collections::HashSet,
        sync::atomic::{AtomicU64,Ordering},
        time::Duration,
    };
    use tauri::{AppHandle,Emitter,Manager};
    use windows::core::{BOOL,Interface,PWSTR};
    use windows::Win32::Foundation::POINT;
    use windows::Win32::System::Com::CoTaskMemFree;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_11, ICoreWebView2ContextMenuItemCollection,
        ICoreWebView2ContextMenuRequestedEventArgs,ICoreWebView2Deferral,
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND,
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SUBMENU,
        COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_PAGE,
        COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_IMAGE,
        COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_SELECTED_TEXT,
        COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_AUDIO,
        COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_VIDEO,
    };
    use serde_json::{Value,json};

    // COM interface pointers are apartment-bound (!Send/!Sync). Tauri's main
    // thread owns the controller and the deferral; never put them in a Mutex
    // or send them to a background thread.
    struct Pending {
        tab_id:u32,
        request_id:u64,
        args:ICoreWebView2ContextMenuRequestedEventArgs,
        deferral:ICoreWebView2Deferral,
        allowed:HashSet<i32>,
    }
    thread_local! {
        static CURRENT:RefCell<Option<Pending>>=const {RefCell::new(None)};
    }
    static NEXT_REQUEST:AtomicU64=AtomicU64::new(1);

    fn complete(pending:Pending, selected:Option<i32>){
        if let Some(id)=selected.filter(|id|pending.allowed.contains(id)){
            let _=unsafe{pending.args.SetSelectedCommandId(id)};
        }
        let _=unsafe{pending.args.SetHandled(true)};
        let _=unsafe{pending.deferral.Complete()};
    }
    fn clear(){
        CURRENT.with(|slot|{
            if let Some(previous)=slot.borrow_mut().take(){complete(previous,None);}
        });
    }

    // Invoked on the main WebView2 UI apartment by browser_action. The
    // monotonically increasing request ID prevents stale click handlers from
    // executing commands for a *different* right-click target.
    pub(super) fn select(app:&AppHandle,tab_id:u32,request_id:u64,
                         command_id:Option<i32>)->Result<(),String>{
        if request_id==0{return Err("Invalid context request".into());}
        let handle=app.clone();
        handle.run_on_main_thread(move||{
            CURRENT.with(|slot|{
                let matching=slot.borrow().as_ref()
                    .is_some_and(|p|p.tab_id==tab_id&&p.request_id==request_id);
                if matching{
                    if let Some(p)=slot.borrow_mut().take(){complete(p,command_id);}
                }
            });
        }).map_err(|e|format!("Cannot execute WebView2 context action: {e}"))
    }

    fn read_string<F>(get:F)->String
    where F:FnOnce(*mut PWSTR)->windows::core::Result<()> {
        let mut ptr=PWSTR::null();
        if get(&mut ptr).is_err(){return String::new();}
        let value=unsafe{ptr.to_string().unwrap_or_default()};
        if !ptr.is_null(){unsafe{CoTaskMemFree(Some(ptr.0 as *const _));}}
        value
    }

    fn item_tree(items:&ICoreWebView2ContextMenuItemCollection,
                 allowed:&mut HashSet<i32>,depth:u8)->Vec<Value>{
        if depth>8{return vec![];}
        let mut count=0u32;
        if (unsafe{items.Count(&mut count)}).is_err(){return vec![];}
        let mut entries=Vec::new();
        for index in 0..count.min(160){
            let Ok(item)=(unsafe{items.GetValueAtIndex(index)})else{continue};
            let mut kind=COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND;
            if (unsafe{item.Kind(&mut kind)}).is_err(){continue;}
            if kind==COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR{
                entries.push(json!({"separator":true}));
                continue;
            }
            let label=read_string(|p|unsafe{item.Label(p)});
            let name=read_string(|p|unsafe{item.Name(p)});
            let shortcut=read_string(|p|unsafe{item.ShortcutKeyDescription(p)});
            let mut enabled=BOOL::default();
            let _=unsafe{item.IsEnabled(&mut enabled)};
            let mut checked=BOOL::default();
            let _=unsafe{item.IsChecked(&mut checked)};
            if kind==COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SUBMENU{
                let children=unsafe{item.Children()}.ok()
                    .map(|items|item_tree(&items,allowed,depth+1))
                    .unwrap_or_default();
                if !children.is_empty(){
                    entries.push(json!({
                        "text":label,"name":name,"items":children,
                        "enabled":enabled.as_bool()
                    }));
                }
            }else{
                let mut command_id=-1i32;
                if (unsafe{item.CommandId(&mut command_id)}).is_err(){continue;}
                if command_id<0{continue;}
                if enabled.as_bool(){allowed.insert(command_id);}
                entries.push(json!({
                    "text":label,"name":name,"shortcut":shortcut,
                    "commandId":command_id,
                    "enabled":enabled.as_bool(),"checked":checked.as_bool()
                }));
            }
        }
        // Browser core occasionally supplies separator-only menus. Trim them
        // before the UI sees the list, keeping menu layout consistent.
        while entries.first().is_some_and(|x|x.get("separator")==Some(&json!(true))){
            entries.remove(0);
        }
        while entries.last().is_some_and(|x|x.get("separator")==Some(&json!(true))){
            entries.pop();
        }
        entries
    }

    pub(super) fn attach(app:&AppHandle,id:u32,view:&tauri::Webview){
        let handle=app.clone();
        let _=view.with_webview(move |native|{
            let Ok(core)=(unsafe{native.controller().CoreWebView2()})else{return};
            let Ok(ext)=core.cast::<ICoreWebView2_11>()else{return};
            let handler=webview2_com::ContextMenuRequestedEventHandler::create(Box::new(move |_,args|{
                let Some(args)=args else{return Ok(())};
                // Suppress OS/Edge menu, but retain its native commands.
                let _=unsafe{args.SetHandled(true)};
                clear();
                let request_id=NEXT_REQUEST.fetch_add(1,Ordering::Relaxed);
                let mut point=POINT::default();
                let _=unsafe{args.Location(&mut point)};
                let mut href=String::new();
                let mut source=String::new();
                let mut selection=String::new();
                let mut page=String::new();
                let mut editable=false;
                let mut target_kind="page";
                if let Ok(target)=unsafe{args.ContextMenuTarget()}{
                    let mut kind=COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_PAGE;
                    if (unsafe{target.Kind(&mut kind)}).is_ok(){
                        target_kind=if kind==COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_IMAGE{"image"}
                        else if kind==COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_VIDEO{"video"}
                        else if kind==COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_AUDIO{"audio"}
                        else if kind==COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_SELECTED_TEXT{"selection"}
                        else {"page"};
                    }
                    let mut flag=BOOL::default();
                    if (unsafe{target.HasLinkUri(&mut flag)}).is_ok()&&flag.as_bool(){
                        href=read_string(|p|unsafe{target.LinkUri(p)});
                    }
                    flag=BOOL::default();
                    if (unsafe{target.HasSourceUri(&mut flag)}).is_ok()&&flag.as_bool(){
                        source=read_string(|p|unsafe{target.SourceUri(p)});
                    }
                    flag=BOOL::default();
                    if (unsafe{target.HasSelection(&mut flag)}).is_ok()&&flag.as_bool(){
                        selection=read_string(|p|unsafe{target.SelectionText(p)});
                    }
                    page=read_string(|p|unsafe{target.PageUri(p)});
                    flag=BOOL::default();
                    if (unsafe{target.IsEditable(&mut flag)}).is_ok(){editable=flag.as_bool();}
                }
                let mut allowed=HashSet::new();
                let entries=unsafe{args.MenuItems()}.ok()
                    .map(|items|item_tree(&items,&mut allowed,0))
                    .unwrap_or_default();
                let Ok(deferral)=(unsafe{args.GetDeferral()})else{
                    // No deferral: don't emit a menu whose actions cannot run.
                    return Ok(());
                };
                CURRENT.with(|slot|{
                    *slot.borrow_mut()=Some(Pending{
                        tab_id:id,request_id,args:args.clone(),deferral,allowed
                    });
                });
                let scale=handle.get_window("main")
                    .and_then(|window|window.scale_factor().ok()).unwrap_or(1.0)
                    .max(0.1);
                // WebView2 Location is relative to the *clicked webview*, not
                // to the containing window. Its origin can be shifted both
                // vertically AND horizontally (for example in split view).
                // Query the actual child position instead of assuming x=0
                // and a fixed toolbar height.
                let (origin_x,origin_y)=handle.get_webview(&format!("tab-{id}"))
                    .and_then(|view|view.position().ok())
                    .map(|pos|(pos.x as f64/scale,pos.y as f64/scale))
                    .unwrap_or((0.0,super::super::chrome_top(&handle)));
                let result=handle.emit_to("chrome","minternet:site-context",json!({
                    "tabId":id,"requestId":request_id,
                    "x":(origin_x+point.x as f64/scale).max(0.0),
                    "y":(origin_y+point.y as f64/scale).max(0.0),
                    "kind":target_kind,"nativeItems":entries,
                    "linkUrl":href.chars().take(4000).collect::<String>(),
                    "sourceUrl":source.chars().take(4000).collect::<String>(),
                    "selection":selection.chars().take(2048).collect::<String>(),
                    "pageUrl":page.chars().take(4000).collect::<String>(),
                    "editable":editable
                }));
                if result.is_err(){clear();return Ok(());}
                // A renderer crash or discarded menu must never leave a live
                // site waiting indefinitely on a WebView2 context deferral.
                let watchdog=handle.clone();
                std::thread::spawn(move||{
                    std::thread::sleep(Duration::from_secs(45));
                    let app=watchdog.clone();
                    let _=watchdog.run_on_main_thread(move||{
                        CURRENT.with(|slot|{
                            let matching=slot.borrow().as_ref()
                                .is_some_and(|p|p.request_id==request_id);
                            if matching{
                                if let Some(p)=slot.borrow_mut().take(){complete(p,None);}
                                let _=app.emit_to("chrome","minternet:site-context-expired",
                                    json!({"requestId":request_id}));
                            }
                        });
                    });
                });
                Ok(())
            }));
            let mut token=0i64;
            let _=unsafe{ext.add_ContextMenuRequested(&handler,&mut token)};
        });
    }
}

#[cfg(windows)]
pub fn attach(app:&tauri::AppHandle,id:u32,view:&tauri::Webview){
    windows_menu::attach(app,id,view);
}
#[cfg(windows)]
pub fn select(app:&tauri::AppHandle,tab_id:u32,request_id:u64,
              command_id:Option<i32>)->Result<(),String>{
    windows_menu::select(app,tab_id,request_id,command_id)
}
#[cfg(not(windows))]
pub fn attach(_app:&tauri::AppHandle,_id:u32,_view:&tauri::Webview){}
#[cfg(not(windows))]
pub fn select(_app:&tauri::AppHandle,_tab_id:u32,_request_id:u64,
              _command_id:Option<i32>)->Result<(),String>{
    Err("Native context actions require WebView2 on Windows".into())
}
