//! Minternet local-only media server. Binds loopback, token-gated, never exposes paths.
//! Intended exclusively for the explicitly supported Marmaladeum origins.
use std::{io::{Read,Write},net::{TcpListener,TcpStream},sync::OnceLock,thread,time::Duration,path::Path};
use serde_json::{json,Value};
use rand::{rngs::OsRng,RngCore};
use tauri::Manager;

const PORT:u16=18761;
static SECRET:OnceLock<String>=OnceLock::new();
fn token()->&'static str {
    SECRET.get_or_init(||{
        let mut bytes=[0u8;32]; OsRng.fill_bytes(&mut bytes);
        bytes.iter().map(|b|format!("{b:02x}")).collect()
    })
}
fn allowed(origin:&str)->bool {
    origin=="https://marmaladeum.com" ||
    origin=="https://www.marmaladeum.com" ||
    origin=="https://marcusdhaynes.github.io" ||
    origin=="http://localhost" ||
    origin.starts_with("http://localhost:") ||
    origin=="http://127.0.0.1" || origin.starts_with("http://127.0.0.1:")
}
fn cors(origin:&str)->String {
    if allowed(origin){format!("Access-Control-Allow-Origin: {origin}\r\nVary: Origin\r\nAccess-Control-Allow-Private-Network: true\r\n")}
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
    let request=String::from_utf8_lossy(&buf[..size]);
    let mut lines=request.split("\r\n");
    let Some(first)=lines.next() else{return};
    let mut pieces=first.split_whitespace();
    let method=pieces.next().unwrap_or("");
    let target=pieces.next().unwrap_or("");
    let mut origin="";
    let mut range="";
    for line in lines {
        if line.is_empty(){break;}
        if let Some(v)=line.strip_prefix("Origin: "){origin=v.trim();}
        if let Some(v)=line.strip_prefix("Range: "){range=v.trim();}
    }
    if method=="OPTIONS" {
        if allowed(origin){
            reply(&mut stream,"204 No Content","text/plain",&[],
                "Access-Control-Allow-Methods: GET, OPTIONS\r\nAccess-Control-Allow-Headers: Range\r\nAccess-Control-Max-Age: 600\r\n",origin);
        }else{reply(&mut stream,"403 Forbidden","text/plain",b"Forbidden","",origin);}
        return;
    }
    if method!="GET" || (!origin.is_empty()&&!allowed(origin)){
        reply(&mut stream,"403 Forbidden","text/plain",b"Forbidden","",origin);return;
    }
    let (path,query)=target.split_once('?').unwrap_or((target,""));
    if !query.split('&').any(|p|p.strip_prefix("key=")==Some(token())){
        reply(&mut stream,"403 Forbidden","text/plain",b"Forbidden","",origin);return;
    }
    let state=app.state::<std::sync::Mutex<super::media_library::MediaLibrary>>();
    let Ok(lib)=state.lock() else{return};
    if path=="/catalog" {
        let items=lib.items.iter().map(|item|{
            let mut v=serde_json::to_value(item).unwrap_or(Value::Null);
            if let Some(o)=v.as_object_mut(){
                o.insert("url".into(),json!(format!("http://127.0.0.1:{PORT}/video/{}?key={}",item.id,token())));
            }
            v
        }).collect::<Vec<_>>();
        let body=json!({"libraries":[{"id":"minternet-media","name":"Minternet Media Server","kind":"mixed",
            "folders":lib.folders.iter().map(|f|json!({"id":f.id,"name":f.name})).collect::<Vec<_>>(),
            "items":items,"lastScan":lib.last_scan}]}).to_string();
        reply(&mut stream,"200 OK","application/json",body.as_bytes(),"",origin);return;
    }
    if let Some(id)=path.strip_prefix("/video/"){
        let Some(item)=lib.items.iter().find(|i|i.id==id) else{
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
        (origin==='https://marcusdhaynes.github.io'&&location.pathname.startsWith('/MarmaladePlayer/'))||
        origin==='http://localhost'||origin.startsWith('http://localhost:')||
        origin==='http://127.0.0.1'||origin.startsWith('http://127.0.0.1:');
      if(!permitted)return;
      const base='http://127.0.0.1:18761';
      const key=__TOKEN__;
      const getCatalog=async()=>{
        const r=await fetch(base+'/catalog?key='+key,{cache:'no-store'});
        if(!r.ok)throw Error('Minternet media server unavailable ('+r.status+')');
        return r.json();
      };
      window.MinternetMediaLibrary=Object.freeze({
        getCatalog,
        addFolder:async()=>{
          const before=await getCatalog();
          const oldCount=before.libraries?.[0]?.folders?.length||0;
          window.open('https://minternet-media.invalid/__add','_blank');
          return new Promise((resolve,reject)=>{
            let attempts=0;
            const check=async()=>{
              try{
                const current=await getCatalog();
                if((current.libraries?.[0]?.folders?.length||0)>oldCount)return resolve(current);
              }catch{}
              if(++attempts>300)return reject(Error('Folder selection not completed'));
              setTimeout(check,400);
            };
            setTimeout(check,350);
          });
        }
      });
    })();"#;
    js.replace("__TOKEN__",&serde_json::to_string(key).unwrap_or_default())
}
