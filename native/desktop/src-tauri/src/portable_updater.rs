//! Windows portable updater. Never executes an unverified GitHub asset.
//! The downloaded and SHA-256-checked new EXE becomes a short-lived helper.
//! Only after the old process exits may it replace the same on-disk filename.
use std::{fs,io::{Read,Write},path::{Path,PathBuf},process::Command,sync::atomic::{AtomicBool,Ordering},time::{Duration,SystemTime,UNIX_EPOCH}};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use tauri::{AppHandle,Emitter,Manager};

static RUNNING:AtomicBool=AtomicBool::new(false);
const API:&str="https://api.github.com/repos/marcusdhaynes/Minternet/releases/latest";
const MAX_EXE:u64=50_000_000;

// Small CI-only marker. The EXE itself reports the compiled build identity,
// allowing Actions to reject packages whose embedded version differs from
// their GitHub Release tag. This never opens a browser or modifies user data.
pub fn maybe_version_smoke()->bool{
    if !std::env::args_os().any(|a|a=="--minternet-build-version-smoke") {
        return false;
    }
    let marker=std::env::temp_dir()
        .join(format!("minternet-version-{}.txt",std::process::id()));
    let _=fs::write(marker,installed_version());
    true
}
pub fn installed_version()->String {
    let version=env!("CARGO_PKG_VERSION");
    match (option_env!("MINTERNET_BUILD_RUN_ID"),option_env!("MINTERNET_BUILD_SHA")) {
        (Some(run),Some(sha)) if run.parse::<u64>().is_ok()&&sha.len()>=8 =>
            format!("{version}-build.{run}-g{}",&sha[..8]),
        _=>version.to_string()
    }
}
fn version_key(value:&str)->Option<(u64,u64,u64,u64)>{
    let raw=value.trim_start_matches('v');
    let (base,extra)=raw.split_once("-build.").unwrap_or((raw,"0"));
    let mut parts=base.split('.');
    let a=parts.next()?.parse().ok()?;
    let b=parts.next()?.parse().ok()?;
    let c=parts.next()?.parse().ok()?;
    if parts.next().is_some(){return None;}
    let serial=extra.split('-').next()?.parse().ok()?;
    Some((a,b,c,serial))
}
fn latest_asset(data:&Value)->Result<(String,String,String),String>{
    let tag=data.get("tag_name").and_then(Value::as_str).ok_or("Release has no tag")?;
    if !tag.starts_with('v')||version_key(tag).is_none(){return Err("Release tag is invalid".into());}
    let current=installed_version();
    if version_key(tag)<=version_key(&current){
        return Err(format!("Already at the latest installed build ({current})"));
    }
    let assets=data.get("assets").and_then(Value::as_array).ok_or("Release has no assets")?;
    let prefix=format!("Minternet-Windows-Portable-{tag}.exe");
    let mut binary=None;
    let mut checksum=None;
    for asset in assets {
        let Some(name)=asset.get("name").and_then(Value::as_str) else{continue};
        let Some(url)=asset.get("browser_download_url").and_then(Value::as_str) else{continue};
        if !url.starts_with("https://github.com/marcusdhaynes/Minternet/releases/download/"){continue;}
        if name==prefix {binary=Some(url.to_string());}
        if name=="SHA256SUMS.txt" {checksum=Some(url.to_string());}
    }
    let binary=binary.ok_or("Release is missing its matching portable Windows EXE")?;
    let checksum=checksum.ok_or("Release is missing SHA256SUMS.txt")?;
    Ok((prefix,binary,checksum))
}
fn remote(url:&str)->Result<ureq::Response,String>{
    ureq::get(url)
        .set("User-Agent","Minternet-Portable-Updater")
        .set("Accept","application/vnd.github+json")
        .timeout(Duration::from_secs(30))
        .call().map_err(|e|format!("GitHub request failed: {e}"))
}
fn sha256_file(path:&Path)->Result<String,String>{
    let mut file=fs::File::open(path).map_err(|e|e.to_string())?;
    let mut digest=Sha256::new();
    let mut block=[0u8;65536];
    loop{
        let n=file.read(&mut block).map_err(|e|e.to_string())?;
        if n==0{break;}
        digest.update(&block[..n]);
    }
    Ok(format!("{:x}",digest.finalize()))
}
fn expected_hash(text:&str,name:&str)->Result<String,String>{
    for line in text.lines(){
        let mut fields=line.split_whitespace();
        let Some(hash)=fields.next() else{continue};
        let Some(file)=fields.next() else{continue};
        if file.trim_start_matches('*')==name &&
           hash.len()==64 && hash.bytes().all(|c|c.is_ascii_hexdigit()) {
            return Ok(hash.to_ascii_lowercase());
        }
    }
    Err("Release checksum does not list the exact Windows executable".into())
}
fn report(app:&AppHandle,kind:&str,message:&str){
    let _=app.emit_to("chrome","minternet:update",json!({"kind":kind,"message":message}));
}
#[cfg(windows)]
fn prepare(app:&AppHandle)->Result<(),String>{
    let target=std::env::current_exe().map_err(|e|e.to_string())?
        .canonicalize().map_err(|e|e.to_string())?;
    if !target.is_file() || target.extension().and_then(|s|s.to_str())
        .is_none_or(|s|!s.eq_ignore_ascii_case("exe")) {
        return Err("Portable update requires an installed Windows EXE".into());
    }
    let parent=target.parent().ok_or("Executable has no parent directory")?;
    let probe=parent.join(format!(".minternet-update-probe-{}",std::process::id()));
    fs::write(&probe,b"write-permission-test").map_err(|e|
        format!("Cannot replace the EXE in its present folder: {e}"))?;
    fs::remove_file(&probe).map_err(|e|e.to_string())?;
    report(app,"checking","Checking published Windows release…");
    let release:Value=remote(API)?.into_json().map_err(|e|format!("Invalid release metadata: {e}"))?;
    if release.get("draft").and_then(Value::as_bool)==Some(true) ||
        release.get("prerelease").and_then(Value::as_bool)==Some(true){
        return Err("Latest release is not a published stable update".into());
    }
    let (name,url,hash_url)=latest_asset(&release)?;
    report(app,"downloading","Downloading verified Windows update…");
    let hashes=remote(&hash_url)?.into_string()
        .map_err(|e|format!("Cannot read release checksum: {e}"))?;
    let expected=expected_hash(&hashes,&name)?;
    let folder=std::env::temp_dir().join(format!("Minternet-update-{}-{}",std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()));
    fs::create_dir_all(&folder).map_err(|e|e.to_string())?;
    let staged=folder.join("Minternet-update-helper.exe");
    let mut response=remote(&url)?.into_reader().take(MAX_EXE+1);
    let mut output=fs::File::create(&staged).map_err(|e|e.to_string())?;
    let bytes=std::io::copy(&mut response,&mut output).map_err(|e|e.to_string())?;
    output.flush().map_err(|e|e.to_string())?;
    drop(output);
    if !(100_000..=MAX_EXE).contains(&bytes){
        let _=fs::remove_file(&staged);
        return Err("Downloaded EXE has an invalid size".into());
    }
    let mut header=[0u8;2];
    fs::File::open(&staged).and_then(|mut f|f.read_exact(&mut header))
        .map_err(|e|e.to_string())?;
    if &header!=b"MZ" {let _=fs::remove_file(&staged);return Err("Update is not a Windows executable".into());}
    if sha256_file(&staged)?!=expected {
        let _=fs::remove_file(&staged);
        return Err("Update SHA-256 verification failed; original EXE was not changed".into());
    }
    report(app,"restarting","Verified. Replacing Minternet at its current location…");
    let handle=app.clone();
    // WebView state and session persistence belong on the UI thread.
    app.run_on_main_thread(move||{
        super::refresh_session_urls(&handle);
        if let Err(error)=super::save_session(&handle){
            report(&handle,"error",&format!("Could not preserve the browser session: {error}"));
            return;
        }
        let args=["--minternet-apply-update".to_string(),target.to_string_lossy().into_owned(),
            std::process::id().to_string(),expected];
        if let Err(error)=Command::new(&staged).args(&args).spawn(){
            report(&handle,"error",&format!("Unable to start update helper: {error}"));
            return;
        }
        // A separately running, SHA-verified new binary now handles the
        // replacement and rollback; only this point exits the old browser.
        handle.exit(0);
    }).map_err(|e|e.to_string())?;
    Ok(())
}
#[cfg(not(windows))]
fn prepare(_app:&AppHandle)->Result<(),String>{
    Err("Automatic portable EXE replacement is supported on Windows only".into())
}
pub fn start(app:AppHandle)->Result<(),String>{
    if RUNNING.swap(true,Ordering::AcqRel){return Err("An update is already running".into());}
    std::thread::spawn(move||{
        let result=prepare(&app);
        if let Err(error)=result{report(&app,"error",&error);}
        RUNNING.store(false,Ordering::Release);
    });
    Ok(())
}
/// Called before creating the Tauri GUI when running from the staged executable.
pub fn maybe_run_helper()->bool{
    let mut args=std::env::args_os();
    let _program=args.next();
    if args.next().as_deref()!=Some(std::ffi::OsStr::new("--minternet-apply-update")) {
        return false;
    }
    #[cfg(windows)] {
        let target=args.next().map(PathBuf::from);
        let parent=args.next().and_then(|n|n.to_string_lossy().parse::<u32>().ok());
        let expected=args.next().map(|s|s.to_string_lossy().into_owned());
        let fallback=target.clone();
        let status=match (target,parent,expected){
            (Some(target),Some(parent),Some(expected)) =>
                run_helper(&target,parent,&expected),
            _=>Err("Malformed update helper arguments".into())
        };
        if let Err(ref error)=status{
            eprintln!("Minternet update failed: {error}");
            // Never leave a previously usable EXE closed when a write-lock,
            // antivirus, permission, or startup failure aborts installation.
            if let Some(target)=fallback.filter(|p|
                p.is_file() && p.extension().and_then(|x|x.to_str()).is_some_and(|x|x.eq_ignore_ascii_case("exe"))) {
                let _=Command::new(target).spawn();
            }
        }
        // GitHub Actions must be able to distinguish a verified successful
        // replacement from a rollback or failed update.
        std::process::exit(if status.is_ok(){0}else{1});
    }
    #[cfg(not(windows))]
    return true;
}
#[cfg(windows)]
fn run_helper(target:&Path,old_pid:u32,expected:&str)->Result<(),String>{
    // Only accept the exact portable target under an existing parent directory.
    if old_pid==std::process::id() || !target.is_absolute() || !target.is_file(){
        return Err("Invalid update target".into());
    }
    if expected.len()!=64 || !expected.bytes().all(|b|b.is_ascii_hexdigit()){
        return Err("Invalid checksum".into());
    }
    let self_exe=std::env::current_exe().map_err(|e|e.to_string())?;
    if sha256_file(&self_exe)?!=expected.to_ascii_lowercase(){
        return Err("Staged updater no longer matches verified SHA-256".into());
    }
    let filename=target.file_name().ok_or("Missing executable name")?.to_string_lossy();
    let backup=target.with_file_name(format!("{filename}.backup-{old_pid}"));
    let marker=self_exe.parent().ok_or("Missing helper folder")?.join("startup-confirmed");
    // Never overwrite a pre-existing backup or silently discard user files.
    if backup.exists(){return Err("A previous update backup exists; refusing unsafe overwrite".into());}
    let mut moved=false;
    for _ in 0..240{
        match fs::rename(target,&backup){
            Ok(())=>{moved=true;break;},
            Err(_)=>std::thread::sleep(Duration::from_millis(250))
        }
    }
    if !moved{return Err("Original EXE remained locked or its directory is not writable".into());}
    if let Err(error)=fs::copy(&self_exe,target){
        let _=fs::rename(&backup,target);
        return Err(format!("Cannot place updated EXE: {error}"));
    }
    if sha256_file(target)?!=expected.to_ascii_lowercase(){
        let _=fs::remove_file(target);
        let _=fs::rename(&backup,target);
        return Err("Installed checksum mismatch; original restored".into());
    }
    let launched=Command::new(target)
        .arg("--minternet-update-confirm")
        .arg(&marker)
        .spawn();
    let mut child=match launched{
        Ok(child)=>child,
        Err(error)=>{
            let _=fs::remove_file(target);
            let _=fs::rename(&backup,target);
            return Err(format!("Relaunch failed, original restored: {error}"));
        }
    };
    let mut confirmed=false;
    for _ in 0..120{
        if marker.exists(){confirmed=true;break;}
        if child.try_wait().map_err(|e|e.to_string())?.is_some(){break;}
        std::thread::sleep(Duration::from_millis(500));
    }
    if !confirmed{
        let _=child.kill();
        let _=child.wait();
        let failed=target.with_file_name(format!("{filename}.failed-{old_pid}"));
        let _=fs::rename(target,&failed);
        fs::rename(&backup,target)
            .map_err(|e|format!("Automatic rollback failed: {e}; backup is at {}",backup.display()))?;
        return Err("New EXE failed startup confirmation; original version restored".into());
    }
    let _=fs::remove_file(&marker);
    let _=fs::remove_file(&backup);
    Ok(())
}
/// New main process acknowledges startup after the chrome child WebView exists.
pub fn confirm_startup(){
    let mut args=std::env::args_os();
    while let Some(arg)=args.next(){
        if arg==std::ffi::OsStr::new("--minternet-update-confirm"){
            if let Some(marker)=args.next(){
                let path=PathBuf::from(marker);
                if path.parent().is_some_and(|parent|parent.starts_with(std::env::temp_dir())
                    && path.file_name().is_some_and(|s|s=="startup-confirmed")){
                    let _=fs::write(path,b"started");
                }
            }
            break;
        }
    }
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test] fn version_comparison(){
        assert!(version_key("v0.3.0-build.21-g12345678")>version_key("0.3.0-build.20-gabcdef12"));
        assert!(version_key("v0.4.0")>version_key("0.3.0-build.999"));
        assert!(version_key("bad").is_none());
    }
    #[test] fn checksum_exact_match(){
        assert_eq!(expected_hash(&format!("{}  Minternet.exe", "a".repeat(64)),"Minternet.exe").unwrap(),"a".repeat(64));
        assert!(expected_hash(&format!("{}  other.exe","b".repeat(64)),"Minternet.exe").is_err());
    }
    #[test] fn refuse_release_without_signed_off_assets(){
        let fake=json!({"tag_name":"v9.0.0","assets":[]});
        assert!(latest_asset(&fake).is_err());
    }
}
