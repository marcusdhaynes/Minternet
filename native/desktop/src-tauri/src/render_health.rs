//! WebView2 page-health supervision, separate from child-window geometry.
//! Navigation "Finished" and correct Bounds do NOT imply the DOM rendered.
//! All diagnostics are local and contain only numeric tab IDs and failure kinds:
//! never URLs, cookies, entered form text, or screenshot pixels.
#![cfg(windows)]
use std::{collections::HashMap,fs::{self,OpenOptions},io::Write,
 sync::{Mutex,OnceLock},time::{Duration,Instant,SystemTime,UNIX_EPOCH}};
use tauri::Manager;
use webview2_com::Microsoft::Web::WebView2::Win32::{
 COREWEBVIEW2_PROCESS_FAILED_KIND,
 COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
 COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
 COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
 COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED
};
use windows::core::BOOL;

pub fn smoke_stage(stage:&str){
  if !std::env::args().any(|s|s=="--minternet-blank-render-smoke"){return;}
  // Only fixed stage labels and a seven-bit health flag reach this log.
  // Do not record any page text, URL, cookies or account information.
  let path=std::env::temp_dir().join(format!("minternet-blank-stage-{}.txt",std::process::id()));
  if let Ok(mut output)=std::fs::OpenOptions::new().create(true).append(true).open(path){
    let _=writeln!(output,"{stage}");
  }
}

// This runs only in the currently active document, at most twice after a
// finished navigation. It returns a boolean. No DOM text is returned to the
// browser chrome, native logs, or an external service.
// A numeric *bitmask* makes a false result explainable without disclosing
// page content. 1=ready, 2=visible, 4=body exists, 8=no editor, 16=no busy
// indicator, 32=no media/dialog, 64=almost no visible text.
// All seven means the page is genuinely blank and settled. Only a browser
// already verifying the active tab can act on this bitmask.
pub const BLANK_PROBE:&str=r#"(() => {
  try {
    const body=document.body;
    let bits=0;
    if(document.readyState==='complete')bits|=1;
    if(document.visibilityState==='visible')bits|=2;
    if(body)bits|=4;
    const hasUsableEditor=!!document.querySelector(
      'textarea,input:not([type="hidden"]),[contenteditable="true"],[role="textbox"]');
    if(!hasUsableEditor)bits|=8;
    const busy=!!document.querySelector(
      '[role="progressbar"],[aria-busy="true"],progress,.loading,.spinner');
    if(!busy)bits|=16;
    const media=!!document.querySelector('video,canvas,[role="dialog"]');
    if(!media)bits|=32;
    const visibleText=body?(body.innerText||'').trim().length:999;
    if(visibleText<25)bits|=64;
    return bits;
  } catch (_) { return 0; }
})()"#;

// A failed renderer may have already discarded the page. A user-typed or
// playing page must not be destroyed merely because it appears unresponsive.
pub fn recoverable_failure(kind:COREWEBVIEW2_PROCESS_FAILED_KIND)->bool{
    kind==COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED ||
    kind==COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED
}
type Attempt=(String,Instant);
static ATTEMPTS:OnceLock<Mutex<HashMap<u32,Attempt>>>=OnceLock::new();

pub fn claim(id:u32,url:&str)->bool{
    let registry=ATTEMPTS.get_or_init(||Mutex::new(HashMap::new()));
    let Ok(mut map)=registry.lock() else{return false};
    map.retain(|_,(_,when)|when.elapsed()<Duration::from_secs(180));
    if map.get(&id).is_some_and(|(previous,_)|previous==url){
        return false;
    }
    map.insert(id,(url.to_string(),Instant::now()));
    true
}
pub fn record(app:&tauri::AppHandle,id:u32,reason:&str){
    // Fixed allowlisted event names; no URL/selection/form contents. Never
    // touch the WebView2 profile or browser's session/cookie database.
    let accepted=matches!(reason,
      "renderer-exited"|"browser-exited"|"renderer-unresponsive"|
      "gpu-exited"|"navigation-failed"|"blank-document"|"recreated"|
      "recovery-suppressed"|"script-probe-error");
    if !accepted{return;}
    if let Ok(folder)=app.path().app_data_dir(){
        let _=fs::create_dir_all(&folder);
        let filename=folder.join("render-health.log");
        if fs::metadata(&filename).is_ok_and(|info|info.len()>64*1024){
            let _=fs::remove_file(&filename);
        }
        if let Ok(mut file)=OpenOptions::new().append(true).create(true).open(filename){
            let timestamp=SystemTime::now().duration_since(UNIX_EPOCH)
                .map(|d|d.as_secs()).unwrap_or(0);
            let _=writeln!(file,"{timestamp} tab={id} reason={reason}");
        }
    }
}
pub fn schedule_recovery(app:tauri::AppHandle,id:u32,reason:&'static str){
    std::thread::spawn(move||{
        std::thread::sleep(Duration::from_millis(380));
        let task=app.clone();
        let _=app.run_on_main_thread(move||{
            super::recover_stalled_site(&task,id,reason);
        });
    });
}
pub fn attach(app:&tauri::AppHandle,id:u32,view:&tauri::Webview){
    let process_app=app.clone();
    let navigation_app=app.clone();
    let _=view.with_webview(move|native|{
        let Ok(core)=(unsafe{native.controller().CoreWebView2()}) else{return};
        let process_handler=webview2_com::ProcessFailedEventHandler::create(
            Box::new(move|_,args|{
                let Some(args)=args else{return Ok(())};
                let mut kind=COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED;
                if unsafe{args.ProcessFailedKind(&mut kind)}.is_err(){return Ok(());}
                let cause=if kind==COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED{
                    "renderer-exited"
                }else if kind==COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED{
                    "browser-exited"
                }else if kind==COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE{
                    "renderer-unresponsive"
                }else if kind==COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED{
                    "gpu-exited"
                }else{"recovery-suppressed"};
                record(&process_app,id,cause);
                if recoverable_failure(kind){
                    schedule_recovery(process_app.clone(),id,cause);
                }else if kind==COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED{
                    // WebView2 auto-restores its GPU process; notify compositor
                    // but don't discard an otherwise healthy page.
                    let app=process_app.clone();
                    std::thread::spawn(move||{
                        std::thread::sleep(Duration::from_millis(280));
                        let main=app.clone();
                        let _=app.run_on_main_thread(move||
                            super::schedule_surface_restore(&main));
                    });
                }
                Ok(())
            })
        );
        let mut token=0i64;
        let _=unsafe{core.add_ProcessFailed(&process_handler,&mut token)};
        let navigation_handler=webview2_com::NavigationCompletedEventHandler::create(
            Box::new(move|_,args|{
                if let Some(args)=args{
                    let mut success=BOOL::default();
                    if unsafe{args.IsSuccess(&mut success)}.is_ok()&&!success.as_bool(){
                        record(&navigation_app,id,"navigation-failed");
                    }
                }
                Ok(())
            })
        );
        let mut navigation_token=0i64;
        let _=unsafe{core.add_NavigationCompleted(&navigation_handler,&mut navigation_token)};
    });
}
pub fn schedule_blank_probe(app:&tauri::AppHandle,id:u32,expected_url:String){
    let smoke=std::env::args().any(|arg|arg=="--minternet-blank-render-smoke");
    let origin=tauri::Url::parse(&expected_url).ok();
    if !origin.is_some_and(|url|
        url.host_str()==Some("chatgpt.com") ||
        (smoke&&url.host_str()==Some("example.com"))){return;}
    smoke_stage("probe-scheduled");
    let owner=app.clone();
    std::thread::spawn(move||{
        // SPA hydration must have a generous chance. A second probe also
        // catches pages which never reached a useful UI after load.
        for delay in if smoke{vec![1100u64]}else{vec![14000u64,12000]} {
            std::thread::sleep(Duration::from_millis(delay));
            let task=owner.clone();
            let expected=expected_url.clone();
            let _=owner.run_on_main_thread(move||{
                smoke_stage("probe-wait");
                let label={
                    let store=task.state::<Mutex<super::Browser>>();
                    let Ok(browser)=store.lock() else{return};
                    if browser.active_id!=id{smoke_stage("inactive");return;}
                    let Some(tab)=browser.tabs.iter().find(|tab|tab.id==id)else{return};
                    if tab.url!=expected{smoke_stage("url-changed");return;}
                    if tab.loading{smoke_stage("loading");return;}
                    tab.view.clone()
                };
                let Some(label)=label else{smoke_stage("view-missing");return};
                let Some(view)=task.get_webview(&label)else{smoke_stage("view-missing");return};
                let callback=task.clone();
                let address=expected.clone();
                let result=view.eval_with_callback(BLANK_PROBE,move|result|{
                    let flags=result.trim().parse::<u8>().unwrap_or(0);
                    smoke_stage(&format!("probe-flags:{flags}"));
                    if flags!=127{return;}
                    smoke_stage("probe-true");
                    record(&callback,id,"blank-document");
                    // Defer teardown out of the COM ExecuteScript callback.
                    let closer=callback.clone();
                    let recovery_address=address.clone();
                    std::thread::spawn(move||{
                        std::thread::sleep(Duration::from_millis(200));
                        let app=closer.clone();
                        let _=closer.run_on_main_thread(move||{
                            super::recover_stalled_site_if_url(&app,id,&recovery_address,
                                "blank-document");
                        });
                    });
                });
                if result.is_err(){smoke_stage("script-failed");record(&task,id,"script-probe-error");}
            });
        }
    });
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn no_recovery_for_gpu_or_unresponsive_script(){
        assert!(recoverable_failure(COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED));
        assert!(recoverable_failure(COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED));
        assert!(!recoverable_failure(COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED));
        assert!(!recoverable_failure(COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE));
    }
    #[test]fn at_most_one_restart_for_same_tab_url(){
        let id=std::process::id();
        assert!(claim(id,"https://one.example/"));
        assert!(!claim(id,"https://one.example/"));
        assert!(claim(id,"https://two.example/"));
    }
    #[test]fn inspection_cannot_read_page_contents_or_send_a_url(){
        assert!(!BLANK_PROBE.contains("localStorage"));
        assert!(!BLANK_PROBE.contains("document.cookie"));
        assert!(!BLANK_PROBE.contains("fetch("));
        assert!(!BLANK_PROBE.contains("location.reload"));
    }
}
