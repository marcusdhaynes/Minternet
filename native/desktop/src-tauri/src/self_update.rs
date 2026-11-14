//! Verified, in-place Windows portable updater.
//! A downloaded copy of our own EXE runs as a short-lived helper only after
//! the SHA-256 published with the corresponding first-party release matches.
//! It waits for the original PID to exit before replacing the executable in
//! its *existing* folder and launching that same path. Browser data is never
//! stored alongside or modified by this updater.
use std::{
    fs::{self,File},
    io::{Read,Write},
    path::{Path,PathBuf},
    process::{Command,Stdio},
    time::Duration,
};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use tauri::{AppHandle,Emitter,Manager};
use rand::{rngs::OsRng,RngCore};

const MAX_EXE_BYTES:u64=50_000_000;
const MAX_CHECKSUM_BYTES:u64=16_384;
const RELEASE_ROOT:&str="https://github.com/marcusdhaynes/Minternet/releases/download/";
const UPDATE_SWITCH:&str="--minternet-install-update";

fn hash_file(path:&Path)->Result<String,String>{
    let mut input=File::open(path).map_err(|e|e.to_string())?;
    let mut hasher=Sha256::new();
    let mut buf=[0u8;65536];
    loop{
        let count=input.read(&mut buf).map_err(|e|e.to_string())?;
        if count==0{break;}
        hasher.update(&buf[..count]);
    }
    Ok(format!("{:x}",hasher.finalize()))
}
fn validate_hash(hex:&str)->bool{
    hex.len()==64 && hex.bytes().all(|b|b.is_ascii_hexdigit())
}
fn checksum_for(body:&str,name:&str)->Result<String,String>{
    if name.contains('/')||name.contains('\\')||name.is_empty(){
        return Err("Unsafe executable name in release metadata".into());
    }
    for line in body.lines(){
        let mut parts=line.split_whitespace();
        let digest=parts.next().unwrap_or("");
        let filename=parts.next().unwrap_or("").trim_start_matches('*');
        if filename==name && validate_hash(digest){
            return Ok(digest.to_ascii_lowercase());
        }
    }
    Err("This release has no matching SHA-256 checksum for its Windows executable".into())
}
fn emit(app:&AppHandle,stage:&str,percent:Option<u8>,detail:&str){
    let _=app.emit_to("chrome","minternet:update-progress",
        json!({"stage":stage,"percent":percent,"message":detail}));
}
fn github_agent()->ureq::Agent{
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(12))
        .timeout_read(Duration::from_secs(25))
        .timeout_write(Duration::from_secs(12))
        .redirects(6)
        .build()
}
fn fetch_checksum(agent:&ureq::Agent,url:&str)->Result<String,String>{
    if !url.starts_with(RELEASE_ROOT) || !url.ends_with("/SHA256SUMS.txt"){
        return Err("Untrusted checksum location".into());
    }
    let response=agent.get(url)
        .set("User-Agent","Minterest-Portable-Updater")
        .set("Accept","application/octet-stream")
        .call().map_err(|e|format!("Could not download update checksum: {e}"))?;
    let mut bytes=Vec::new();
    response.into_reader().take(MAX_CHECKSUM_BYTES+1)
        .read_to_end(&mut bytes).map_err(|e|e.to_string())?;
    if bytes.len() as u64>MAX_CHECKSUM_BYTES{
        return Err("Update checksum manifest is too large".into());
    }
    String::from_utf8(bytes).map_err(|_|"Checksum manifest is not UTF-8".into())
}
fn create_staging(tag:&str)->Result<PathBuf,String>{
    let mut nonce=[0u8;8];
    OsRng.fill_bytes(&mut nonce);
    let marker=nonce.iter().map(|byte|format!("{byte:02x}")).collect::<String>();
    let root=std::env::temp_dir().join("Minterest-Portable-Updates");
    fs::create_dir_all(&root).map_err(|e|e.to_string())?;
    let folder=root.join(format!("{tag}-{}-{marker}",std::process::id()));
    fs::create_dir(&folder).map_err(|e|e.to_string())?;
    Ok(folder)
}
fn download_exe(
    app:&AppHandle,agent:&ureq::Agent,url:&str,path:&Path,
)->Result<String,String>{
    if !url.starts_with(RELEASE_ROOT) || !url.to_ascii_lowercase().ends_with(".exe"){
        return Err("The update EXE must come from Minternet's GitHub release".into());
    }
    let response=agent.get(url)
        .set("User-Agent","Minterest-Portable-Updater")
        .set("Accept","application/octet-stream")
        .call().map_err(|e|format!("Update download failed: {e}"))?;
    let total=response.header("Content-Length").and_then(|s|s.parse::<u64>().ok());
    if total.is_some_and(|n|n>MAX_EXE_BYTES){
        return Err("Downloaded executable exceeds Minternet's 50 MB limit".into());
    }
    let mut from=response.into_reader();
    let mut to=File::create(path).map_err(|e|format!("Cannot stage the update: {e}"))?;
    let mut count=0u64;
    let mut hasher=Sha256::new();
    let mut buf=[0u8;65536];
    let mut last=0u8;
    loop{
        let n=from.read(&mut buf).map_err(|e|format!("Interrupted update download: {e}"))?;
        if n==0{break;}
        count+=n as u64;
        if count>MAX_EXE_BYTES{return Err("Downloaded executable exceeds 50 MB".into());}
        hasher.update(&buf[..n]);
        to.write_all(&buf[..n]).map_err(|e|format!("Cannot write update: {e}"))?;
        if let Some(size)=total.filter(|n|*n>0){
            let percent=(count.saturating_mul(100)/size).min(100) as u8;
            if percent>=last.saturating_add(5)||percent==100{
                last=percent;
                emit(app,"downloading",Some(percent),"Downloading update…");
            }
        }
    }
    to.sync_all().map_err(|e|format!("Unable to flush update to disk: {e}"))?;
    if !(100_000..MAX_EXE_BYTES).contains(&count){
        return Err("Invalid portable EXE size".into());
    }
    if total.is_some_and(|n|n!=count){
        return Err("The update download was incomplete".into());
    }
    // Reject obvious HTML/error responses even if a proxy returns HTTP 200.
    let mut header=[0u8;2];
    File::open(path).map_err(|e|e.to_string())?
        .read_exact(&mut header).map_err(|e|e.to_string())?;
    if &header!=b"MZ"{return Err("Downloaded asset is not a Windows executable".into());}
    Ok(format!("{:x}",hasher.finalize()))
}
fn exe_name_from_url(url:&str)->Result<&str,String>{
    let name=url.rsplit('/').next().unwrap_or("");
    if name.is_empty() || name.contains('?') || name.contains('%') ||
       name.contains('\\') || !name.to_ascii_lowercase().ends_with(".exe"){
        return Err("Invalid release executable filename".into());
    }
    Ok(name)
}

/// The update is selected by the trusted Rust release checker, not a URL
/// supplied by a webpage or an arbitrary frontend command.
#[cfg(windows)]
pub fn download_and_start(app:&AppHandle,release:&Value)->Result<Value,String>{
    let tag=release.get("tag").and_then(Value::as_str)
        .ok_or("Release tag is missing")?;
    let run_id=tag.strip_prefix("minternet-build-")
        .filter(|id|!id.is_empty()&&id.bytes().all(|b|b.is_ascii_digit()))
        .ok_or("Invalid trusted release tag")?;
    let url=release.get("downloadUrl").and_then(Value::as_str)
        .ok_or("Release EXE download is missing")?;
    let prefix=format!("{RELEASE_ROOT}{tag}/");
    if !url.starts_with(&prefix){return Err("Update URL belongs to a different release".into());}
    let asset_name=exe_name_from_url(url)?;
    let source=std::env::current_exe()
        .map_err(|e|format!("Cannot find the running Minternet executable: {e}"))?;
    if !source.is_absolute() ||
       !source.extension().is_some_and(|ext|ext.to_string_lossy().eq_ignore_ascii_case("exe")){
        return Err("Automatic replacement requires a Windows portable EXE".into());
    }
    // Check destination directory before closing the browser. A portable
    // install in Program Files may require permissions which aren't present;
    // never exit if we cannot write beside the original EXE.
    let parent=source.parent().ok_or("Invalid running executable location")?;
    let mut probe_nonce=[0u8;8];OsRng.fill_bytes(&mut probe_nonce);
    let probe=parent.join(format!(".minternet-write-test-{}-{:x}.tmp",
        std::process::id(),u64::from_le_bytes(probe_nonce)));
    File::create(&probe).map_err(|e|format!(
        "Cannot update this location without write permission ({}): {e}",parent.display()))?;
    let _=fs::remove_file(&probe);

    emit(app,"checking",None,"Verifying release metadata…");
    let agent=github_agent();
    let checksums_url=format!("{prefix}SHA256SUMS.txt");
    let manifest=fetch_checksum(&agent,&checksums_url)?;
    let expected=checksum_for(&manifest,asset_name)?;
    let stage=create_staging(tag)?;
    // Keep the helper under the requested stable executable filename.
    let helper=stage.join("Minterest.exe");
    let result=(||{
        emit(app,"downloading",Some(0),"Downloading Minterest.exe…");
        let downloaded=download_exe(app,&agent,url,&helper)?;
        emit(app,"verifying",None,"Checking downloaded EXE against GitHub SHA-256…");
        if downloaded!=expected{
            return Err("Update SHA-256 mismatch; the running EXE has NOT been changed".into());
        }
        // No scripts, installers, or third-party updaters. The verified new
        // EXE itself is the helper and replaces the original after it exits.
        let mut child=Command::new(&helper);
        child.arg(UPDATE_SWITCH)
            .arg(std::process::id().to_string())
            .arg(&source)
            .arg(&expected)
            .current_dir(&stage)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        child.spawn().map_err(|e|format!(
            "The verified update could not start its replacement helper: {e}"))?;
        emit(app,"restarting",Some(100),"Installing in the original folder and restarting…");
        Ok(json!({"started":true,"buildId":run_id,
            "filename":source.file_name().unwrap_or_default().to_string_lossy(),
            "folder":parent.to_string_lossy()}))
    })();
    if result.is_err(){let _=fs::remove_dir_all(&stage);}
    result
}
#[cfg(not(windows))]
pub fn download_and_start(_app:&AppHandle,_release:&Value)->Result<Value,String>{
    Err("In-place portable EXE replacement is available on Windows only".into())
}

#[cfg(windows)]
fn wait_for_previous_process(pid:u32)->Result<(),String>{
    use windows::Win32::Foundation::{CloseHandle,WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{
        OpenProcess,WaitForSingleObject,PROCESS_SYNCHRONIZE
    };
    if pid==0{return Err("Missing original Minternet PID".into());}
    if let Ok(handle)=unsafe{OpenProcess(PROCESS_SYNCHRONIZE,false,pid)}{
        let state=unsafe{WaitForSingleObject(handle,90_000)};
        let _=unsafe{CloseHandle(handle)};
        if state!=WAIT_OBJECT_0 {
            return Err("Previous Minternet instance did not exit; update aborted".into());
        }
    }
    Ok(())
}
#[cfg(windows)]
fn replace_with_rollback(source:&Path,target:&Path,expected:&str)->Result<PathBuf,String>{
    let old=target.with_extension("minternet-previous.exe");
    let pending=target.with_extension("minternet-pending.exe");
    if old.exists(){fs::remove_file(&old)
        .map_err(|e|format!("Could not clear an old update backup: {e}"))?;}
    if pending.exists(){let _=fs::remove_file(&pending);}
    // Copy while the original executable still exists. A failed copy is
    // non-destructive, and renaming within one directory is atomic.
    fs::copy(source,&pending).map_err(|e|format!("Cannot stage EXE in original folder: {e}"))?;
    if hash_file(&pending)?!=expected{
        let _=fs::remove_file(&pending);
        return Err("Staged EXE checksum changed; original kept".into());
    }
    fs::rename(target,&old).map_err(|e|{
        let _=fs::remove_file(&pending);
        format!("Cannot unlock and back up the original EXE: {e}")
    })?;
    if let Err(error)=fs::rename(&pending,target){
        let _=fs::rename(&old,target);
        let _=fs::remove_file(&pending);
        return Err(format!("Could not install the replacement; rolled back: {error}"));
    }
    if hash_file(target)?!=expected{
        let _=fs::remove_file(target);
        let _=fs::rename(&old,target);
        return Err("Installed EXE failed checksum verification; rolled back".into());
    }
    Ok(old)
}
#[cfg(windows)]
fn run_helper(pid:u32,target:&Path,expected:&str)->Result<(),String>{
    if !validate_hash(expected){return Err("Invalid update hash".into());}
    if !target.is_absolute() ||
       !target.extension().is_some_and(|ext|ext.to_string_lossy().eq_ignore_ascii_case("exe")){
        return Err("Invalid original EXE location".into());
    }
    let source=std::env::current_exe().map_err(|e|e.to_string())?;
    let parent=source.parent().ok_or("Helper has no directory")?;
    let stage_root=std::env::temp_dir().join("Minterest-Portable-Updates");
    if !parent.starts_with(&stage_root) ||
       source.file_name().and_then(|n|n.to_str())!=Some("Minterest.exe"){
        return Err("Update helper is not running from Minternet's staging directory".into());
    }
    if source==target{return Err("Updater cannot replace itself in place".into());}
    if hash_file(&source)?!=expected{
        return Err("Update helper EXE has changed since it was downloaded".into());
    }
    wait_for_previous_process(pid)?;
    // If Windows/antivirus retains an executable lock briefly after exit,
    // retry the transaction. Never delete the old file before a backup exists.
    let mut backup=None;
    for attempt in 0..18{
        match replace_with_rollback(&source,target,expected){
            Ok(path)=>{backup=Some(path);break;},
            Err(error)=>{
                if attempt==17{return Err(error);}
                std::thread::sleep(Duration::from_millis(500));
            }
        }
    }
    let old=backup.ok_or("Update could not install replacement")?;
    let spawn=Command::new(target)
        .current_dir(target.parent().ok_or("Missing target folder")?)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .spawn();
    match spawn{
        Ok(mut app)=>{
            // A process that fails immediately after starting is not treated
            // as a successful installation. Restore the prior working EXE.
            std::thread::sleep(Duration::from_secs(3));
            if app.try_wait().map_err(|e|e.to_string())?.is_some(){
                let _=fs::remove_file(target);
                fs::rename(&old,target).map_err(|e|
                    format!("New EXE closed immediately; rollback failed: {e}"))?;
                let _=Command::new(target).current_dir(target.parent().unwrap()).spawn();
                return Err("New Minternet closed during startup; restored previous version".into());
            }
            // Keep one previous executable for manual rollback. The next
            // successful update replaces this backup atomically.
            Ok(())
        },
        Err(error)=>{
            let _=fs::remove_file(target);
            fs::rename(&old,target).map_err(|e|
                format!("Could not launch updated EXE ({error}); rollback failed: {e}"))?;
            let _=Command::new(target).current_dir(target.parent().unwrap()).spawn();
            Err(format!("Updated Minternet could not restart: {error}; previous version restored"))
        }
    }
}
#[cfg(windows)]
pub fn maybe_run_helper()->bool{
    let args=std::env::args_os().collect::<Vec<_>>();
    if args.get(1).map(|a|a==UPDATE_SWITCH)!=Some(true){return false;}
    let result=(||{
        if args.len()!=5{return Err("Update helper received incorrect arguments".into());}
        let pid=args[2].to_string_lossy().parse::<u32>()
            .map_err(|_|"Invalid original process ID")?;
        let target=PathBuf::from(&args[3]);
        let digest=args[4].to_string_lossy().to_string();
        run_helper(pid,&target,&digest)
    })();
    if let Err(error)=result{
        let log=std::env::temp_dir().join("Minterest-update-error.txt");
        let _=fs::write(log,format!("Minternet update error: {error}\n"));
    }
    true
}
#[cfg(not(windows))]
pub fn maybe_run_helper()->bool{false}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn checksums_match_only_exact_executable_name(){
        let digest="c".repeat(64);
        let body=format!("{digest}  Minterest.exe\n{}  Wrong.exe\n","a".repeat(64));
        assert_eq!(checksum_for(&body,"Minterest.exe").unwrap(),digest);
        assert!(checksum_for(&body,"Other.exe").is_err());
        assert!(checksum_for(&body,"../Minterest.exe").is_err());
        assert!(!validate_hash("not-a-hash"));
    }
    #[test]
    fn release_filename_must_be_an_exe_not_a_redirect_with_query(){
        assert_eq!(exe_name_from_url("https://example.com/Minterest.exe").unwrap(),"Minterest.exe");
        assert!(exe_name_from_url("https://example.com/Minterest.exe?token=x").is_err());
        assert!(exe_name_from_url("https://example.com/install.ps1").is_err());
    }
    #[cfg(windows)]
    #[test]
    fn replacement_preserves_old_exe_as_backup(){
        let mut nonce=[0u8;8];OsRng.fill_bytes(&mut nonce);
        let dir=std::env::temp_dir().join(format!("minternet-updater-test-{:x}",u64::from_le_bytes(nonce)));
        fs::create_dir(&dir).unwrap();
        let old=dir.join("Minterest.exe");
        let new=dir.join("next.exe");
        fs::write(&old,b"old EXE").unwrap();
        fs::write(&new,b"MZ new EXE").unwrap();
        let digest=hash_file(&new).unwrap();
        let backup=replace_with_rollback(&new,&old,&digest).unwrap();
        assert_eq!(fs::read(&old).unwrap(),b"MZ new EXE");
        assert_eq!(fs::read(&backup).unwrap(),b"old EXE");
        fs::remove_dir_all(dir).unwrap();
    }
}
