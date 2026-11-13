'use strict';
// All actions run in the trusted chrome WebView. Websites have no access to
// these commands, local paths or installed-extension metadata.
(() => {
  const api=window.minternet;
  const trigger=document.getElementById('extensionsButton');
  const panel=document.getElementById('extensionsPanel');
  const closeButton=document.getElementById('extensionsClose');
  const list=document.getElementById('extensionsInstalled');
  const status=document.getElementById('extensionsStatus');
  if(!api||!trigger||!panel||!closeButton||!list||!status)return;
  let loading=false,active=false;
  function say(message){
    status.textContent=String(message||'');
    if(message&&panel.hidden)window.minternetToast?.(message);
  }
  function close(){
    if(panel.hidden)return;
    panel.hidden=true;
    trigger.setAttribute('aria-expanded','false');
    document.removeEventListener('pointerdown',outside,true);
    document.removeEventListener('keydown',key,true);
    if(window.__TAURI__)void api.command('chrome-overlay',false).catch(()=>{});
  }
  function outside(event){
    if(!panel.hidden&&!panel.contains(event.target)&&!trigger.contains(event.target))close();
  }
  function key(event){if(event.key==='Escape'){event.preventDefault();close();trigger.focus();}}
  function position(){
    if(panel.hidden)return;
    const rect=trigger.getBoundingClientRect();
    const width=panel.offsetWidth||486;
    panel.style.left=Math.max(5,Math.min(window.innerWidth-width-5,rect.left-width/2+rect.width/2))+'px';
    panel.style.top=Math.max(4,Math.min(window.innerHeight-35,rect.bottom+5))+'px';
    const maxHeight=Math.max(180,window.innerHeight-(rect.bottom+13));
    panel.style.maxHeight=maxHeight+'px';
  }
  function make(tag,cls,text){
    const el=document.createElement(tag);
    if(cls)el.className=cls;
    if(text!==undefined)el.textContent=String(text);
    return el;
  }
  function row(entry){
    const outer=make('div','extensions-installed-row');
    const detail=make('div','extensions-installed-detail');
    const title=make('strong','',entry.name||'Unnamed extension');
    const meta=make('small','',entry.source+' · v'+(entry.version||'?')+
      ' · '+(entry.enabled?'Enabled after restart':'Disabled after restart'));
    detail.append(title,meta);
    if(Array.isArray(entry.permissions)&&entry.permissions.length){
      detail.append(make('small','extensions-permissions',
        'Permissions: '+entry.permissions.slice(0,8).join(', ')));
    }
    const toggle=make('button','extensions-action',entry.enabled?'Disable':'Enable');
    toggle.type='button';toggle.setAttribute('aria-label',(entry.enabled?'Disable ':'Enable ')+entry.name);
    toggle.addEventListener('click',()=>void modify('extensions-toggle',{
      id:entry.id,source:entry.source,enabled:!entry.enabled
    }));
    const remove=make('button','extensions-action extensions-remove','Remove');
    remove.type='button';remove.setAttribute('aria-label','Remove '+entry.name);
    remove.addEventListener('click',()=>void modify('extensions-remove',{
      id:entry.id,source:entry.source
    }));
    outer.append(detail,toggle,remove);
    return outer;
  }
  async function refresh(){
    try {
      const result=await api.command('extensions-list');
      if(result?.message)throw Error(result.message);
      list.replaceChildren();
      const extensions=Array.isArray(result?.extensions)?result.extensions:[];
      if(!extensions.length)list.append(make('p','extensions-empty','No extensions imported'));
      else for(const item of extensions)list.append(row(item));
      if(result?.platformSupported===false){
        say('Extension installation currently requires Windows WebView2.');
      }
    }catch(error){
      say('Could not load extension list: '+String(error?.message||error));
    }
  }
  async function modify(name,payload){
    if(loading)return;
    loading=true;
    try{
      const result=await api.command(name,payload);
      if(result?.message)throw Error(result.message);
      say('Extension updated. Restart Minternet to apply this change.');
      await refresh();
    }catch(error){say('Extension change failed: '+String(error?.message||error));}
    finally{loading=false;}
  }
  async function importExtension(source,button){
    if(loading)return;
    loading=true;button.disabled=true;
    say('Choose a '+source+' extension package…');
    try{
      const result=await api.command('extensions-import',source);
      if(result?.message)throw Error(result.message);
      if(result?.cancelled){say('Import cancelled.');return;}
      if(!result?.ok)throw Error('No extension was imported');
      say((result.extension?.name||'Extension')+' imported. Restart Minternet to activate it.');
      await refresh();
    }catch(error){say('Import failed: '+String(error?.message||error));}
    finally{loading=false;button.disabled=false;}
  }
  async function store(url){
    close();
    try{
      const result=await api.command('new-url',url);
      if(result?.message)throw Error(result.message);
    }catch(error){window.minternetToast?.('Could not open extension store: '+String(error?.message||error));}
  }
  async function open(){
    if(!panel.hidden){close();return;}
    active=true;
    panel.hidden=false;
    trigger.setAttribute('aria-expanded','true');
    if(window.__TAURI__)void api.command('chrome-overlay',true).catch(()=>{});
    position();
    document.addEventListener('pointerdown',outside,true);
    document.addEventListener('keydown',key,true);
    await refresh();
    position();
  }
  trigger.addEventListener('click',()=>void open());
  closeButton.addEventListener('click',close);
  for(const button of panel.querySelectorAll('[data-extension-import]')){
    button.addEventListener('click',()=>void importExtension(button.dataset.extensionImport,button));
  }
  document.getElementById('firefoxExtensionStore')?.addEventListener('click',()=>void store('https://addons.mozilla.org/en-US/firefox/'));
  document.getElementById('chromeExtensionStore')?.addEventListener('click',()=>void store('https://chromewebstore.google.com/'));
  window.addEventListener?.('blur',()=>{if(!panel.hidden)close();});
  window.addEventListener('resize',position);
  window.minternetExtensions={open,close,refresh};
})();
