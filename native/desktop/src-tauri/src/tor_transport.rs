//! Tor transport for isolated native desktop tabs.
//! This is a Tor-routed WebView, *not* Tor Browser's fingerprinting protection.
//! Arti does remote DNS; we never resolve destination hostnames via the OS.
use std::{collections::HashMap, path::PathBuf, sync::{Arc, Mutex, OnceLock}, time::Duration};
use rand::{rngs::OsRng, RngCore};
use tauri::Manager;
use arti_client::{TorClient, TorClientConfig};
use tor_rtcompat::PreferredRuntime;
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::{TcpListener, TcpStream}, task::JoinHandle};

type Client = TorClient<PreferredRuntime>;
struct TabProxy {
    port: u16,
    task: JoinHandle<()>,
    shutdown: tokio::sync::watch::Sender<bool>,
}
static CLIENT: tokio::sync::OnceCell<Arc<Client>> = tokio::sync::OnceCell::const_new();
// Serializes reconnection so competing Tor navigation commands cannot replace
// a just-created SOCKS port and strand the already-configured WebView2.
static PREPARE_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static PROXIES: OnceLock<Mutex<HashMap<u32,TabProxy>>> = OnceLock::new();
static SESSION_TAG: OnceLock<String> = OnceLock::new();

fn session_tag()->&'static str{
    SESSION_TAG.get_or_init(||{
        let mut random=[0u8;16];
        OsRng.fill_bytes(&mut random);
        random.iter().map(|x|format!("{x:02x}")).collect()
    })
}

/// Separate browser-profile storage for every Tor tab AND application instance.
/// An unrelated Minternet process must never reuse another process's cache.
pub fn profile_dir(app:&tauri::AppHandle,id:u32)->Result<PathBuf,String>{
    Ok(app.path().app_local_data_dir().map_err(|e|e.to_string())?
        .join("tor-ephemeral-profiles")
        .join(format!("session-{}",session_tag()))
        .join(format!("tab-{id}")))
}

fn cleanup_profile(app:&tauri::AppHandle,id:u32){
    let Ok(path)=profile_dir(app,id) else{return};
    // WebView2 may still be releasing profile files. Best-effort deletion,
    // not an anti-forensic guarantee, never touches ordinary browser storage.
    std::thread::spawn(move||{
        for _ in 0..8{
            if !path.exists(){break;}
            if std::fs::remove_dir_all(&path).is_ok(){break;}
            std::thread::sleep(Duration::from_millis(350));
        }
    });
}


fn proxies() -> &'static Mutex<HashMap<u32,TabProxy>> {
    PROXIES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn network_ready()->bool{
    CLIENT.get().is_some_and(|client|client.bootstrap_status().ready_for_traffic())
}

pub fn proxy_url(id:u32)->Result<tauri::Url,String>{
    let state=proxies().lock().map_err(|e|e.to_string())?;
    let proxy=state.get(&id).filter(|proxy|!proxy.task.is_finished())
        .ok_or("Tor proxy not ready: navigation blocked")?;
    tauri::Url::parse(&format!("socks5://127.0.0.1:{}",proxy.port))
        .map_err(|e|e.to_string())
}

// For opt-in live security CI only: deliberately kill a SOCKS listener so
// the subsequent recovery can be tested against an actual Tor client.
pub fn interrupt_listener_for_smoke(id:u32)->Result<(),String>{
    if !std::env::args().any(|arg|arg=="--minternet-tor-transport-smoke"){
        return Err("Tor listener fault injection is restricted to CI smoke".into());
    }
    let proxy=proxies().lock().map_err(|e|e.to_string())?
        .remove(&id).ok_or("No Tor listener to interrupt")?;
    let _=proxy.shutdown.send(true);
    proxy.task.abort();
    Ok(())
}

pub fn release(app:&tauri::AppHandle,id:u32){
    let mut removed=false;
    if let Ok(mut state)=proxies().lock(){
        if let Some(proxy)=state.remove(&id){
            let _=proxy.shutdown.send(true);
            proxy.task.abort();
            removed=true;
        }
    }
    if removed{cleanup_profile(app,id);}
}

pub fn status()->serde_json::Value{
    let count=proxies().lock().map(|p|p.values().filter(|v|!v.task.is_finished()).count()).unwrap_or(0);
    // Read live Arti status. A client that bootstrapped earlier may no longer
    // have usable directory/guard state after a network outage.
    let (ready,progress)=CLIENT.get().map(|client|{
        let status=client.bootstrap_status();
        (status.ready_for_traffic(),(status.as_frac()*100.0).round() as u32)
    }).unwrap_or((false,0));
    serde_json::json!({"embedded":true,"bootstrapped":ready,
        "bootstrapProgressPercent":progress.min(100),
        "activeTabs":count,
        "connectionState":if ready && count>0 {"connected"} else if ready {"ready"} else if CLIENT.get().is_some() {"disconnected"} else {"not-started"},
        "browserHardening":"partial",
        "warning":"Arti readiness is not proof of browser anonymity, DNS leak resistance or Tor Browser fingerprint protection."})
}

/// Only called from a trusted Tauri chrome command. Never open a browser
/// controller before the Tor network has completed bootstrapping.
pub async fn prepare(id:u32)->Result<(),String>{
    #[cfg(not(any(windows,target_os="linux")))]
    return Err("Native Tor tabs are not enabled on this platform".into());
    #[cfg(any(windows,target_os="linux"))]
    {
        let _prepare_guard=PREPARE_GATE.lock().await;
        let client=CLIENT.get_or_try_init(||async{
            tokio::time::timeout(Duration::from_secs(150),
                TorClient::create_bootstrapped(TorClientConfig::default()))
                .await.map_err(|_|"Tor bootstrap timed out (no direct browsing fallback)".to_string())?
                .map_err(|e|format!("Tor bootstrap failed: {e}"))
        }).await?;
        // A Tor client can lose network readiness after its first bootstrap.
        // Recover the same authenticated Arti client before reusing/creating
        // a SOCKS listener. Never fall back to the OS network.
        if !client.bootstrap_status().ready_for_traffic(){
            tokio::time::timeout(Duration::from_secs(150),client.bootstrap())
                .await.map_err(|_|"Tor reconnection timed out; no direct connection allowed".to_string())?
                .map_err(|e|format!("Tor reconnection failed: {e}"))?;
            if !client.bootstrap_status().ready_for_traffic(){
                return Err("Tor network is still not ready; browsing remains blocked".into());
            }
        }
        {
            let state=proxies().lock().map_err(|e|e.to_string())?;
            if state.get(&id).is_some_and(|p|!p.task.is_finished()){return Ok(());}
        }
        let isolated=client.isolated_client();
        // The OS chooses an unused ephemeral port. A unique SOCKS listener
        // plus Arti isolated_client prevents cross-tab circuit reuse.
        let listener=TcpListener::bind(("127.0.0.1",0)).await
            .map_err(|e|format!("Could not bind Tor loopback proxy: {e}"))?;
        let port=listener.local_addr().map_err(|e|e.to_string())?.port();
        // Closing a Tor tab shuts down both its listener and every accepted
        // connection. Never leave an orphan Tor stream running after closure.
        let (shutdown,mut listening)=tokio::sync::watch::channel(false);
        let task=tokio::spawn(async move{
            loop{
                tokio::select!{
                    changed=listening.changed()=>{
                        if changed.is_err() || *listening.borrow(){break;}
                    }
                    incoming=listener.accept()=>{
                        let Ok((socket,peer))=incoming else{
                            // A temporary accept error must not silently kill
                            // the proxy listener and orphan the Tor tab.
                            tokio::time::sleep(Duration::from_millis(100)).await;
                            continue;
                        };
                        if !peer.ip().is_loopback(){continue;}
                        let client=isolated.clone();
                        let mut session_shutdown=listening.clone();
                        tokio::spawn(async move{
                            tokio::select!{
                                _=async{
                                    loop{
                                        if *session_shutdown.borrow(){break;}
                                        if session_shutdown.changed().await.is_err(){break;}
                                    }
                                }=>{},
                                _=serve(socket,client)=>{}
                            }
                        });
                    }
                }
            }
        });
        let mut state=proxies().lock().map_err(|e|e.to_string())?;
        if let Some(old)=state.insert(id,TabProxy{port,task,shutdown}){
            let _=old.shutdown.send(true);
            old.task.abort();
        }
        Ok(())
    }
}

// SOCKS5: only CONNECT, only domain-name destinations, only no-auth.
// Crucially: reject IP-literal requests rather than performing a local
// getaddrinfo or silently bypassing the Tor network.
async fn serve(mut socket:TcpStream,client:Arc<Client>)->std::io::Result<()>{
    let mut hello=[0u8;2];
    socket.read_exact(&mut hello).await?;
    if hello[0]!=5 || hello[1]==0 || hello[1]>16{return Ok(());}
    let mut methods=vec![0u8;hello[1] as usize];
    socket.read_exact(&mut methods).await?;
    if !methods.contains(&0){socket.write_all(&[5,255]).await?;return Ok(());}
    socket.write_all(&[5,0]).await?;
    let mut header=[0u8;4];
    socket.read_exact(&mut header).await?;
    if header[0]!=5 || header[1]!=1 || header[2]!=0 || header[3]!=3{
        socket.write_all(&reply(7)).await?;
        return Ok(());
    }
    let mut length=[0u8;1];
    socket.read_exact(&mut length).await?;
    if length[0]==0 {socket.write_all(&reply(8)).await?;return Ok(());}
    let mut host=vec![0u8;length[0] as usize];
    socket.read_exact(&mut host).await?;
    let mut port=[0u8;2];
    socket.read_exact(&mut port).await?;
    let domain=match String::from_utf8(host){
        Ok(value) if valid_destination(&value)=>value,
        _=>{socket.write_all(&reply(8)).await?;return Ok(());}
    };
    let port=u16::from_be_bytes(port);
    if port==0{socket.write_all(&reply(8)).await?;return Ok(());}
    // Emit only protocol stages in the explicit CI smoke; never hostnames,
    // user addresses or exit IPs. Normal browsing does not log destinations.
    if std::env::args().any(|a|a=="--minternet-tor-transport-smoke"){
        eprintln!("TOR_DIAG: SOCKS remote-domain CONNECT received");
    }
    // No DNS APIs or fallback TCP sockets are used for the destination.
    match tokio::time::timeout(Duration::from_secs(135),client.connect((domain.as_str(),port))).await{
        Ok(Ok(mut upstream))=>{
            if std::env::args().any(|a|a=="--minternet-tor-transport-smoke"){
                eprintln!("TOR_DIAG: Arti upstream connected");
            }
            socket.write_all(&reply(0)).await?;
            let _=tokio::io::copy_bidirectional(&mut socket,&mut upstream).await;
        }
        Ok(Err(_))=>{
            if std::env::args().any(|a|a=="--minternet-tor-transport-smoke"){
                eprintln!("TOR_DIAG: Arti upstream refused/failed");
            }
            socket.write_all(&reply(5)).await?;
        }
        Err(_)=>{
            if std::env::args().any(|a|a=="--minternet-tor-transport-smoke"){
                eprintln!("TOR_DIAG: Arti circuit creation timed out");
            }
            socket.write_all(&reply(5)).await?;
        }
    }
    Ok(())
}
fn reply(status:u8)->[u8;10]{[5,status,0,1,0,0,0,0,0,0]}
/// Blocks direct/private-network navigation at the host boundary before a
/// renderer is permitted to attempt a WebView2 request.
pub fn safe_top_level(url:&tauri::Url)->bool{
    if !matches!(url.scheme(),"http"|"https")||url.host_str().is_none()||
       !url.username().is_empty()||url.password().is_some(){return false;}
    let host=url.host_str().unwrap_or_default().trim_start_matches('[').trim_end_matches(']');
    let lower=host.to_ascii_lowercase();
    !host.parse::<std::net::IpAddr>().is_ok() &&
    !lower.eq("localhost") && !lower.eq("loopback") &&
    ![".localhost",".local",".lan",".internal",".home.arpa"].iter().any(|end|lower.ends_with(end))
}

fn valid_destination(s:&str)->bool{
    !s.is_empty() && s.len()<=253 && !s.contains('\0') && !s.contains('/')
        && !s.chars().any(|c|c.is_whitespace())
        && !s.starts_with('.') && !s.ends_with('.')
        && !s.eq_ignore_ascii_case("localhost")
        && !s.to_ascii_lowercase().ends_with(".localhost")
        && !s.parse::<std::net::IpAddr>().is_ok()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn proxy_never_available_until_created(){
        let id=4_294_967_000;
        assert!(proxy_url(id).is_err());
    }
    #[test] fn socks_connect_replies_are_well_formed(){
        assert_eq!(reply(0),[5,0,0,1,0,0,0,0,0,0]);
        assert_eq!(reply(7)[1],7);
    }
    #[test] fn reject_tor_local_or_numeric_top_level(){
        for input in ["https://localhost/","http://127.0.0.1:3000/","https://[::1]/",
            "https://printer.local/","https://router.home.arpa/","https://loopback/"]{
            assert!(!safe_top_level(&tauri::Url::parse(input).unwrap()),"{input}");
        }
        assert!(safe_top_level(&tauri::Url::parse("https://example.org/").unwrap()));
        assert!(safe_top_level(&tauri::Url::parse("http://service.onion/").unwrap()));
    }
    #[test] fn reject_local_or_malformed_destinations(){
        for host in ["localhost","secret.localhost","127.0.0.1","::1","", "example.org/other","host\nname",".invalid","invalid."]{
            assert!(!valid_destination(host),"{host}");
        }
        for host in ["example.com","service.onion","xn--bcher-kva.example"]{
            assert!(valid_destination(host),"{host}");
        }
    }
}