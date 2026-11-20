//! Minternet local-only media server. Binds loopback, token-gated, never exposes paths.
//! Intended exclusively for the explicitly supported Marmaladeum origins.
use std::{io::{Read,Write},net::{TcpListener,TcpStream},sync::{OnceLock,Mutex},
    collections::HashMap,thread,time::Duration,path::Path};
use serde_json::{json,Value};
use rand::{rngs::OsRng,RngCore};
use tauri::Manager;

const PORT:u16=18761;
static SECRET:OnceLock<String>=OnceLock::new();
// Pickers complete asynchronously on the native UI side. A per-request status
// replaces guessing whether a library count increment happened between fetches.
static PICKERS:OnceLock<Mutex<HashMap<String,Value>>>=OnceLock::new();
fn pickers()->&'static Mutex<HashMap<String,Value>>{
    PICKERS.get_or_init(||Mutex::new(HashMap::new()))
}
fn valid_request_id(id:&str)->bool{
    (8..=80).contains(&id.len())&&id.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'-')
}
pub fn begin_picker(id:&str){
    if !valid_request_id(id){return;}
    if let Ok(mut statuses)=pickers().lock(){
        if statuses.len()>=100{statuses.clear();}
        statuses.insert(id.into(),json!({"state":"pending"}));
    }
}
pub fn finish_picker(id:&str,state:&str,message:&str){
    if !valid_request_id(id){return;}
    if let Ok(mut statuses)=pickers().lock(){
        statuses.insert(id.into(),json!({"state":state,"message":message}));
    }
}
fn token()->&'static str {
    SECRET.get_or_init(||{
        let mut bytes=[0u8;32]; OsRng.fill_bytes(&mut bytes);
        bytes.iter().map(|b|format!("{b:02x}")).collect()
    })
}
fn allowed(origin:&str)->bool {
    origin=="https://marmaladeum.com" ||
    origin=="https://www.marmaladeum.com" ||
    origin=="https://marcusdhaynes.github.io"
}
fn cors(origin:&str)->String {
    if allowed(origin){format!("Access-Control-Allow-Origin: {origin}\r\nVary: Origin\r\nAccess-Control-Allow-Private-Network: true\r\nAccess-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n")}
    else {String::new()}
}
fn reply(stream:&mut TcpStream,status:&str,content_type:&str,body:&[u8],extra:&str,origin:&str) {
    let headers=format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n{}{}\r\n",body.len(),cors(origin),extra);
    let _=stream.write_all(headers.as_bytes());let _=stream.write_all(body);
}
fn mime(path:&Path)->&'static str {
    match path.extension().and_then(|x|x.to_str()).unwrap_or("").to_lowercase().as_str(){
        "mp4"|"m4v"=>"video/mp4","webm"=>"video/webm","ogv"=>"video/ogg",
        "mov"=>"video/quicktime","mkv"=>"video/x-matroska","avi"=>"video/x-msvideo",
        "mpg"|"mpeg"=>"video/mpeg","ts"=>"video/mp2t",_=>"application/octet-stream"
    }
}
fn handle(mut stream:TcpStream,app:&tauri::AppHandle){
    let _=stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _=stream.set_write_timeout(Some(Duration::from_secs(25)));
    let mut buf=[0u8;16384];
    let Ok(size)=stream.read(&mut buf) else{return};
    if size==0{return;}
    let mut request_bytes=buf[..size].to_vec();
    let mut header_end=request_bytes.windows(4).position(|w|w==b"\r\n\r\n");
    while header_end.is_none()&&request_bytes.len()<16384 {
        let Ok(n)=stream.read(&mut buf) else{return};
        if n==0{return;}
        request_bytes.extend_from_slice(&buf[..n]);
        header_end=request_bytes.windows(4).position(|w|w==b"\r\n\r\n");
    }
    let Some(end)=header_end else{return};
    let request=String::from_utf8_lossy(&request_bytes[..end]);
    let mut lines=request.split("\r\n");
    let Some(first)=lines.next() else{return};
    let mut pieces=first.split_whitespace();
    let method=pieces.next().unwrap_or("");
    let target=pieces.next().unwrap_or("");
    let mut origin="";
    let mut range="";
    let mut content_length=0usize;
    for line in lines {
        if line.is_empty(){break;}
        // Header names are case-insensitive per HTTP; browser fetch headers
        // are commonly lower-case ("content-length"), unlike manual curl.
        if let Some((name,value))=line.split_once(':'){
            let value=value.trim();
            if name.eq_ignore_ascii_case("origin"){origin=value;}
            if name.eq_ignore_ascii_case("range"){range=value;}
            if name.eq_ignore_ascii_case("content-length"){
                content_length=value.parse().unwrap_or(usize::MAX);
            }
        }
    }
    if method=="OPTIONS" {
        if allowed(origin){
            reply(&mut stream,"204 No Content","text/plain",&[],
                "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Range, Content-Type\r\nAccess-Control-Max-Age: 600\r\n",origin);
        }else{reply(&mut stream,"403 Forbidden","text/plain",b"Forbidden","",origin);}
        return;
    }
    if !matches!(method,"GET"|"POST") || !allowed(origin){
        reply(&mut stream,"403 Forbidden","text/plain",b"Forbidden","",origin);return;
    }
    let (path,query)=target.split_once('?').unwrap_or((target,""));
    if !query.split('&').any(|p|p.strip_prefix("key=")==Some(token())){
        reply(&mut stream,"403 Forbidden","text/plain",b"Forbidden","",origin);return;
    }
    if path=="/picker"&&method=="GET"{
        let id=query.split('&').find_map(|p|p.strip_prefix("requestId=")).unwrap_or("");
        let value=if valid_request_id(id) {
            pickers().lock().ok().and_then(|mut map|{
                let result=map.get(id).cloned();
                if result.as_ref().and_then(|v|v.get("state")).and_then(Value::as_str)
                    .is_some_and(|state|state!="pending"){map.remove(id);}
                result
            })
        }else{None};
        let result=value.unwrap_or_else(||json!({"state":"unknown"}));
        let bytes=result.to_string();
        reply(&mut stream,"200 OK","application/json",bytes.as_bytes(),"",origin);
        return;
    }
    let state=app.state::<std::sync::Mutex<super::media_library::MediaLibrary>>();
    let Ok(mut lib)=state.lock() else{return};
    // All mutations require an explicit CORS-approved POST plus an unguessable
    // in-process token. Page JavaScript can never pass arbitrary file paths.
    if method=="POST" && path=="/manage" {
        if content_length==0||content_length>48*1024 {
            reply(&mut stream,"413 Payload Too Large","text/plain",b"Invalid request","",origin);return;
        }
        let mut body=request_bytes[end+4..].to_vec();
        while body.len()<content_length {
            let need=(content_length-body.len()).min(buf.len());
            let Ok(n)=stream.read(&mut buf[..need]) else{return};
            if n==0{return;}
            body.extend_from_slice(&buf[..n]);
        }
        let Ok(payload)=serde_json::from_slice::<Value>(&body[..content_length]) else{
            reply(&mut stream,"400 Bad Request","text/plain",b"Malformed JSON","",origin);return;
        };
        let action=payload.get("action").and_then(Value::as_str).unwrap_or("");
        let result:Result<Value,String>=(||{
            match action {
                "saveLibrary"=>{
                    let id=payload.get("id").and_then(Value::as_str);
                    let name=payload.get("name").and_then(Value::as_str).ok_or("Library name required")?;
                    let kind=payload.get("kind").and_then(Value::as_str).unwrap_or("movie");
                    let id=lib.create_or_update_collection(id,name,kind)?;
                    Ok(json!({"id":id}))
                },
                "deleteLibrary"=>{
                    let id=payload.get("id").and_then(Value::as_str).ok_or("Library ID required")?;
                    lib.remove_collection(id)?;
                    Ok(json!({"deleted":true}))
                },
                "removeFolder"=>{
                    let id=payload.get("folderId").and_then(Value::as_str).ok_or("Folder ID required")?;
                    let library_id=payload.get("libraryId").and_then(Value::as_str).ok_or("Library ID required")?;
                    if !lib.collections.iter().any(|c|c.id==library_id&&c.folder_ids.contains(&id.to_string())){
                        return Err("Folder does not belong to the selected library".into());
                    }
                    lib.remove_folder(id);
                    Ok(json!({"removed":true}))
                },
                "updateItem"=>{
                    let library_id=payload.get("libraryId").and_then(Value::as_str).ok_or("Library ID required")?;
                    let item_id=payload.get("itemId").and_then(Value::as_str).ok_or("Item ID required")?;
                    let changes=payload.get("changes").cloned().ok_or("Changes required")?;
                    lib.update_item(library_id,item_id,changes)?;
                    Ok(json!({"updated":true}))
                },
                "rescan"=>{
                    lib.rescan_all();
                    Ok(json!({"count":lib.items.len()}))
                },
                _=>Err("Unknown media-library command".into()),
            }
        })();
        let response=result.and_then(|v|lib.save(app).map(|_|v));
        match response {
            Ok(value)=>{let body=json!({"ok":true,"result":value}).to_string();
                reply(&mut stream,"200 OK","application/json",body.as_bytes(),"",origin);}
            Err(message)=>{let body=json!({"ok":false,"error":message}).to_string();
                reply(&mut stream,"400 Bad Request","application/json",body.as_bytes(),"",origin);}
        }
        return;
    }
    if method!="GET" {
        reply(&mut stream,"405 Method Not Allowed","text/plain",b"Method not allowed","",origin);return;
    }
    if path=="/rescan" {
        lib.rescan_all();
        let saved=lib.save(app).is_ok();
        let body=json!({"ok":saved,"count":lib.items.len(),"lastScan":lib.last_scan}).to_string();
        reply(&mut stream,if saved{"200 OK"}else{"500 Internal Server Error"},
            "application/json",body.as_bytes(),"",origin);
        return;
    }
    if path=="/catalog" {
        let libraries=lib.collections.iter().map(|collection|{
            let ids=&collection.folder_ids;
            let items=lib.items.iter().enumerate().filter(|(_,item)|
                ids.contains(&item.folder_id)&&!collection.hidden_ids.contains(&item.id))
                .map(|(index,item)|{
                    let mut v=serde_json::to_value(item).unwrap_or(Value::Null);
                    if let Some(o)=v.as_object_mut(){
                        if let Some(changes)=lib.overrides.get(&item.id).and_then(Value::as_object){
                            for (key,value) in changes{o.insert(key.clone(),value.clone());}
                        }
                        o.insert("url".into(),json!(format!("http://127.0.0.1:{PORT}/video/{index}?key={}",token())));
                    }
                    v
                }).collect::<Vec<_>>();
            json!({"id":collection.id,"name":collection.name,"kind":collection.kind,
                "hiddenIds":collection.hidden_ids,
                "folders":lib.folders.iter().filter(|f|ids.contains(&f.id))
                    .map(|f|json!({"id":f.id,"name":f.name})).collect::<Vec<_>>(),
                "items":items,"lastScan":lib.last_scan})
        }).collect::<Vec<_>>();
        let body=json!({"libraries":libraries}).to_string();
        reply(&mut stream,"200 OK","application/json",body.as_bytes(),"",origin);return;
    }
    if let Some(id)=path.strip_prefix("/video/"){
        let Some(index)=id.parse::<usize>().ok() else{return};
        let Some(item)=lib.items.get(index) else{
            reply(&mut stream,"404 Not Found","text/plain",b"Not Found","",origin);return;
        };
        let Some(folder)=lib.folders.iter().find(|f|f.id==item.folder_id) else{return};
        let root=Path::new(&folder.path);
        let file=root.join(&item.path);
        let Ok(root)=root.canonicalize() else{return};
        let Ok(file)=file.canonicalize() else{return};
        if !file.starts_with(&root)||!file.is_file()||!super::media_library::is_video(&file){
            reply(&mut stream,"403 Forbidden","text/plain",b"Forbidden","",origin);return;
        }
        drop(lib);
        let Ok(mut opened)=std::fs::File::open(&file) else{return};
        let Ok(meta)=opened.metadata() else{return};
        let total=meta.len();
        if total==0 {reply(&mut stream,"200 OK",mime(&file),&[],"Accept-Ranges: bytes\r\n",origin);return;}
        let mut start=0u64;let mut end=total-1;
        let mut partial=false;
        if let Some(spec)=range.strip_prefix("bytes="){
            let Some((a,b))=spec.split_once('-') else{return};
            if !a.is_empty(){
                let Ok(n)=a.parse::<u64>() else{return};
                start=n;
                if !b.is_empty(){if let Ok(n)=b.parse::<u64>(){end=n.min(total-1);}}
            }else if let Ok(n)=b.parse::<u64>(){start=total.saturating_sub(n);}
            if start>=total||start>end{
                reply(&mut stream,"416 Range Not Satisfiable","text/plain",&[],
                    &format!("Content-Range: bytes */{total}\r\n"),origin);return;
            }
            partial=true;
        }
        let len=end-start+1;
        let range_header=if partial{format!("Content-Range: bytes {start}-{end}/{total}\r\n")}else{String::new()};
        let header=format!("HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {len}\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n{}{}\r\n",
            if partial{"206 Partial Content"}else{"200 OK"},mime(&file),cors(origin),range_header);
        if stream.write_all(header.as_bytes()).is_err(){return;}
        use std::io::{Seek,SeekFrom};
        if opened.seek(SeekFrom::Start(start)).is_err(){return;}
        let _=std::io::copy(&mut opened.take(len),&mut stream);
        return;
    }
    reply(&mut stream,"404 Not Found","text/plain",b"Not Found","",origin);
}
pub fn start(app:tauri::AppHandle)->Result<(),String>{
    token();
    let listener=TcpListener::bind(("127.0.0.1",PORT)).map_err(|e|format!("Media server port unavailable: {e}"))?;
    thread::spawn(move||{
        for connection in listener.incoming(){
            if let Ok(stream)=connection{
                let app=app.clone();
                thread::spawn(move||handle(stream,&app));
            }
        }
    });
    Ok(())
}
pub fn bridge_script()->String {
    let key=token();
    let js=r#"(function(){
      const origin=location.origin;
      const permitted=origin==='https://marmaladeum.com'||
        origin==='https://www.marmaladeum.com'||
        (origin==='https://marcusdhaynes.github.io'&&location.pathname.startsWith('/MarmaladePlayer/'));
      if(!permitted)return;
      const base='http://127.0.0.1:18761';
      const key=__TOKEN__;
      const getCatalog=async()=>{
        const r=await fetch(base+'/catalog?key='+key,{cache:'no-store'});
        if(!r.ok)throw Error('Minternet media server unavailable ('+r.status+')');
        return r.json();
      };
      const manage=async(action,props={})=>{
        const r=await fetch(base+'/manage?key='+key,{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({action,...props}),cache:'no-store'
        });
        const data=await r.json();
        if(!r.ok||!data.ok)throw Error(data.error||'Native library change failed');
        return data.result;
      };
      const rescan=async()=>{await manage('rescan');return getCatalog();};
      window.MinternetMediaLibrary=Object.freeze({
        getCatalog,rescan,
        saveLibrary:async({id,name,kind})=>{
          const result=await manage('saveLibrary',{id,name,kind});
          return {...result,catalog:await getCatalog()};
        },
        deleteLibrary:async({id})=>{await manage('deleteLibrary',{id});return getCatalog();},
        removeFolder:async({libraryId,folderId})=>{
          await manage('removeFolder',{libraryId,folderId});return getCatalog();
        },
        updateItem:async({libraryId,itemId,changes})=>{
          await manage('updateItem',{libraryId,itemId,changes});return true;
        },
        addFolder:({libraryId,name,kind}={})=>{
          const requestId=(crypto.randomUUID?.()||Math.random().toString(36).slice(2)+Date.now());
          const query=new URLSearchParams({
            libraryId:libraryId||'',name:name||'',kind:kind||'movie',requestId
          });
          // Request Minternet's native directory picker before any await.
          window.open('https://minternet-media.invalid/__add?'+query,'_blank');
          return (async()=>{
            let unknown=0;
            for(let attempt=0;attempt<450;attempt++){
              await new Promise(resolve=>setTimeout(resolve,300));
              const response=await fetch(base+'/picker?key='+key+'&requestId='+requestId,{cache:'no-store'});
              if(!response.ok)throw Error('Could not verify native folder picker');
              const result=await response.json();
              if(result.state==='success')return getCatalog();
              if(result.state==='cancelled')throw Error('Folder selection cancelled. No files were changed.');
              if(result.state==='error')throw Error(result.message||'Native folder import failed');
              if(result.state==='unknown'&&++unknown>=12)
                throw Error('Minternet did not open the native folder picker. Update/restart the browser and try again.');
            }
            throw Error('Folder selection did not finish. Check Minternet and retry.');
          })();
        }
      });
    })();"#;
    js.replace("__TOKEN__",&serde_json::to_string(key).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_approved_media_origins_receive_cors() {
        assert!(allowed("https://marmaladeum.com"));
        assert!(allowed("https://marcusdhaynes.github.io"));
        assert!(!allowed("https://example.com"));
        assert!(!allowed("http://marmaladeum.com"));
    }
    #[test]
    fn picker_completion_is_correlated_to_its_request() {
        let id="media-picker-test-abcdef1234";
        assert!(valid_request_id(id));
        assert!(!valid_request_id("../unsafe"));
        begin_picker(id);
        finish_picker(id,"success","Indexed");
        let map=pickers().lock().unwrap();
        assert_eq!(map.get(id).and_then(|s|s.get("state")).and_then(Value::as_str),Some("success"));
    }
}
