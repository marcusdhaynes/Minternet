'use strict';
(() => {
  const $=id=>document.getElementById(id),api=window.minternet;
  if(!api)return;
  const levels=[25,30,50,67,70,75,80,90,100,110,125,150,175,200,250,300,400,500];
  let zoom=100;
  try{const saved=Number(localStorage.getItem('minternet.zoom.v1'));if(levels.includes(saved))zoom=saved;}catch{}
  function display(){if($('zoomLevel'))$('zoomLevel').textContent=zoom+'%';}
  async function setZoom(value){
    const next=Math.min(500,Math.max(25,value));
    if(!Number.isFinite(next))return;
    const response=await api.command('zoom',next/100);
    if(response?.message){window.minternetToast?.(response.message);return;}
    zoom=next;display();
    try{localStorage.setItem('minternet.zoom.v1',String(zoom));}catch{}
  }
  function step(direction){
    const ascending=direction>0?levels:levels.slice().reverse();
    const next=ascending.find(value=>direction>0?value>zoom:value<zoom);
    if(next)void setZoom(next);
  }
  $('zoomOut')?.addEventListener('click',()=>step(-1));
  $('zoomIn')?.addEventListener('click',()=>step(1));
  $('zoomLevel')?.addEventListener('click',()=>setZoom(100));
  $('zoomLevel')?.setAttribute('title','Click to restore 100% zoom');
  display();
  if(window.__TAURI__)void setZoom(zoom);
  const undo=$('undo');
  undo?.addEventListener('click',async()=>{
    const result=await api.command('undo');
    if(result?.undone===false)window.minternetToast?.('Nothing to undo.');
    else if(result?.message)window.minternetToast?.(result.message);
    else if(result?.ui?.kind==='groups'){
      if(!window.minternetGroups?.restoreUndoGroup?.(result.ui.before))
        window.minternetToast?.('Could not restore that group change.');
    }else if(result?.ui?.kind==='bookmarks'){
      if(!window.minternetBookmarks?.restoreUndoBookmark?.(result.ui.patch))
        window.minternetToast?.('Could not restore that bookmark change.');
    }
  });
  window.addEventListener('keydown',event=>{
    if(!(event.ctrlKey||event.metaKey)||event.altKey)return;
    if(event.key==='+'||event.key==='='||event.code==='NumpadAdd'){
      event.preventDefault();step(1);
    }else if(event.key==='-'||event.key==='_'||event.code==='NumpadSubtract'){
      event.preventDefault();step(-1);
    }else if(event.key==='0'){
      event.preventDefault();void setZoom(100);
    }
  },true);
  // WebView2 supplies the audio state; no page JavaScript injection.
  if(window.__TAURI__){
    const poll=()=>{if(!document.hidden)void api.command('audio-poll');};
    setInterval(poll,2500);
    poll();
  }
  window.minternetZoom={get:()=>zoom,set:setZoom};
})();
