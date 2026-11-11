// Site-scoped camera/microphone rules and WebView2 device telemetry.
// No website has access to native commands. InPrivate rules stay in RAM.
use std::{collections::HashMap,sync::Mutex};
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use tauri::{AppHandle,Emitter,Manager};

fn ask()->String{"ask".into()}
fn system_default()->String{"default".into()}

#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct SiteMedia {
    #[serde(default="ask")] pub microphone:String,
    #[serde(default="ask")] pub camera:String,
    #[serde(default="system_default")] pub microphone_device:String,
    #[serde(default="system_default")] pub camera_device:String,
    #[serde(default="system_default")] pub speaker_device:String,
}
impl Default for SiteMedia {
    fn default()->Self{Self{microphone:ask(),camera:ask(),microphone_device:system_default(),
        camera_device:system_default(),speaker_device:system_default()}}
}
#[derive(Clone,Default,Serialize)]
#[serde(rename_all="camelCase")]
pub struct TabMedia {
    pub microphone:bool,pub camera:bool,pub speaker:bool,
    pub requested:bool,pub devices:Vec<Value>,
}
#[derive(Default)]
struct Store {
    saved:HashMap<String,SiteMedia>,
    ephemeral:HashMap<(u32,String),SiteMedia>,
    tabs:HashMap<u32,TabMedia>,
    profile_resets:HashMap<u32,String>,
}
#[derive(Default)]
pub struct MediaDeviceState(Mutex<Store>);
fn valid_origin(raw:&str)->Option<String>{
    let url=tauri::Url::parse(raw).ok()?;
    let host=url.host_str()?;
    if url.scheme()!="https" && !(url.scheme()=="http" &&
        matches!(host,"localhost"|"127.0.0.1"|"::1"|"[::1]")){return None;}
    Some(url.origin().ascii_serialization())
}
fn store_path(app:&AppHandle)->Result<std::path::PathBuf,String>{
    Ok(app.path().app_data_dir().map_err(|e|e.to_string())?
        .join("site-media-permissions.v1.json"))
}
pub fn load(app:&AppHandle){
    let Ok(path)=store_path(app) else{return};
    let Ok(bytes)=std::fs::read(path) else{return};
    if bytes.len()>200_000{return;}
    let Ok(saved)=serde_json::from_slice::<HashMap<String,SiteMedia>>(&bytes) else{return};
    if let Ok(mut state)=app.state::<MediaDeviceState>().0.lock(){
        state.saved=saved.into_iter().filter(|(key,_)|
            valid_origin(key).as_deref()==Some(key)).take(200).collect();
    }
}
fn persist(app:&AppHandle)->Result<(),String>{
    let state=app.state::<MediaDeviceState>();
    let guard=state.0.lock().map_err(|e|e.to_string())?;
    let payload=serde_json::to_vec(&guard.saved).map_err(|e|e.to_string())?;
    drop(guard);
    let path=store_path(app)?;
    if let Some(parent)=path.parent(){std::fs::create_dir_all(parent).map_err(|e|e.to_string())?;}
    let temporary=path.with_extension("tmp");
    std::fs::write(&temporary,payload).map_err(|e|e.to_string())?;
    if std::fs::rename(&temporary,&path).is_err(){
        std::fs::copy(&temporary,&path).map_err(|e|e.to_string())?;
        std::fs::remove_file(&temporary).ok();
    }
    Ok(())
}
fn configuration(state:&Store,tab_id:u32,origin:&str,private:bool)->SiteMedia{
    if let Some(rule)=state.ephemeral.get(&(tab_id,origin.to_string())){return rule.clone();}
    if private{SiteMedia::default()}
    else{state.saved.get(origin).cloned().unwrap_or_default()}
}
fn inform(app:&AppHandle,tab_id:u32){
    let _=app.emit_to("chrome","minternet:media-devices",json!({"tabId":tab_id}));
}
pub fn speaker_disabled(app:&AppHandle,id:u32)->bool{
    let (address,private)={
        let browser=app.state::<Mutex<super::Browser>>();
        let Ok(state)=browser.lock() else{return false};
        let Some(tab)=state.tabs.iter().find(|t|t.id==id)else{return false};
        (tab.url.clone(),tab.private)
    };
    let Some(origin)=valid_origin(&address)else{return false};
    let storage=app.state::<MediaDeviceState>();
    let Ok(state)=storage.0.lock()else{return false};
    configuration(&state,id,&origin,private).speaker_device=="disabled"
}
pub fn reset_tab(app:&AppHandle,id:u32){
    if let Ok(mut store)=app.state::<MediaDeviceState>().0.lock(){
        store.tabs.remove(&id);
    }
    inform(app,id);
}
pub fn close_tab(app:&AppHandle,id:u32){
    if let Ok(mut store)=app.state::<MediaDeviceState>().0.lock(){
        store.tabs.remove(&id);
        store.ephemeral.retain(|(tab, _),_|*tab!=id);
        store.profile_resets.remove(&id);
    }
    inform(app,id);
}
fn snapshot(app:&AppHandle,id:u32,origin:&str,private:bool)->Value{
    let storage=app.state::<MediaDeviceState>();
    let Ok(state)=storage.0.lock()else{return json!({})};
    let settings=configuration(&state,id,origin,private);
    let status=state.tabs.get(&id).cloned().unwrap_or_default();
    let sites=if private{Vec::new()}else{
        state.saved.iter().take(200).map(|(host,rules)|
            json!({"origin":host,"microphone":rules.microphone,"camera":rules.camera}))
            .collect::<Vec<Value>>()
    };
    json!({"tabId":id,"origin":origin,"private":private,"settings":settings,
        "status":status,"sites":sites})
}
fn permission_valid(input:&str)->bool{
    matches!(input,"ask"|"once"|"session"|"allow"|"block")
}
fn device_valid(input:&str,list:&[Value],kind:&str)->bool{
    input=="disabled"||input=="default"||
    input.len()<=256&&list.iter().any(|v|v.get("kind").and_then(Value::as_str)==Some(kind)
        &&v.get("id").and_then(Value::as_str)==Some(input))
}
pub fn action(app:&AppHandle,name:&str,value:&Value,id:u32,
    origin:&str,private:bool)->Result<Value,String>{
    let origin=valid_origin(origin).ok_or("Open a secure HTTPS site first")?;
    if name=="site-media-get"{return Ok(snapshot(app,id,&origin,private));}
    if !matches!(name,"site-media-set"|"site-media-revoke"){
        return Err("Unsupported media command".into());
    }
    let storage=app.state::<MediaDeviceState>();
    let mut state=storage.0.lock().map_err(|e|e.to_string())?;
    let mut settings=configuration(&state,id,&origin,private);
    let field=value.get("field").and_then(Value::as_str).unwrap_or("");
    let requested=value.get("value").and_then(Value::as_str).unwrap_or("");
    let mut stop=false;
    match name{
        "site-media-revoke"=>{
            settings.microphone=ask();settings.camera=ask();
            settings.microphone_device="disabled".into();
            settings.camera_device="disabled".into();
            stop=true;
        },
        "site-media-set"=>match field{
            "microphone"|"camera"=>{
                if !permission_valid(requested){return Err("Unknown permission rule".into());}
                if field=="microphone"{settings.microphone=requested.into();}
                else{settings.camera=requested.into();}
                if requested=="block"||requested=="ask"{stop=true;}
            },
            "microphoneDevice"|"cameraDevice"|"speakerDevice"=>{
                let kind=match field{"microphoneDevice"=>"audioinput",
                    "cameraDevice"=>"videoinput",_=>"audiooutput"};
                let choices=state.tabs.get(&id).map(|v|v.devices.as_slice()).unwrap_or(&[]);
                if !device_valid(requested,choices,kind){
                    return Err("Choose a detected device or Disabled".into());
                }
                match field{
                    "microphoneDevice"=>{settings.microphone_device=requested.into();stop=true;},
                    "cameraDevice"=>{settings.camera_device=requested.into();stop=true;},
                    _=>settings.speaker_device=requested.into()
                }
            },
            _=>return Err("Unsupported setting".into()),
        },
        _=>unreachable!()
    }
    let had_ephemeral=state.ephemeral.contains_key(&(id,origin.clone()));
    // Changing an input device must not silently turn a session grant into a
    // permanent grant. A new explicit permission choice replaces the scope.
    let explicit_rule=matches!(field,"microphone"|"camera");
    let ephemeral=private||matches!(requested,"once"|"session")||
        had_ephemeral&&!explicit_rule&&name!="site-media-revoke";
    if ephemeral{
        state.ephemeral.insert((id,origin.clone()),settings.clone());
    }else{
        state.ephemeral.remove(&(id,origin.clone()));
        state.saved.insert(origin.clone(),settings.clone());
    }
    if stop {
        if let Some(tab)=state.tabs.get_mut(&id){
            tab.microphone=false;tab.camera=false;
        }
    }
    drop(state);
    if !ephemeral{persist(app)?;}
    if let Some(webview)=app.get_webview(&format!("tab-{id}")){
        if stop{let _=webview.eval("window.__minternetMediaStop?.();");}
        if let Ok(encoded)=serde_json::to_string(&settings){
            let _=webview.eval(&format!("window.__minternetMediaApply?.({encoded});"));
        }
    }
    if let Some(view)=app.get_webview(&format!("tab-{id}")){
        // Native WebView2 mute also covers WebAudio/AudioContexts, not merely
        // HTMLMediaElement.sinkId used by individual web applications.
        super::apply_volume_to_site(app,id,view.label(),false);
    }
    #[cfg(windows)]
    if matches!(field,"microphone"|"camera")||name=="site-media-revoke"{
        clear_webview2_profile(app,id,&origin);
    }
    inform(app,id);
    Ok(snapshot(app,id,&origin,private))
}
pub fn apply(app:&AppHandle,id:u32,raw:&str,private:bool){
    let Some(origin)=valid_origin(raw)else{return};
    let state=app.state::<MediaDeviceState>();
    let config=state.0.lock().ok().map(|s|configuration(&s,id,&origin,private))
        .unwrap_or_default();
    if let Some(webview)=app.get_webview(&format!("tab-{id}")){
        if let Ok(text)=serde_json::to_string(&config){
            let _=webview.eval(&format!("window.__minternetMediaApply?.({text});"));
        }
    }
}
#[cfg(windows)]
fn from_wide(value:windows::core::PWSTR)->String{
    let text=unsafe{value.to_string().unwrap_or_default()};
    if !value.is_null(){
        unsafe{windows::Win32::System::Com::CoTaskMemFree(Some(value.0 as *const _));}
    }
    text
}
#[cfg(windows)]
fn permission_requested(app:&AppHandle,id:u32,private:bool,origin:&str,
    kind:&str)->&'static str{
    let state=app.state::<MediaDeviceState>();
    let Ok(mut store)=state.0.lock()else{return "ask"};
    store.tabs.entry(id).or_default().requested=true;
    let current=configuration(&store,id,origin,private);
    let disabled=if kind=="microphone"{current.microphone_device=="disabled"}
        else{current.camera_device=="disabled"};
    let rule=if kind=="microphone"{current.microphone.as_str()}
        else{current.camera.as_str()};
    let decision=if disabled{"block"}
        else if rule=="allow"||rule=="session"{"allow"}
        else if rule=="block"{"block"}
        else if rule=="once"{"allow-once"}
        else{"ask"};
    if decision=="allow-once"{
        let mut next=current;
        if kind=="microphone"{next.microphone="ask".into();}
        else{next.camera="ask".into();}
        store.ephemeral.insert((id,origin.to_string()),next);
    }
    drop(store);
    inform(app,id);
    decision
}
// A persistent WebView2 decision from an earlier Minternet build can bypass
// all new handlers. Reset mic/camera state in the profile on configuration
// changes, allowing the new origin-scoped handler to take effect.
#[cfg(windows)]
pub fn reset_old_denials(app:&AppHandle,id:u32,address:&str){
    let Some(origin)=valid_origin(address)else{return};
    let should_reset={
        let store=app.state::<MediaDeviceState>();
        let Ok(mut state)=store.0.lock()else{return};
        if state.profile_resets.get(&id).is_some_and(|s|s==&origin){false}
        else {state.profile_resets.insert(id,origin.clone());true}
    };
    if should_reset{clear_webview2_profile(app,id,&origin);}
}
#[cfg(windows)]
pub fn clear_webview2_profile(app:&AppHandle,id:u32,origin:&str){
    use windows::core::{Interface,PCWSTR};
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    let Some(webview)=app.get_webview(&format!("tab-{id}"))else{return};
    let Some(origin)=valid_origin(origin)else{return};
    let _=webview.with_webview(move|native|{
        let Ok(core)=(unsafe{native.controller().CoreWebView2()})else{return};
        let Ok(rev13)=core.cast::<ICoreWebView2_13>()else{return};
        let Ok(profile)=(unsafe{rev13.Profile()})else{return};
        let Ok(p4)=profile.cast::<ICoreWebView2Profile4>()else{return};
        let wide=origin.encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
        for kind in [COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
            COREWEBVIEW2_PERMISSION_KIND_CAMERA]{
            let handler=webview2_com::SetPermissionStateCompletedHandler::create(
                Box::new(|_|Ok(())));
            let _=unsafe{p4.SetPermissionState(kind,PCWSTR(wide.as_ptr()),
                COREWEBVIEW2_PERMISSION_STATE_DEFAULT,&handler)};
        }
    });
}
#[cfg(windows)]
pub fn set_tab_output(app:&AppHandle,id:u32,mute:bool){
    use windows::core::Interface;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
    let Some(webview)=app.get_webview(&format!("tab-{id}"))else{return};
    let _=webview.with_webview(move|native|{
        let Ok(core)=(unsafe{native.controller().CoreWebView2()})else{return};
        let Ok(v8)=core.cast::<ICoreWebView2_8>()else{return};
        let _=unsafe{v8.SetIsMuted(mute)};
    });
}
#[cfg(windows)]
pub fn attach(app:&AppHandle,id:u32,view:&tauri::Webview,private:bool){
    use windows::core::{Interface,PWSTR};
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    let requested_app=app.clone();
    let telemetry_app=app.clone();
    let _=view.with_webview(move|native|{
        let Ok(core)=(unsafe{native.controller().CoreWebView2()})else{return};
        // WebView2 passes the ACTUAL requesting frame URI, unlike the Tauri
        // generic permission callback which only supplies a permission kind.
        let permission=webview2_com::PermissionRequestedEventHandler::create(
            Box::new(move|_,args|{
                let Some(args)=args else{return Ok(())};
                let mut kind=COREWEBVIEW2_PERMISSION_KIND::default();
                if unsafe{args.PermissionKind(&mut kind)}.is_err(){return Ok(());}
                let label=if kind==COREWEBVIEW2_PERMISSION_KIND_MICROPHONE{"microphone"}
                    else if kind==COREWEBVIEW2_PERMISSION_KIND_CAMERA{"camera"}
                    else{return Ok(())};
                let mut wide=PWSTR::null();
                if unsafe{args.Uri(&mut wide)}.is_err(){return Ok(());}
                let uri=from_wide(wide);
                let Some(origin)=valid_origin(&uri)else{
                    let _=unsafe{args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)};
                    return Ok(());
                };
                if let Ok(advanced)=args.cast::<ICoreWebView2PermissionRequestedEventArgs3>(){
                    let _=unsafe{advanced.SetSavesInProfile(false)};
                }
                let rule=permission_requested(&requested_app,id,private,&origin,label);
                let answer=match rule{
                    "block"=>Some(COREWEBVIEW2_PERMISSION_STATE_DENY),
                    "allow"|"allow-once"=>Some(COREWEBVIEW2_PERMISSION_STATE_ALLOW),
                    _=>None,
                };
                if let Some(answer)=answer{let _=unsafe{args.SetState(answer)};}
                Ok(())
            }));
        let mut token=0i64;
        let _=unsafe{core.add_PermissionRequested(&permission,&mut token)};

        let received=webview2_com::WebMessageReceivedEventHandler::create(
            Box::new(move|_,args|{
                let Some(args)=args else{return Ok(())};
                let mut data=PWSTR::null();
                if unsafe{args.WebMessageAsJson(&mut data)}.is_err(){return Ok(());}
                let payload=from_wide(data);
                if payload.len()>22000{return Ok(());}
                let Ok(message)=serde_json::from_str::<Value>(&payload)else{return Ok(())};
                if message.get("minternetMedia").and_then(Value::as_i64)!=Some(1){
                    return Ok(());
                }
                let mut sender=PWSTR::null();
                if unsafe{args.Source(&mut sender)}.is_err(){return Ok(());}
                let from=valid_origin(&from_wide(sender));
                let top=telemetry_app.get_webview(&format!("tab-{id}")).and_then(|v|
                    v.url().ok()).and_then(|u|valid_origin(u.as_str()));
                if from.is_none()||from!=top{return Ok(());}
                let kind=message.get("kind").and_then(Value::as_str).unwrap_or("");
                let state=telemetry_app.state::<MediaDeviceState>();
                let Ok(mut store)=state.0.lock()else{return Ok(())};
                let status=store.tabs.entry(id).or_default();
                match kind{
                    "state"=>{
                        status.microphone=message.get("microphone").and_then(Value::as_bool)
                            .unwrap_or(false);
                        status.camera=message.get("camera").and_then(Value::as_bool)
                            .unwrap_or(false);
                        status.speaker=message.get("speaker").and_then(Value::as_bool)
                            .unwrap_or(false);
                        if status.microphone||status.camera{status.requested=false;}
                    },
                    "devices"=>{
                        if let Some(rows)=message.get("devices").and_then(Value::as_array){
                            status.devices=rows.iter().take(48).filter_map(|row|{
                                let kind=row.get("kind")?.as_str()?;
                                if !matches!(kind,"audioinput"|"videoinput"|"audiooutput"){return None;}
                                Some(json!({"kind":kind,
                                    "id":row.get("id").and_then(Value::as_str).unwrap_or("")
                                        .chars().take(256).collect::<String>(),
                                    "label":row.get("label").and_then(Value::as_str)
                                        .unwrap_or("").chars().take(100).collect::<String>()}))
                            }).collect();
                        }
                    },
                    "request-failed"=>status.requested=true,
                    _=>return Ok(()),
                }
                drop(store);
                inform(&telemetry_app,id);
                Ok(())
            }));
        let mut message_token=0i64;
        let _=unsafe{core.add_WebMessageReceived(&received,&mut message_token)};
    });
}
#[cfg(not(windows))]
pub fn attach(_app:&AppHandle,_id:u32,_view:&tauri::Webview,_private:bool){}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn origins_and_defaults_are_restricted(){
        assert_eq!(valid_origin("https://example.com/media?a=1").as_deref(),
            Some("https://example.com"));
        assert!(valid_origin("http://example.com").is_none());
        assert!(valid_origin("file:///C:/video").is_none());
        assert_eq!(SiteMedia::default().microphone,"ask");
        assert_eq!(SiteMedia::default().camera_device,"default");
        assert!(permission_valid("session")&&permission_valid("once"));
        assert!(!permission_valid("always-maybe"));
    }
}
