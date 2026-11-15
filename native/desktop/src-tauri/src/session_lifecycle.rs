//! Per-process lifecycle markers. Only a definitely dead *prior* process is
//! considered interrupted. Never infer a crash from a legacy marker or a
//! second Minternet window that is still running.
use std::{fs,path::Path,process};

const OLD_MARKER:&str="minternet-running.v1";
const PREFIX:&str="minternet-running.v2.";
const SUFFIX:&str=".guard";

fn marker(pid:u32)->String{format!("{PREFIX}{pid}{SUFFIX}")}

#[cfg(windows)]
fn is_running(pid:u32)->bool{
    use std::ffi::c_void;
    #[link(name="kernel32")]
    extern "system"{
        fn OpenProcess(access:u32,inherit:i32,pid:u32)->*mut c_void;
        fn GetExitCodeProcess(handle:*mut c_void,code:*mut u32)->i32;
        fn CloseHandle(handle:*mut c_void)->i32;
        fn GetLastError()->u32;
    }
    // A denied query is *unknown*, not proof of a crash.
    let process_handle=unsafe{OpenProcess(0x1000,0,pid)};
    if process_handle.is_null(){return unsafe{GetLastError()}!=87;}
    let mut exit_code=0u32;
    let ok=unsafe{GetExitCodeProcess(process_handle,&mut exit_code)};
    unsafe{CloseHandle(process_handle)};
    ok==0 || exit_code==259
}
#[cfg(target_os="linux")]
fn is_running(pid:u32)->bool{
    Path::new(&format!("/proc/{pid}")).exists()
}
#[cfg(not(any(windows,target_os="linux")))]
fn is_running(_pid:u32)->bool{true}

// Deterministic function for unit testing. Each instance owns its marker;
// closing one window cannot erase another running instance's marker.
fn scan_prior(dir:&Path,current:u32,live:impl Fn(u32)->bool)->bool{
    let mut interrupted=false;
    let Ok(entries)=fs::read_dir(dir) else{return false};
    for entry in entries.flatten(){
        let name=entry.file_name();
        let name=name.to_string_lossy();
        let Some(pid)=name.strip_prefix(PREFIX)
            .and_then(|s|s.strip_suffix(SUFFIX))
            .and_then(|s|s.parse::<u32>().ok()) else{continue};
        if pid==current || live(pid){continue;}
        // Only files matching this exact product-owned numeric name are
        // cleaned; this never touches cookies, WebView2 or user storage.
        if fs::remove_file(entry.path()).is_ok(){interrupted=true;}
    }
    interrupted
}

pub fn mark_started(dir:&Path)->bool{
    let _=fs::create_dir_all(dir);
    // V1 never tracked a PID. Its existence does not prove a crash, and it
    // was also left behind by our updater on normal replacement.
    let _=fs::remove_file(dir.join(OLD_MARKER));
    let pid=process::id();
    let interrupted=scan_prior(dir,pid,is_running);
    let _=fs::write(dir.join(marker(pid)),format!("pid={pid}\n"));
    interrupted
}

pub fn mark_clean_exit(dir:&Path){
    let _=fs::remove_file(dir.join(marker(process::id())));
}

#[cfg(test)]
mod tests{
    use super::*;
    fn directory()->std::path::PathBuf{
        let d=std::env::temp_dir().join(format!(
            "minternet-lifecycle-test-{}-{}",process::id(),
            std::time::SystemTime::now().duration_since(
                std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&d).unwrap();d
    }
    #[test]
    fn legacy_update_marker_does_not_claim_crash(){
        let dir=directory();
        fs::write(dir.join(OLD_MARKER),"old marker").unwrap();
        assert!(!scan_prior(&dir,999,|_|false));
        let _=fs::remove_dir_all(dir);
    }
    #[test]
    fn running_secondary_window_is_not_a_crash(){
        let dir=directory();
        fs::write(dir.join(marker(111)),"pid=111").unwrap();
        assert!(!scan_prior(&dir,222,|pid|pid==111));
        assert!(dir.join(marker(111)).is_file());
        let _=fs::remove_dir_all(dir);
    }
    #[test]
    fn dead_old_process_is_recovered_but_other_files_survive(){
        let dir=directory();
        fs::write(dir.join(marker(111)),"pid=111").unwrap();
        fs::write(dir.join("browser-session.v1.json"),"{}").unwrap();
        assert!(scan_prior(&dir,222,|_|false));
        assert!(!dir.join(marker(111)).exists());
        assert!(dir.join("browser-session.v1.json").exists());
        let _=fs::remove_dir_all(dir);
    }
    #[test]
    fn cannot_delete_own_process_or_other_apps_markers(){
        let dir=directory();
        fs::write(dir.join(marker(222)),"pid=222").unwrap();
        fs::write(dir.join("minternet-running.v2.not-pid.guard"),"x").unwrap();
        assert!(!scan_prior(&dir,222,|_|false));
        assert!(dir.join(marker(222)).is_file());
        assert!(dir.join("minternet-running.v2.not-pid.guard").exists());
        let _=fs::remove_dir_all(dir);
    }
}
