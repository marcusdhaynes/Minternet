//! Opt-in real-network test of Minternet's embedded Arti SOCKS transport.
//! Only used by --minternet-tor-transport-smoke in CI/development.
//! Does not certify Tor Browser-level privacy, a WebView2 leak-free browser,
//! or full fingerprinting resistance.
use std::{process::Command, time::Duration};
use tokio::{io::{AsyncReadExt,AsyncWriteExt},net::TcpStream};

const SMOKE_ID:u32 = 0xFF_FF_01;
const TOR_CHECK:&str="https://check.torproject.org/api/ip";
const ONION_CHECK:&str="https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/";

fn curl(proxy:&str,url:&str,head:bool)->Result<String,String>{
    // Do not allow environment proxy configuration to override the exact
    // listener. -h on socks5h forces hostname resolution through Tor.
    let mut command=Command::new("curl");
    command.args(["--disable","--silent","--show-error","--http1.1",
        "--connect-timeout","150","--max-time","195",
        "--proto","=https","--proxy",proxy,
        "--noproxy",""]);
    if head {
        command.args(["--output",if cfg!(windows){"NUL"}else{"/dev/null"},
            "--write-out","%{http_code}"]);
    }else{
        command.args(["--fail-with-body"]);
    }
    let result=command.arg(url).output()
        .map_err(|e|format!("Cannot launch curl for controlled Tor smoke: {e}"))?;
    if !result.status.success(){
        let reason=String::from_utf8_lossy(&result.stderr);
        return Err(format!("Tor proxied HTTPS smoke failed: {}",reason.trim()));
    }
    String::from_utf8(result.stdout).map_err(|_|"Non-UTF8 response".into())
}

async fn socks_deny_local(port:u16)->Result<(),String>{
    let mut stream=tokio::time::timeout(Duration::from_secs(8),
        TcpStream::connect(("127.0.0.1",port))).await
        .map_err(|_|"SOCKS local-denial test timed out".to_string())?
        .map_err(|e|e.to_string())?;
    stream.write_all(&[5,1,0]).await.map_err(|e|e.to_string())?;
    let mut method=[0;2];
    stream.read_exact(&mut method).await.map_err(|e|e.to_string())?;
    if method!=[5,0]{return Err("SOCKS method negotiation failed".into());}
    // ATYP IPv4 is deliberately forbidden: a hostname cannot be resolved
    // locally or bypass Tor through an ordinary OS TCP connection.
    stream.write_all(&[5,1,0,1,127,0,0,1,0,80]).await.map_err(|e|e.to_string())?;
    let mut reply=[0u8;10];
    stream.read_exact(&mut reply).await.map_err(|e|e.to_string())?;
    if reply[0]!=5||reply[1]==0{
        return Err("SOCKS proxy accepted direct loopback IP destination".into());
    }
    Ok(())
}

pub fn run()->Result<(),String>{
    let runtime=tokio::runtime::Builder::new_multi_thread()
        .enable_all().build().map_err(|e|e.to_string())?;
    runtime.block_on(async{
        tokio::time::timeout(Duration::from_secs(190),super::tor_transport::prepare(SMOKE_ID))
            .await.map_err(|_|"Embedded Arti startup timed out".to_string())??;
        let proxy=super::tor_transport::proxy_url(SMOKE_ID)?;
        let port=proxy.port().ok_or("Embedded Arti SOCKS proxy missing port")?;
        socks_deny_local(port).await?;
        // curl is intentionally blocking: run it outside async worker threads.
        let address=format!("socks5h://127.0.0.1:{port}");
        let first=address.clone();
        let data=tokio::task::spawn_blocking(move||curl(&first,TOR_CHECK,false))
            .await.map_err(|e|format!("Tor exit verification failed to execute: {e}"))??;
        let check:serde_json::Value=serde_json::from_str(&data)
            .map_err(|_|"Tor check endpoint returned invalid JSON".to_string())?;
        if check.get("IsTor").and_then(serde_json::Value::as_bool)!=Some(true){
            return Err("check.torproject.org did not confirm a Tor exit".into());
        }
        // Onion-service access cannot be supplied by ordinary public DNS.
        // HTTPS prevents mistaking a generic proxy failure page for a site.
        let onion=tokio::task::spawn_blocking(move||curl(&address,ONION_CHECK,true))
            .await.map_err(|e|format!("Onion-service probe failed to execute: {e}"))??;
        let status:u16=onion.trim().parse().map_err(|_|"No onion HTTP status".to_string())?;
        if !(200..500).contains(&status){
            return Err(format!("Onion service did not respond with a normal HTTP status ({status})"));
        }
        // Prove that an interrupted listener does not permanently strand
        // future Tor navigation; only the authenticated Arti transport returns.
        super::tor_transport::interrupt_listener_for_smoke(SMOKE_ID)?;
        if super::tor_transport::proxy_url(SMOKE_ID).is_ok(){
            return Err("Interrupted Tor listener unexpectedly remained available".into());
        }
        super::tor_transport::prepare(SMOKE_ID).await?;
        let recovered=super::tor_transport::proxy_url(SMOKE_ID)?;
        socks_deny_local(recovered.port().ok_or("Recovered Tor SOCKS port missing")?).await?;
        println!("PASS: Tor SOCKS listener restored after injected failure.");
        println!("PASS: Embedded Arti verified by Tor Project and HTTPS v3 onion service.");
        println!("PASS: Embedded SOCKS rejects direct IP requests; remote DNS required.");
        println!("LIMIT: This does not check WebView2 browser leaks or fingerprinting.");
        Ok(())
    })
}
