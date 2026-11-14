/* Minternet's source of update metadata is published GitHub Releases.
 * An Actions artifact is not a public release and must not be reported as one.
 * Keep network errors distinct from "already up to date" and "not published".
 */
(function () {
  'use strict';
  const REPO='marcusdhaynes/Minternet';
  const API='https://api.github.com/repos/'+REPO;
  const RELEASES='https://github.com/'+REPO+'/releases';
  const CACHE_KEY='minternet.updates.last-verified.v2';
  const REQUEST_TIMEOUT=12000;
  let installed='0.1.0'; // Only the web/demo fallback; native version comes from Rust.
  let lastStatus=null;
  let checking=null;
  const $=id=>document.getElementById(id);
  const clean=v=>String(v||'').trim().replace(/^v/i,'');
  function versionParts(v){
    const m=/^(\d+)\.(\d+)\.(\d+)(?:-build\.(\d+)(?:-g[0-9a-f]+)?)?/i.exec(clean(v));
    return m?[Number(m[1]),Number(m[2]),Number(m[3]),Number(m[4]||0)]:null;
  }
  function isNewer(candidate,current){
    const a=versionParts(candidate), b=versionParts(current);
    if(!a||!b)return false;
    for(let i=0;i<a.length;i++){if(a[i]!==b[i])return a[i]>b[i];}
    return false;
  }
  function dismissKey(version){return 'updates:dismissed:'+version;}
  function isDismissed(version){try{return localStorage.getItem(dismissKey(version))!==null;}catch{return false;}}
  function dismissVersion(version){try{localStorage.setItem(dismissKey(version),'1');}catch{}}
  async function getInstalledVersion(){
    if(window.__TAURI__&&window.minternet?.command){
      const result=await window.minternet.command('app-version');
      if(result?.version&&versionParts(result.version))installed=clean(result.version);
    }
    return installed;
  }
  function cached(){
    try{
      const parsed=JSON.parse(localStorage.getItem(CACHE_KEY)||'null');
      if(parsed&&parsed.release&&versionParts(parsed.release.version))return parsed.release;
    }catch{}
    return null;
  }
  function saveCache(release){
    try{localStorage.setItem(CACHE_KEY,JSON.stringify({release,checkedAt:Date.now()}));}catch{}
  }
  function convertRelease(data){
    if(!data||data.draft||data.prerelease||!versionParts(data.tag_name))return null;
    const assets=Array.isArray(data.assets)?data.assets:[];
    const asset=assets.find(a=>/\.exe$/i.test(a.name||'') && /Minternet-Windows-Portable/i.test(a.name||''))
      ||assets.find(a=>/\.exe$/i.test(a.name||''));
    // Only a fully published Windows build is actionable by the Windows app.
    if(window.__TAURI__ && !asset)return null;
    return {
      version:clean(data.tag_name),tag:String(data.tag_name),
      notes:String(data.body||''),url:String(data.html_url||RELEASES),
      downloadUrl:asset?.browser_download_url||null
    };
  }
  async function request(path){
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),REQUEST_TIMEOUT);
    try{
      const response=await fetch(API+path,{
        headers:{'Accept':'application/vnd.github+json'},
        cache:'no-store',signal:controller.signal
      });
      if(response.status===404)return {status:404,data:null};
      if(!response.ok)throw new Error(response.status===403||response.status===429
        ? 'GitHub temporarily limited update checks ('+response.status+').'
        : 'GitHub returned HTTP '+response.status+'.');
      return {status:response.status,data:await response.json()};
    }finally{clearTimeout(timeout);}
  }
  async function findPublishedRelease(){
    let firstError=null;
    // GitHub's /latest can return 404 when no formal Release exists. A list
    // check distinguishes this from rate limiting and malformed metadata.
    for(let attempt=0;attempt<2;attempt++){
      try{
        const latest=await request('/releases/latest');
        if(latest.data){
          const release=convertRelease(latest.data);
          if(release)return {release};
        }
        const list=await request('/releases?per_page=15');
        const releases=Array.isArray(list.data)?list.data.map(convertRelease).filter(Boolean):[];
        releases.sort((a,b)=>isNewer(a.version,b.version)?-1:isNewer(b.version,a.version)?1:0);
        if(releases[0])return {release:releases[0]};
        return {release:null,unpublished:true};
      }catch(err){
        firstError=err;
        if(attempt===0)await new Promise(ok=>setTimeout(ok,400));
      }
    }
    throw firstError||new Error('Update service unavailable.');
  }
  async function checkForUpdate(){
    if(checking)return checking;
    checking=(async()=>{
      await getInstalledVersion();
      try{
        const found=await findPublishedRelease();
        if(found.unpublished){
          lastStatus={kind:'unpublished',message:'No verified Windows release is published yet.'};
          return null;
        }
        saveCache(found.release);
        lastStatus={kind:'verified',message:'Last check succeeded.'};
        return isNewer(found.release.version,installed)?found.release:null;
      }catch(err){
        const previous=cached();
        lastStatus={kind:'offline',message:(err?.name==='AbortError'
          ? 'GitHub did not respond in time.':String(err?.message||'Unable to connect to GitHub.'))
          +(previous?' Showing the last verified release.':' Check your connection and retry.')};
        return previous&&isNewer(previous.version,installed)?{...previous,cached:true}:null;
      }
    })().finally(()=>{checking=null;});
    return checking;
  }
  async function applyUpdate(info){
    if(window.__TAURI__){
      if(!window.minternet?.command){
        window.minternetToast?.('Native update service is unavailable.');
        return;
      }
      const section=$('updatesSection');
      if(section)renderSection(section,info,'Preparing verified update…');
      const result=await window.minternet.command('update-install');
      if(result?.message){
        if(section)renderSection(section,info,result.message);
        window.minternetToast?.(result.message);
      }
      // A separate native helper performs replacement/relaunch. Do not
      // navigate away, fake installation, or open GitHub in another browser.
      return;
    }
    // The web companion is deployed through GitHub Pages.
    window.location.reload();
  }
  function renderSection(el,info,status){
    el.replaceChildren();
    const heading=document.createElement('h2');heading.textContent='Updates';el.append(heading);
    const version=document.createElement('p');version.textContent='Installed Version: v'+installed;el.append(version);
    const available=document.createElement('p');
    available.textContent='Available Version: '+(info?'v'+info.version:'—');el.append(available);
    if(info?.notes){
      const title=document.createElement('h3');title.textContent="What's New";
      const notes=document.createElement('pre');notes.textContent=info.notes;notes.style.whiteSpace='pre-wrap';
      el.append(title,notes);
    }
    const message=document.createElement('p');message.setAttribute('role','status');
    message.textContent=status||'';
    el.append(message);
    if(lastStatus?.kind==='unpublished'){
      const releaseLink=document.createElement('a');releaseLink.href=RELEASES;
      releaseLink.target='_blank';releaseLink.rel='noopener';
      releaseLink.textContent='View GitHub Releases';el.append(releaseLink);
    }
    const controls=document.createElement('div');
    const check=document.createElement('button');check.type='button';check.textContent='Check for Updates';
    check.addEventListener('click',()=>{void mountSection(el);});controls.append(check);
    if(info){
      const update=document.createElement('button');update.type='button';
      update.textContent=info.cached?'Open Last Verified Update':'Download v'+info.version;
      update.addEventListener('click',()=>applyUpdate(info));controls.append(update);
    }
    el.append(controls);
  }
  async function mountSection(el){
    renderSection(el,null,'Checking GitHub Releases…');
    const info=await checkForUpdate();
    let status;
    if(lastStatus?.kind==='unpublished')status=lastStatus.message;
    else if(lastStatus?.kind==='offline')status=lastStatus.message;
    else status=info?'Verified update available.':'Up to date — verified against GitHub Releases.';
    renderSection(el,info,status);
  }
  function mountRibbon(info){
    if($('museUpdateRibbon')||!info||info.cached)return;
    const ribbon=document.createElement('div');ribbon.id='museUpdateRibbon';
    ribbon.setAttribute('role','button');
    ribbon.setAttribute('aria-label','Update available, version '+info.version);
    ribbon.style.cssText='position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;align-items:center;gap:8px;padding:3px 6px 3px 12px;border-radius:999px;font-size:12px;line-height:1.4;background:rgba(127,127,127,.16);border:1px solid rgba(127,127,127,.35);backdrop-filter:blur(6px);cursor:pointer;';
    const label=document.createElement('span');label.textContent='Update available · v'+info.version;
    const close=document.createElement('button');close.type='button';close.textContent='×';
    close.setAttribute('aria-label','Dismiss this update');
    close.addEventListener('click',event=>{event.stopPropagation();dismissVersion(info.version);ribbon.remove();});
    ribbon.append(label,close);ribbon.addEventListener('click',()=>applyUpdate(info));
    document.body.append(ribbon);
  }
  // Download progress and errors originate in the trusted native updater.
  // An installed browser remains open if verification or helper startup fails.
  if(window.__TAURI__?.event?.listen){
    void window.__TAURI__.event.listen('minternet:update',event=>{
      const payload=event.payload||{};
      const section=$('updatesSection');
      if(section){
        const status=section.querySelector('[role="status"]');
        if(status)status.textContent=String(payload.message||'');
      }
      if(payload.kind==='error')window.minternetToast?.(String(payload.message||'Update failed'));
    }).catch(()=>{});
  }
  window.MuseUpdates={
    get CURRENT_VERSION(){return installed;},isNewer,checkForUpdate,applyUpdate,mountSection,mountRibbon,
    get lastStatus(){return lastStatus;}
  };
  async function init(){
    const el=$('updatesSection');
    if(el)await mountSection(el);
    else await getInstalledVersion();
    const info=await checkForUpdate();
    if(info&&!isDismissed(info.version))mountRibbon(info);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>void init());
  else void init();
})();
