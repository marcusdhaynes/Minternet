'use strict';
// Trusted browser chrome only. Web pages never receive this code or its IPC.
(() => {
  const $=id=>document.getElementById(id);
  const button=$('shieldButton');
  if(!button||!window.minternet)return;
  const fields={
    enabled:'shieldEnabled',mode:'shieldMode',blockAds:'shieldAds',
    blockTrackers:'shieldTrackers',blockVideoAds:'shieldVideoAds',
    hideAnnoyances:'shieldAnnoyances',
    hideSubscriptionOverlays:'shieldSubscriptions'
  };
  let current=null,activeHost='',popup=null,busy=false,blockedThisSession=0;
  const defaultConfig={
    enabled:true,mode:'balanced',blockAds:true,blockTrackers:true,
    blockVideoAds:true,hideAnnoyances:false,hideSubscriptionOverlays:false,
    allowSites:[],blockedDomains:[]
  };
  let config={...defaultConfig};
  const invoke=(name,payload)=>window.minternet.command(name,payload);
  function hostFromUrl(url){
    try {
      const parsed=new URL(url);
      return /^https?:$/.test(parsed.protocol)?parsed.hostname.toLowerCase():'';
    }catch{return '';}
  }
  const matched=(host,domain)=>host===domain||host.endsWith('.'+domain);
  const allowedSite=()=>!!activeHost&&config.allowSites.some(domain=>matched(activeHost,domain));
  const values=()=>({
    ...Object.fromEntries(Object.entries(fields).map(([key,id])=>
      [key,key==='mode'?$(id).value:$(id).checked])),
    allowSites:$('shieldAllowSites').value.split(/[\r\n,]+/).map(v=>v.trim()).filter(Boolean),
    blockedDomains:$('shieldBlockedDomains').value.split(/[\r\n,]+/).map(v=>v.trim()).filter(Boolean)
  });
  function renderSettings(){
    for(const [key,id] of Object.entries(fields)){
      if($(id)) {if(key==='mode')$(id).value=config[key];else $(id).checked=!!config[key];}
    }
    $('shieldAllowSites').value=(config.allowSites||[]).join('\n');
    $('shieldBlockedDomains').value=(config.blockedDomains||[]).join('\n');
  }
  function renderButton(){
    const on=config.enabled&&config.mode!=='off'&&!allowedSite();
    button.classList.toggle('shield-off',!on);
    button.setAttribute('aria-pressed',String(on));
    button.title=on?'Privacy Shield Active · Click for Controls':
      'Privacy Shield Inactive · Click for Controls';
    if(popup)paintPopup();
  }
  async function reloadSettings(){
    try {
      const value=await invoke('shield-get');
      if(value&&typeof value==='object'&&'enabled' in value){
        config={...defaultConfig,...value};
      }
      renderSettings();renderButton();
    }catch(error){
      $('shieldStatus').textContent='Could not read native Shield Settings: '+String(error);
      renderButton();
    }
  }
  async function persist(next){
    if(busy)return false;
    busy=true;
    $('shieldSave').disabled=true;
    try{
      const saved=await invoke('shield-set',next);
      if(!saved?.ok)throw Error(saved?.message||'Could not save Shield Settings');
      config={...config,...next};
      renderSettings();renderButton();
      $('shieldStatus').textContent='Saved. Existing pages updated; reload to refresh document-start rules.';
      return true;
    }catch(error){
      $('shieldStatus').textContent='Shield Settings not saved: '+String(error.message||error);
      window.minternetToast?.('Shield Settings could not be saved.');
      return false;
    }finally{
      busy=false;$('shieldSave').disabled=false;
    }
  }
  $('shieldSave').addEventListener('click',()=>void persist(values()));
  $('shieldEnabled').addEventListener('change',()=>{
    // Immediate master switch, no extra Save click required.
    void persist({...values()});
  });
  function hide(){
    if(!popup)return;
    popup.remove();popup=null;
    button.setAttribute('aria-expanded','false');
    document.removeEventListener('pointerdown',outside,true);
    document.removeEventListener('keydown',escape,true);
    if(window.__TAURI__)void invoke('chrome-overlay',false).catch(()=>{});
  }
  function outside(event){
    if(popup&&!popup.contains(event.target)&&!button.contains(event.target))hide();
  }
  function escape(event){
    if(event.key==='Escape'){event.preventDefault();hide();button.focus();}
  }
  function section(title,node){
    const wrap=document.createElement('div');
    wrap.className='shield-popup-row';
    const caption=document.createElement('span');
    caption.textContent=title;
    wrap.append(caption,node);
    return wrap;
  }
  function paintPopup(){
    if(!popup)return;
    popup.replaceChildren();
    const header=document.createElement('div');header.className='shield-popup-header';
    const title=document.createElement('strong');title.textContent='Privacy Shield';
    const count=document.createElement('small');
    count.textContent=blockedThisSession+' Native Popups Blocked';
    header.append(title,count);
    popup.append(header);
    const host=document.createElement('div');
    host.className='shield-popup-site';
    host.textContent=activeHost||'No Active Website';
    popup.append(host);
    const master=document.createElement('button');
    master.type='button';master.className='shield-popup-action';
    const enabled=config.enabled&&config.mode!=='off';
    master.textContent=enabled?'Shield On':'Shield Off';
    master.setAttribute('aria-pressed',String(enabled));
    master.onclick=()=>void persist(enabled?{...config,enabled:false}:
      {...config,enabled:true,mode:config.mode==='off'?'balanced':config.mode})
      .then(ok=>{if(ok)paintPopup();});
    popup.append(section('Global Protection',master));
    const site=document.createElement('button');
    site.type='button';site.className='shield-popup-action';
    site.disabled=!activeHost;
    site.textContent=allowedSite()?'Enable on This Site':'Disable on This Site';
    site.onclick=()=>{
      const next=new Set(config.allowSites);
      if(allowedSite()){
        for(const rule of next)if(matched(activeHost,rule))next.delete(rule);
      }else next.add(activeHost);
      void persist({...config,allowSites:[...next]}).then(ok=>{if(ok)paintPopup();});
    };
    popup.append(section('Current Website',site));
    const select=document.createElement('select');
    for(const [value,label] of [['off','Off'],['balanced','Balanced'],['strict','Strict']]){
      const option=document.createElement('option');option.value=value;option.textContent=label;
      select.append(option);
    }
    select.value=config.mode;
    select.setAttribute('aria-label','Privacy Shield Level');
    select.addEventListener('change',()=>void persist({...config,mode:select.value}));
    popup.append(section('Protection Level',select));
    const link=document.createElement('button');link.type='button';
    link.className='shield-popup-settings';link.textContent='Advanced Settings';
    link.onclick=()=>{
      hide();
      $('settings').click();
      const item=$('shieldSettings');
      const detail=item.closest('details.settings-section');
      if(detail)detail.open=true;
      item.scrollIntoView({block:'nearest'});
    };
    popup.append(link);
    const info=document.createElement('small');
    info.className='shield-popup-footnote';
    info.textContent='Blocks unwanted popups and selected ad elements. Cannot guarantee ad-free video or unlock subscriber content.';
    popup.append(info);
  }
  function position(){
    if(!popup)return;
    const rect=button.getBoundingClientRect();
    const box=popup.getBoundingClientRect();
    popup.style.left=Math.max(4,Math.min(innerWidth-box.width-4,rect.right-box.width))+'px';
    popup.style.top=Math.min(innerHeight-box.height-4,rect.bottom+5)+'px';
  }
  async function show(){
    if(popup){hide();return;}
    await reloadSettings();
    if(window.__TAURI__)await invoke('chrome-overlay',true);
    const node=document.createElement('section');
    node.id='shieldPopup';node.className='system-popup-root shield-popup';
    node.setAttribute('role','dialog');
    node.setAttribute('aria-label','Privacy Shield Controls');
    document.body.append(node);
    popup=node;
    button.setAttribute('aria-expanded','true');
    paintPopup();position();
    document.addEventListener('pointerdown',outside,true);
    document.addEventListener('keydown',escape,true);
  }
  button.addEventListener('click',()=>void show().catch(error=>{
    window.minternetToast?.(String(error));
  }));
  window.addEventListener('resize',position);
  window.minternet.onState(snapshot=>{
    const active=snapshot.tabs?.find(tab=>tab.id===snapshot.activeId);
    const next=hostFromUrl(active?.url||'');
    if(activeHost!==next){activeHost=next;renderButton();}
  });
  if(window.__TAURI__?.event?.listen){
    window.__TAURI__.event.listen('minternet:shield-blocked',event=>{
      if(event?.payload){blockedThisSession++;if(popup)paintPopup();}
    }).catch(()=>{});
  }
  void reloadSettings();
})();
