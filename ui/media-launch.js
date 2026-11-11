'use strict';
// The icon invokes the native operating-system Open File dialog directly.
// No hidden input, synthetic click, WebView2 picker or intermediate window.
(()=>{
  const button=document.getElementById('mediaPlayerButton');
  if(!button)return;
  function report(message){
    if(typeof window.minternetToast==='function'){
      window.minternetToast(message);
    }
    let alert=document.getElementById('minternetMediaStatus');
    if(!alert){
      alert=document.createElement('div');
      alert.id='minternetMediaStatus';
      alert.setAttribute('role','alert');
      alert.hidden=true;
      document.body.appendChild(alert);
    }
    alert.textContent=message;
    alert.hidden=false;
    setTimeout(()=>{alert.hidden=true;},8500);
  }
  let busy=false;
  button.addEventListener('click',async()=>{
    if(busy)return;
    busy=true;button.disabled=true;button.setAttribute('aria-busy','true');
    try{
      const invoke=window.__TAURI__?.core?.invoke;
      if(!invoke)throw Error('Native file picker unavailable in this preview');
      const result=await invoke('browser_action',{name:'media-player-pick',value:null});
      if(result?.cancelled)return;
      if(!result?.ok)throw Error(result?.message||'Media selection could not start');
    }catch(error){
      report('Media player: '+String(error?.message||error));
    }finally{
      busy=false;button.disabled=false;button.removeAttribute('aria-busy');
    }
  });
})();
