'use strict';
// Browser preferences belong to Minternet's native profile, not the website
// storage profile. New tabs and downloaded files use these preferences even
// when a page script is busy, a private tab is open, or the app restarts.
(() => {
  const $=id=>document.getElementById(id);
  const api=window.minternet;
  if(!api)return;
  const home=$('homePageUrl'),saveHome=$('homePageSave');
  const folder=$('downloadFolderPath'),saveFolder=$('downloadFolderSave');
  const reset=$('downloadFolderDefault'),status=$('browserPreferencesStatus');
  const tabLimit=$('tabLimit'),saveTabLimit=$('tabLimitSave');
  if(!home||!saveHome||!folder||!saveFolder||!reset||!status||!tabLimit||!saveTabLimit)return;
  const defaultHome='https://www.google.com/';
  const newTabMode=$('newTabMode');
  const report=message=>{
    status.hidden=!message;status.textContent=String(message||'');
    if(message?.length)window.minternetToast?.(message);
  };
  function setBusy(busy){
    saveHome.disabled=saveFolder.disabled=reset.disabled=saveTabLimit.disabled=Boolean(busy);
  }
  async function invoke(command,payload){
    const result=await api.command(command,payload);
    if(result?.message)throw Error(result.message);
    return result;
  }
  function normalizeHome(input){
    const trimmed=String(input||'').trim();
    if(!trimmed)return defaultHome;
    return /^https?:\/\//i.test(trimmed)?trimmed:'https://'+trimmed;
  }
  async function refresh(){
    if(!window.__TAURI__){
      home.value=defaultHome;
      folder.placeholder='System Downloads folder (native app only)';
      try {
        const result=await invoke('tab-limit-get');
        tabLimit.value=String(result?.tabLimit??0);
      } catch { tabLimit.value='0'; }
      return;
    }
    try{
      const settings=await invoke('browser-preferences');
      home.value=settings.homepage||defaultHome;
      if(newTabMode)newTabMode.value=settings.newTabMode==='website'?'website':'dashboard';
      tabLimit.value=String(settings.tabLimit??0);
      folder.value=settings.usingSystemDownloads?'':settings.downloadFolder||'';
      folder.placeholder=settings.usingSystemDownloads
        ?settings.downloadFolder||'System Downloads folder'
        :'Enter absolute folder path';
    }catch(e){report('Could not load browser preferences: '+String(e.message||e));}
  }
  async function updateHome(){
    setBusy(true);
    try{
      const target=normalizeHome(home.value);
      const result=await invoke('browser-homepage-set',target);
      if(!result?.ok)throw Error('Homepage was not saved');
      home.value=result.homepage;
      report('Home Page saved. Future tabs open '+result.homepage);
    }catch(e){report('Home Page was not changed: '+String(e.message||e));}
    finally{setBusy(false);}
  }
  async function updateDownloads(useDefault=false){
    setBusy(true);
    try{
      const selected=useDefault?'':folder.value.trim();
      if(!useDefault&&!selected)throw Error('Enter a folder path or press Default');
      const result=await invoke('downloads-folder-set',selected);
      if(!result?.ok)throw Error('Downloads folder was not saved');
      folder.value=result.usingSystemDownloads?'':result.downloadFolder;
      folder.placeholder=result.usingSystemDownloads
        ?result.downloadFolder:'Enter absolute folder path';
      report('Downloads will save automatically to '+result.downloadFolder);
    }catch(e){report('Downloads folder was not changed: '+String(e.message||e));}
    finally{setBusy(false);}
  }
  async function updateTabLimit(){
    const n=Number(tabLimit.value);
    if(tabLimit.value.trim()===''||!Number.isSafeInteger(n)||n<0||n>1000000){
      report('Tab Limit must be a whole number from 0 to 1000000.');
      return;
    }
    setBusy(true);
    try{
      const result=await invoke('tab-limit-set',n);
      if(!result?.ok)throw Error('Tab Limit was not saved');
      tabLimit.value=String(result.tabLimit);
      report(n===0?'Tab Limit saved: Unlimited.':'Tab Limit saved: '+n+'.');
    }catch(e){report('Tab Limit was not changed: '+String(e.message||e));}
    finally{setBusy(false);}
  }
  saveTabLimit.addEventListener('click',()=>void updateTabLimit());
  tabLimit.addEventListener('keydown',event=>{
    if(event.key==='Enter'){event.preventDefault();void updateTabLimit();}
  });
  newTabMode?.addEventListener('change',async()=>{
    newTabMode.disabled=true;
    try{
      const result=await invoke('browser-new-tab-mode-set',newTabMode.value);
      if(!result?.ok)throw Error('Could not update New Tab Page');
      report(newTabMode.value==='dashboard'
        ?'New tabs now open the zero-renderer Dashboard.'
        :'New tabs now open your configured website.');
    }catch(error){
      report('New Tab mode not saved: '+String(error.message||error));
      await refresh();
    }finally{newTabMode.disabled=false;}
  });
  saveHome.addEventListener('click',()=>void updateHome());
  home.addEventListener('keydown',event=>{
    if(event.key==='Enter'){event.preventDefault();void updateHome();}
  });
  saveFolder.addEventListener('click',()=>void updateDownloads());
  reset.addEventListener('click',()=>void updateDownloads(true));
  folder.addEventListener('keydown',event=>{
    if(event.key==='Enter'){event.preventDefault();void updateDownloads();}
  });
  void refresh();
  window.minternetBrowserPreferences={refresh};
})();