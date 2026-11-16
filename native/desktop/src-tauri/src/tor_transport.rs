//! Tor transport for isolated native desktop tabs.
//! This is a Tor-routed WebView, *not* Tor Browser's fingerprinting protection.
//! Arti does remote DNS; we never resolve destination hostnames via the OS.
use std::{collections::HashMap, sync::{Arc, Mutex, OnceLock}, time::Duration};
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
static PROXIES: OnceLock<Mutex<HashMap<u32,TabProxy>>> = OnceLock::new();

fn proxies() -> &'static Mutex<HashMap<u32,TabProxy>> {
    PROXIES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn proxy_url(id:u32)->Result<tauri::Url,String>{
    let state=proxies().lock().map_err(|e|e.to_string())?;
    let proxy=state.get(&id).filter(|proxy|!proxy.task.is_finished())
        .ok_or("Tor proxy not ready: navigation blocked")?;
    tauri::Url::parse(&format!("socks5://127.0.0.1:{}",proxy.port))
        .map_err(|e|e.to_string())
}

pub fn release(id:u32){
    if let Ok(mut state)=proxies().lock(){
        if let Some(proxy)=state.remove(&id){
            let _=proxy.shutdown.send(true);
            proxy.task.abort();
        }
    }
}

pub fn status()->serde_json::Value{
    let count=proxies().lock().map(|p|p.values().filter(|v|!v.task.is_finished()).count()).unwrap_or(0);
    serde_json::json!({"embedded":true,"bootstrapped":CLIENT.get().is_some(),
        "activeTabs":count,"browserHardening":"partial",
        "warning":"Tor-routed WebView2 is not Tor Browser; browser fingerprinting protections are incomplete."})
}

/// Only called from a trusted Tauri chrome command. Never open a browser
/// controller before the Tor network has completed bootstrapping.
pub async fn prepare(id:u32)->Result<(),String>{
    #[cfg(not(any(windows,target_os="linux")))]
    return Err("Native Tor tabs are not enabled on this platform".into());
    #[cfg(any(windows,target_os="linux"))]
    {
        {
            let state=proxies().lock().map_err(|e|e.to_string())?;
            if state.get(&id).is_some_and(|p|!p.task.is_finished()){return Ok(());}
        }
        let client=CLIENT.get_or_try_init(||async{
            tokio::time::timeout(Duration::from_secs(150),
                TorClient::create_bootstrapped(TorClientConfig::default()))
                .await.map_err(|_|"Tor bootstrap timed out (no direct browsing fallback)".to_string())?
                .map_err(|e|format!("Tor bootstrap failed: {e}"))
        }).await?;
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
                        let Ok((socket,peer))=incoming else{break;};
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
    // No DNS APIs or fallback TCP sockets are used for the destination.
    match tokio::time::timeout(Duration::from_secs(75),client.connect((domain.as_str(),port))).await{
        Ok(Ok(mut upstream))=>{
            socket.write_all(&reply(0)).await?;
            let _=tokio::io::copy_bidirectional(&mut socket,&mut upstream).await;
        }
        _=>{socket.write_all(&reply(5)).await?;}
    }
    Ok(())
}
fn reply(status:u8)->[u8;10]{[5,status,0,1,0,0,0,0,0,0]}
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
    #[test] fn reject_local_or_malformed_destinations(){
        for host in ["localhost","secret.localhost","127.0.0.1","::1","", "example.org/other","host\nname",".invalid","invalid."]{
            assert!(!valid_destination(host),"{host}");
        }
        for host in ["example.com","service.onion","xn--bcher-kva.example"]{
            assert!(valid_destination(host),"{host}");
        }
    }
}