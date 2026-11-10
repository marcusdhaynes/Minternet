//! Minternet's opt-in content controls. Never exposes the browser's native
//! command bridge, browsing history, passwords or profile data to a webpage.
use serde::{Deserialize,Serialize};
use std::{path::PathBuf,collections::HashSet,sync::Mutex};
use tauri::Manager;

#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",default)]
pub struct ShieldConfig {
    pub enabled:bool,
    pub mode:String,
    pub block_ads:bool,
    pub block_trackers:bool,
    pub block_video_ads:bool,
    pub hide_annoyances:bool,
    pub hide_subscription_overlays:bool,
    pub allow_sites:Vec<String>,
    pub blocked_domains:Vec<String>,
}
impl Default for ShieldConfig {
    fn default()->Self {
        Self{enabled:true, mode:"balanced".into(),block_ads:true,
            block_trackers:true,block_video_ads:true,hide_annoyances:false,
            hide_subscription_overlays:false,allow_sites:vec![],
            blocked_domains:vec![]}
    }
}
pub struct ShieldState(pub Mutex<ShieldConfig>);

fn valid_hostname(host:&str)->bool{
    host.len()<=253&&!host.is_empty()&&
    host.split('.').all(|part|!part.is_empty()&&part.len()<=63&&
        !part.starts_with('-')&&!part.ends_with('-')&&
        part.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'-'))
}
fn normalize(host:&str)->Option<String>{
    let s=host.trim().to_ascii_lowercase();
    let value=if s.contains("://"){
        tauri::Url::parse(&s).ok()?.host_str()?.to_ascii_lowercase()
    }else{s};
    let value=value.trim_end_matches('.').to_string();
    if valid_hostname(&value){Some(value)}else{None}
}
fn sanitize(mut config:ShieldConfig)->ShieldConfig {
    if !matches!(config.mode.as_str(),"off"|"balanced"|"strict"){
        config.mode="balanced".into();
    }
    fn unique(values:Vec<String>)->Vec<String>{
        let mut seen=HashSet::new();
        values.into_iter().filter_map(|s|normalize(&s))
            .filter(|s|seen.insert(s.clone())).take(200).collect()
    }
    config.allow_sites=unique(config.allow_sites);
    config.blocked_domains=unique(config.blocked_domains);
    config
}
pub fn host_matches(host:&str,entry:&str)->bool{
    host==entry || host.strip_suffix(entry).is_some_and(|prefix|prefix.ends_with('.'))
}
pub fn is_allowed(config:&ShieldConfig,host:&str)->bool{
    config.allow_sites.iter().any(|s|host_matches(host,s))
}
fn built_in_popup(host:&str)->bool{
    ["popads.net","popcash.net","propellerads.com","onclickads.net",
     "exoclick.com","trafficstars.com","adsterra.com","ad-maven.com"]
    .iter().any(|s|host_matches(host,s))
}
pub fn block_popup(config:&ShieldConfig,source:&str,target:&str)->bool{
    if !config.enabled||config.mode=="off"{return false;}
    let Some(target_host)=tauri::Url::parse(target).ok()
        .and_then(|u|u.host_str().map(str::to_ascii_lowercase)) else{return false};
    let source_host=tauri::Url::parse(source).ok()
        .and_then(|u|u.host_str().map(str::to_ascii_lowercase))
        .unwrap_or_default();
    if is_allowed(config,&source_host)||is_allowed(config,&target_host){return false;}
    if config.blocked_domains.iter().any(|s|host_matches(&target_host,s)) {return true;}
    if config.block_ads && built_in_popup(&target_host){return true;}
    // Strict blocks third-party popups, not normal in-page navigations.
    config.mode=="strict" && !source_host.is_empty() &&
        !host_matches(&target_host,&source_host) && !host_matches(&source_host,&target_host)
}
pub fn block_navigation(config:&ShieldConfig,target:&tauri::Url)->bool{
    if !config.enabled||config.mode=="off"{return false;}
    let Some(host)=target.host_str().map(str::to_ascii_lowercase) else{return false};
    if is_allowed(config,&host){return false;}
    config.blocked_domains.iter().any(|s|host_matches(&host,s))
}
fn file(app:&tauri::AppHandle)->Result<PathBuf,String>{
    Ok(app.path().app_data_dir().map_err(|e|e.to_string())?
        .join("privacy-shield.v1.json"))
}
pub fn load(app:&tauri::AppHandle)->ShieldConfig{
    let Ok(path)=file(app) else{return ShieldConfig::default()};
    let Ok(bytes)=std::fs::read(path) else{return ShieldConfig::default()};
    if bytes.len()>100_000{return ShieldConfig::default();}
    serde_json::from_slice::<ShieldConfig>(&bytes)
        .map(sanitize).unwrap_or_default()
}
pub fn save(app:&tauri::AppHandle,config:&ShieldConfig)->Result<(),String>{
    let target=file(app)?;
    if let Some(parent)=target.parent(){std::fs::create_dir_all(parent).map_err(|e|e.to_string())?;}
    let data=serde_json::to_vec(config).map_err(|e|e.to_string())?;
    let temp=target.with_extension("tmp");
    std::fs::write(&temp,data).map_err(|e|e.to_string())?;
    if std::fs::rename(&temp,&target).is_err(){
        std::fs::copy(&temp,&target).map_err(|e|e.to_string())?;
        std::fs::remove_file(temp).ok();
    }
    Ok(())
}
pub fn parse_config(value:&serde_json::Value)->Result<ShieldConfig,String>{
    let config=serde_json::from_value::<ShieldConfig>(value.clone())
        .map_err(|e|format!("Invalid Shield Settings: {e}"))?;
    if config.allow_sites.len()>200||config.blocked_domains.len()>200{
        return Err("Maximum 200 site rules per list".into());
    }
    Ok(sanitize(config))
}
// Browser content is untrusted. The script deliberately has no native IPC,
// no token access, no secret transport, and no page text exfiltration.
// Network-level filter list interception is not implemented by this script.
const SCRIPT:&str=r###"
(() => {
  'use strict';
  const options=__MINTERNET_SHIELD_CONFIG__;
  const hostname=location.hostname.toLowerCase();
  const domainMatches=(value,rule)=>value===rule||value.endsWith('.'+rule);
  const bypass=options.allowSites.some(rule=>domainMatches(hostname,rule));
  let active=!!(options.enabled&&options.mode!=='off'&&!bypass);
  if(window.__minternetShieldVersion===1){
    window.__minternetShieldUpdate?.(options);
    return;
  }
  window.__minternetShieldVersion=1;
  let configuration=options;
  const permitted=()=>configuration.allowSites.some(rule=>domainMatches(location.hostname.toLowerCase(),rule));
  const enabled=()=>configuration.enabled&&configuration.mode!=='off'&&!permitted();
  const adHosts=['popads.net','popcash.net','onclickads.net','adsterra.com','propellerads.com','doubleclick.net','googlesyndication.com','adnxs.com','taboola.com','outbrain.com'];
  const blockedHost=(url)=>{
    try{
      const resolved=new URL(String(url),location.href);
      const target=resolved.hostname.toLowerCase();
      return configuration.blockedDomains.some(rule=>domainMatches(target,rule))||
        ((configuration.blockAds||configuration.blockTrackers)&&
          adHosts.some(rule=>domainMatches(target,rule)));
    }catch{return false;}
  };
  const authenticating=url=>{
    try {
      const u=new URL(String(url),location.href);
      const h=u.hostname.toLowerCase();
      return u.protocol==='about:' ||
        ['accounts.google.com','login.microsoftonline.com','appleid.apple.com',
         'github.com','auth0.com','firebaseapp.com'].some(rule=>domainMatches(h,rule)) ||
        /\/(oauth|authorize|auth\/handler)(\/|$|\?)/i.test(u.pathname);
    } catch {return String(url)==='about:blank';}
  };
  // Genuine window.open links and OAuth popups keep their opener relationship.
  const originalOpen=window.open;
  if(typeof originalOpen==='function'){
    try{
      window.open=function(url,...args){
        if(enabled()&&!authenticating(url)){
          const activated=navigator.userActivation?.isActive===true;
          const suspicious=blockedHost(url);
          if(suspicious || (!activated && (configuration.mode==='strict'||configuration.mode==='balanced')))return null;
        }
        return Reflect.apply(originalOpen,this,[url,...args]);
      };
    }catch{}
  }
  const styleId='minternet-shield-cosmetics';
  const cssFor=()=>{
    if(!enabled())return '';
    const rules=[];
    if(configuration.blockAds)rules.push(
      '[id="google_ads_iframe"], [id^="google_ads_iframe_"], [data-ad-unit], .adsbygoogle, iframe[src*="doubleclick.net"], iframe[src*="googlesyndication.com"], ytd-ad-slot-renderer, ytd-promoted-video-renderer, #player-ads, #masthead-ad, .ytp-ad-overlay-container');
    if(configuration.hideAnnoyances)rules.push(
      '[id="newsletter-popup"], [class~="newsletter-modal"], [id="subscribe-modal"], [data-testid="newsletter-popup"]');
    if(configuration.hideSubscriptionOverlays)rules.push(
      '.paywall-overlay, .subscription-overlay, .tp-modal, [id="paywall-overlay"], [data-testid="paywall-overlay"]');
    return rules.map(rule=>rule+'{display:none!important;visibility:hidden!important;}').join('\n');
  };
  function updateStyle(){
    let element=document.getElementById(styleId);
    if(!element && document.documentElement){
      element=document.createElement('style');element.id=styleId;
      (document.head||document.documentElement).appendChild(element);
    }
    if(element)element.textContent=cssFor();
  }
  function examine(){
    if(!enabled())return;
    if(configuration.blockAds||configuration.blockTrackers){
      document.querySelectorAll('iframe[src]').forEach(el=>{
        if(blockedHost(el.getAttribute('src'))){el.removeAttribute('src');el.remove();}
      });
    }
    if(configuration.blockVideoAds && (hostname==='youtube.com'||hostname.endsWith('.youtube.com'))){
      // Click visible skip controls; never remove or replace the video player.
      const selector='.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button';
      const skip=document.querySelector(selector);
      if(skip && skip.getBoundingClientRect().width>0)skip.click();
    }
  }
  let last=0;
  const settle=()=>{
    const now=Date.now();
    if(now-last<750)return;
    last=now;
    updateStyle();examine();
  };
  window.__minternetShieldUpdate=config=>{
    configuration=config;
    updateStyle();
    examine();
  };
  if(document.documentElement){
    updateStyle();
    new MutationObserver(settle).observe(document.documentElement,
      {childList:true,subtree:true});
  }else {
    document.addEventListener('DOMContentLoaded',()=>{
      updateStyle();
      new MutationObserver(settle).observe(document.documentElement,
        {childList:true,subtree:true});
    },{once:true});
  }
  document.addEventListener('DOMContentLoaded',settle,{once:true});
  setInterval(()=>{if(document.visibilityState==='visible')examine();},3000);
})()
"###;
pub fn script(config:&ShieldConfig)->String {
    let json=serde_json::to_string(config).unwrap_or_else(|_|"{}".into());
    SCRIPT.replace("__MINTERNET_SHIELD_CONFIG__",&json)
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn strict_and_allowlist() {
        let mut p=ShieldConfig{mode:"strict".into(),..Default::default()};
        assert!(block_popup(&p,"https://example.com/","https://ads.other.com/"));
        assert!(!block_popup(&p,"https://example.com/","https://example.com/next"));
        p.allow_sites.push("example.com".into());
        assert!(!block_popup(&p,"https://example.com/","https://ads.other.com/"));
    }
    #[test]
    fn domains_are_exact_or_subdomains(){
        assert!(host_matches("a.google.com","google.com"));
        assert!(!host_matches("notgoogle.com","google.com"));
        assert!(!host_matches("google.com.evil.test","google.com"));
    }
    #[test]
    fn rejects_untrusted_config_values(){
        let p=parse_config(&serde_json::json!({"mode":"nonsense","allowSites":["https://example.com/path","a..com"],"blockedDomains":["bad.com"]})).unwrap();
        assert_eq!(p.mode,"balanced");
        assert_eq!(p.allow_sites,vec!["example.com"]);
    }
}
