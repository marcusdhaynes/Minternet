//! Read-only update discovery. Browser UI never fetches release metadata
//! itself: native Rust checks first-party GitHub Releases off the UI thread.
use serde_json::{json,Value};
use std::{io::Read,time::Duration};

const RELEASES_API:&str="https://api.github.com/repos/marcusdhaynes/Minternet/releases?per_page=30";
const RELEASE_ASSET_PREFIX:&str="https://github.com/marcusdhaynes/Minternet/releases/download/";
const MAX_RESPONSE:u64=2_000_000;
const APP_VERSION:&str=env!("CARGO_PKG_VERSION");
const BUILD_RUN_ID:&str=match option_env!("MINTERNET_BUILD_RUN_ID"){Some(v)=>v,None=>"0"};
const BUILD_SHA:&str=match option_env!("MINTERNET_BUILD_SHA"){Some(v)=>v,None=>"local"};

pub fn installed()->Value{
    json!({"version":APP_VERSION,"buildId":BUILD_RUN_ID,"commit":BUILD_SHA})
}
fn parse_tag(tag:&str)->Option<u64>{
    tag.strip_prefix("minternet-build-")?.parse::<u64>().ok()
}
fn older_than_installed(candidate:u64)->bool{
    let id=BUILD_RUN_ID.parse::<u64>().unwrap_or(0);
    id!=0 && candidate<=id
}
fn acceptable_asset(entry:&Value)->Option<String>{
    let name=entry.get("name")?.as_str()?;
    if !name.ends_with(".exe") || !name.starts_with("Minternet-") ||
        name.to_ascii_lowercase().contains("setup"){return None;}
    let url=entry.get("browser_download_url")?.as_str()?;
    if !url.starts_with(RELEASE_ASSET_PREFIX){return None;}
    Some(url.to_owned())
}
fn extract(releases:&Value)->Result<Value,String>{
    let list=releases.as_array().ok_or("GitHub returned invalid release data")?;
    let mut newest:Option<(u64,Value)>=None;
    for release in list{
        if release.get("draft").and_then(Value::as_bool)!=Some(false){continue;}
        let tag=release.get("tag_name").and_then(Value::as_str).unwrap_or("");
        let Some(run_id)=parse_tag(tag) else{continue};
        if older_than_installed(run_id){continue;}
        let asset=release.get("assets").and_then(Value::as_array)
            .and_then(|items|items.iter().find_map(acceptable_asset));
        let Some(url)=asset else{continue};
        let page=release.get("html_url").and_then(Value::as_str).unwrap_or("");
        if !page.starts_with("https://github.com/marcusdhaynes/Minternet/releases/tag/"){continue;}
        let notes=release.get("body").and_then(Value::as_str).unwrap_or("");
        let notes=notes.chars().take(6000).collect::<String>();
        let value=json!({
            "version":APP_VERSION,"buildId":run_id.to_string(),
            "tag":tag,"notes":notes,"url":page,"downloadUrl":url
        });
        if newest.as_ref().is_none_or(|(id,_)|run_id>*id){newest=Some((run_id,value));}
    }
    let update=newest.map(|(_,v)|v).unwrap_or(Value::Null);
    Ok(json!({"installed":installed(),"update":update}))
}
pub fn check()->Result<Value,String>{
    let agent=ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(6))
        .timeout_read(Duration::from_secs(8))
        .timeout_write(Duration::from_secs(6))
        .redirects(0).build();
    let response=agent.get(RELEASES_API)
        .set("User-Agent","Minternet-Update-Checker")
        .set("Accept","application/vnd.github+json")
        .set("X-GitHub-Api-Version","2022-11-28")
        .call()
        .map_err(|error|format!("GitHub release check failed: {error}"))?;
    let mut bytes=Vec::new();
    response.into_reader().take(MAX_RESPONSE+1).read_to_end(&mut bytes)
        .map_err(|error|format!("Could not read releases: {error}"))?;
    if bytes.len() as u64>MAX_RESPONSE{return Err("Release feed is too large".into());}
    let value:Value=serde_json::from_slice(&bytes).map_err(|_|"Invalid GitHub release response")?;
    extract(&value)
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn selects_highest_available_versioned_windows_release(){
        let good=json!([{
          "tag_name":"minternet-build-900","draft":false,
          "html_url":"https://github.com/marcusdhaynes/Minternet/releases/tag/minternet-build-900",
          "assets":[{"name":"Minternet-Windows-Portable-v0.3.0-build.2.exe",
          "browser_download_url":"https://github.com/marcusdhaynes/Minternet/releases/download/minternet-build-900/Minternet-Windows-Portable-v0.3.0-build.2.exe"}],
          "body":"Fixes"
        }]);
        if !older_than_installed(900){
            assert_eq!(extract(&good).unwrap()["update"]["buildId"],"900");
        }
        assert!(parse_tag("minternet-build-42")==Some(42));
        assert_eq!(parse_tag("v1.0.0"),None);
    }
    #[test]
    fn rejects_external_download_domains(){
        let invalid=json!({"name":"Minternet.exe",
          "browser_download_url":"https://evil.example/download/minternet.exe"});
        assert!(acceptable_asset(&invalid).is_none());
    }
}
