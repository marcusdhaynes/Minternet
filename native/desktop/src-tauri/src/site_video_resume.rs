// Persist ONLY a local video path the user selected in MarmaladePlayer.
// The browser never accepts an arbitrary path supplied by JavaScript and
// never exposes the saved path as text to any web origin.
#[cfg(windows)]
mod windows_resume {
    use std::{fs,path::{Path,PathBuf}};
    use serde_json::{json,Value};
    use tauri::{AppHandle,Manager};
    use windows::core::{Interface,IUnknown,PWSTR,PCWSTR};
    use windows::Win32::System::Com::CoTaskMemFree;
    use webview2_com::{WebMessageReceivedEventHandler,
        Microsoft::Web::WebView2::Win32::{
            ICoreWebView2,ICoreWebView2_23,ICoreWebView2Environment14,
            ICoreWebView2WebMessageReceivedEventArgs2,
            ICoreWebView2FileSystemHandle,ICoreWebView2File,
            ICoreWebView2ObjectCollection,ICoreWebView2ObjectCollectionView,
            COREWEBVIEW2_FILE_SYSTEM_HANDLE_PERMISSION_READ_ONLY,
            COREWEBVIEW2_FILE_SYSTEM_HANDLE_KIND,
            COREWEBVIEW2_FILE_SYSTEM_HANDLE_KIND_FILE,
        }};
    const TRUSTED_ORIGIN:&str="https://marcusdhaynes.github.io";
    const TRUSTED_PATH:&str="/MarmaladePlayer";
    pub(super) fn trusted(url:&str)->bool {
        let Ok(u)=tauri::Url::parse(url) else{return false};
        if u.origin().ascii_serialization()!=TRUSTED_ORIGIN{return false;}
        let path=u.path();
        path==TRUSTED_PATH || path==format!("{TRUSTED_PATH}/") ||
            path.starts_with(&format!("{TRUSTED_PATH}/"))
    }
    fn media_file(path:&Path)->bool{
        path.is_absolute() && path.extension().and_then(|e|e.to_str())
            .map(|ext|matches!(ext.to_ascii_lowercase().as_str(),
                 "mp4"|"m4v"|"mkv"|"mov"|"webm"|"avi"|"mpg"|"mpeg"|"ogg"|"ogv"|"ts"))
            .unwrap_or(false)
    }
    fn store_path(app:&AppHandle)->Option<PathBuf>{
        Some(app.path().app_data_dir().ok()?.join("marmalade-selected-video.v1.json"))
    }
    fn persist(app:&AppHandle,filename:&Path){
        if !media_file(filename)||!filename.is_file(){return;}
        let Ok(canonical)=fs::canonicalize(filename) else{return};
        if !media_file(&canonical){return;}
        let Some(storage)=store_path(app)else{return};
        if let Some(parent)=storage.parent(){if fs::create_dir_all(parent).is_err(){return;}}
        let value=json!({"version":1,"path":canonical.to_string_lossy()});
        let temp=storage.with_extension("tmp");
        if fs::write(&temp,value.to_string()).is_ok(){
            if fs::rename(&temp,&storage).is_err(){
                let _=fs::copy(&temp,&storage);
                let _=fs::remove_file(&temp);
            }
        }
    }
    fn remembered(app:&AppHandle)->Option<PathBuf>{
        let file=store_path(app)?;
        let bytes=fs::read(file).ok()?;
        if bytes.len()>8192{return None;}
        let value:Value=serde_json::from_slice(&bytes).ok()?;
        if value.get("version")?.as_i64()!=Some(1){return None;}
        let path=PathBuf::from(value.get("path")?.as_str()?);
        if !media_file(&path){return None;}
        Some(path)
    }
    fn utf16(value:&str)->Vec<u16>{
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }
    unsafe fn free_string(ptr:PWSTR)->String{
        if ptr.is_null(){return String::new();}
        let output=ptr.to_string().unwrap_or_default();
        CoTaskMemFree(Some(ptr.0.cast()));
        output
    }
    fn send(core:&ICoreWebView2,message:Value){
        let bytes=utf16(&message.to_string());
        let _=unsafe{core.PostWebMessageAsJson(PCWSTR(bytes.as_ptr()))};
    }
    fn selected_path(args:&webview2_com::Microsoft::Web::WebView2::Win32::
        ICoreWebView2WebMessageReceivedEventArgs)->Option<PathBuf>{
        let extended=args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>().ok()?;
        let objects=unsafe{extended.AdditionalObjects()}.ok()?;
        let mut count=0u32;
        unsafe{objects.Count(&mut count)}.ok()?;
        if count!=1{return None;}
        let value=unsafe{objects.GetValueAtIndex(0)}.ok()?;
        let mut ptr=PWSTR::null();
        if let Ok(handle)=value.cast::<ICoreWebView2FileSystemHandle>(){
            let mut kind=COREWEBVIEW2_FILE_SYSTEM_HANDLE_KIND_FILE;
            unsafe{handle.Kind(&mut kind)}.ok()?;
            if kind!=COREWEBVIEW2_FILE_SYSTEM_HANDLE_KIND_FILE{return None;}
            unsafe{handle.Path(&mut ptr)}.ok()?;
        } else if let Ok(file)=value.cast::<ICoreWebView2File>(){
            unsafe{file.Path(&mut ptr)}.ok()?;
        } else{return None;}
        let path=unsafe{free_string(ptr)};
        if path.len()>4096{return None;}
        let output=PathBuf::from(path);
        if media_file(&output)&&output.is_file(){Some(output)}else{None}
    }
    fn send_handle(core:&ICoreWebView2,
                   environment:&ICoreWebView2Environment14,
                   path:&Path)->Result<(),String>{
        if !path.is_file(){return Err("missing".into());}
        let canonical=fs::canonicalize(path).map_err(|_|"missing")?;
        if !media_file(&canonical){return Err("missing".into());}
        // Confirm the page has not navigated since the approved request.
        let mut current=PWSTR::null();
        unsafe{core.Source(&mut current)}.map_err(|e|e.to_string())?;
        if !trusted(&unsafe{free_string(current)}){return Err("untrusted".into());}
        let path=canonical.to_string_lossy();
        let wide=utf16(&path);
        let handle=unsafe{environment.CreateWebFileSystemFileHandle(
            PCWSTR(wide.as_ptr()),COREWEBVIEW2_FILE_SYSTEM_HANDLE_PERMISSION_READ_ONLY
        )}.map_err(|e|e.to_string())?;
        let mut object:Option<IUnknown>=Some(handle.cast().map_err(|e|e.to_string())?);
        let mut list:Option<ICoreWebView2ObjectCollection>=None;
        unsafe{environment.CreateObjectCollection(1,&mut object,&mut list)}
            .map_err(|e|e.to_string())?;
        let view:ICoreWebView2ObjectCollectionView=list
            .ok_or("Missing file handle collection")?
            .cast().map_err(|e|e.to_string())?;
        let advanced=core.cast::<ICoreWebView2_23>().map_err(|e|e.to_string())?;
        let result=utf16(r#"{"minternetMarmalade":"resume-result","status":"ok"}"#);
        unsafe{advanced.PostWebMessageAsJsonWithAdditionalObjects(
            PCWSTR(result.as_ptr()),&view
        )}.map_err(|e|e.to_string())
    }
    pub fn attach(app:&AppHandle,id:u32,view:&tauri::Webview,private:bool){
        if private{return;} // Private tabs never persist file paths.
        let app=app.clone();
        let _=view.with_webview(move|native|{
            let Ok(core)=(unsafe{native.controller().CoreWebView2()})else{return};
            let Ok(env)=native.environment().cast::<ICoreWebView2Environment14>()
                else{return};
            let handler=WebMessageReceivedEventHandler::create(Box::new(
                move |sender,args|{
                    let Some(args)=args else{return Ok(())};
                    let Some(sender)=sender else{return Ok(())};
                    let mut raw=PWSTR::null();
                    if unsafe{args.WebMessageAsJson(&mut raw)}.is_err(){return Ok(());}
                    let value=unsafe{free_string(raw)};
                    if value.len()>1200{return Ok(());}
                    let Ok(message)=serde_json::from_str::<Value>(&value)
                        else{return Ok(())};
                    let mode=message.get("minternetMarmalade")
                        .and_then(Value::as_str).unwrap_or("");
                    if !matches!(mode,"remember"|"recover"|"resume"){return Ok(());}
                    let mut source=PWSTR::null();
                    if unsafe{args.Source(&mut source)}.is_err(){return Ok(());}
                    if !trusted(&unsafe{free_string(source)}){return Ok(());}
                    let current=app.get_webview(&format!("tab-{id}"))
                        .and_then(|view|view.url().ok()).map(|url|url.to_string());
                    if !current.as_deref().is_some_and(trusted){return Ok(());}
                    let path=if mode=="remember"||mode=="recover"{
                        let path=selected_path(&args);
                        if let Some(file)=path.as_ref(){persist(&app,file);}
                        if mode=="remember"{return Ok(());}
                        path.or_else(||remembered(&app))
                    }else{remembered(&app)};
                    let Some(path)=path else{
                        send(&sender,json!({"minternetMarmalade":"resume-result",
                           "status":"unavailable"}));
                        return Ok(());
                    };
                    if !path.is_file(){
                        send(&sender,json!({"minternetMarmalade":"resume-result",
                           "status":"missing"}));
                        return Ok(());
                    }
                    if let Err(err)=send_handle(&sender,&env,&path){
                        let status=if err=="missing"{"missing"}else{"error"};
                        send(&sender,json!({"minternetMarmalade":"resume-result",
                           "status":status}));
                    }
                    Ok(())
                }
            ));
            let mut token=0i64;
            let _=unsafe{core.add_WebMessageReceived(&handler,&mut token)};
        });
    }
    #[cfg(test)]
    mod tests{
        use super::*;
        #[test]
        fn only_marmalade_page_can_receive_native_files(){
            assert!(trusted("https://marcusdhaynes.github.io/MarmaladePlayer/"));
            assert!(trusted("https://marcusdhaynes.github.io/MarmaladePlayer/index.html"));
            assert!(!trusted("https://marcusdhaynes.github.io/OtherApp/"));
            assert!(!trusted("http://marcusdhaynes.github.io/MarmaladePlayer/"));
            assert!(!trusted("https://fake.example/MarmaladePlayer/"));
            assert!(!trusted("https://marcusdhaynes.github.io/MarmaladePlayer2/"));
        }
        #[test]
        fn only_media_paths_allowed(){
            assert!(!media_file(Path::new("relative.mp4")));
            assert!(!media_file(Path::new("C:\\temp\\passwords.csv")));
        }
    }
}
#[cfg(windows)]
pub use windows_resume::attach;
#[cfg(not(windows))]
pub fn attach(_app:&tauri::AppHandle,_id:u32,_view:&tauri::Webview,_private:bool){}
