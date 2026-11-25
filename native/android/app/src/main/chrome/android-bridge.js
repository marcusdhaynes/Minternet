'use strict';
// Android is a native host, not a preview iframe. Only the trusted bundled
// main frame has an origin-restricted message channel.
(() => {
  const native=window.MinternetAndroid;
  if(!native)return;
  let serial=0,state=null,layoutKey='',frame=0;
  const pending=new Map(),listeners=new Set();
  native.onmessage=event=>{
    try{
      const {id,result}=JSON.parse(event.data);
      const callback=pending.get(id);
      if(callback){pending.delete(id);callback(result);}
    }catch{}
  };
  function command(name,value){
    return new Promise(resolve=>{
      const id=++serial;
      const timer=setTimeout(()=>{pending.delete(id);resolve({message:'Android command timed out: '+name});},6000);
      pending.set(id,result=>{clearTimeout(timer);resolve(result);});
      try{native.postMessage(JSON.stringify({id,name,value:value??null}));}
      catch{clearTimeout(timer);pending.delete(id);resolve({message:'Android bridge unavailable'});}
    });
  }
  window.minternet={
    command,
    onState(cb){listeners.add(cb);if(state)queueMicrotask(()=>cb(state));return()=>listeners.delete(cb);},
    onFocusAddress(){return()=>{};}
  };
  window.__minternetMobileState=next=>{
    if(!next||!Array.isArray(next.tabs))return;
    state=next;
    const active=next.tabs.find(t=>t.id===next.activeId);
    document.documentElement.classList.toggle('android-live-site',Boolean(active&&active.url!=='about:blank'));
    for(const cb of listeners){try{cb(next);}catch(error){console.error(error);}}
    scheduleLayout();
  };
  const visible=el=>!el.hidden&&el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none';
  const overlaySelector='.system-popup-root,.bookmark-overlay,.vault-screen,.secret-screen,.secret-pending-screen,.group-editor-screen,.tor-action-menu,[role="dialog"],.search-provider-menu,.media-devices-popup,.downloads-popup,.address-suggestions,.payment-popup';
  function scheduleLayout(){
    if(frame)return;
    frame=requestAnimationFrame(()=>{
      frame=0;
      const header=document.querySelector('.chrome');
      if(!header)return;
      const overlay=[...document.querySelectorAll(overlaySelector)].some(visible);
      const height=Math.ceil(header.getBoundingClientRect().bottom);
      const key=height+':'+overlay;
      if(key!==layoutKey){layoutKey=key;void command('mobile-layout',{header:height,overlay});}
    });
  }
  window.__minternetMobileCloseMenu=()=>{
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    const close=document.querySelector('#bookmarkOverlay:not([hidden]) .bookmark-panel:not([hidden]) .bookmark-close');
    if(close)close.click();
    scheduleLayout();
  };
  document.addEventListener('DOMContentLoaded',async()=>{
    document.documentElement.classList.add('android-shared-chrome');
    const privacy=document.getElementById('newPrivate');
    if(privacy)privacy.setAttribute('aria-label','Open isolated private window');
    const google=document.getElementById('googleAccountLogin');
    google?.addEventListener('click',event=>{event.preventDefault();event.stopImmediatePropagation();void command('mobile-google');},true);
    document.getElementById('googleSyncDisconnect')?.addEventListener('click',event=>{event.preventDefault();event.stopImmediatePropagation();void command('mobile-sync-stop');},true);
    const prefs=await command('browser-preferences');
    const idle=document.getElementById('autoUnloadMinutes');
    if(idle){
      if(Number.isInteger(prefs.autoUnloadMinutes))idle.value=String(prefs.autoUnloadMinutes);
      idle.addEventListener('change',()=>void command('mobile-auto-unload-set',Number(idle.value)));
    }
    new MutationObserver(scheduleLayout).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','class','style','aria-expanded']});
    new ResizeObserver(scheduleLayout).observe(document.querySelector('.chrome'));
    document.addEventListener('pointerup',scheduleLayout,true);
    window.addEventListener('resize',scheduleLayout);
    // Mobile touch-and-hold invokes the same browser-owned menu as right-click.
    let hold=0,initial=null;
    const cancel=()=>{clearTimeout(hold);hold=0;initial=null;};
    document.addEventListener('pointerdown',event=>{
      cancel();
      if(event.pointerType!=='touch'||event.target.closest('input,textarea,select,[contenteditable]'))return;
      const target=event.target;initial={x:event.clientX,y:event.clientY};
      hold=setTimeout(()=>{
        const e=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:initial.x,clientY:initial.y,button:2});
        target.dispatchEvent(e);scheduleLayout();hold=0;initial=null;
      },550);
    },true);
    document.addEventListener('pointermove',event=>{if(initial&&Math.hypot(event.clientX-initial.x,event.clientY-initial.y)>8)cancel();},true);
    for(const type of ['pointerup','pointercancel'])document.addEventListener(type,cancel,true);
    const ready=await command('mobile-ready');
    if(Array.isArray(ready.tabs)){
      window.__minternetMobileState(ready);
      if(ready.tabs.some(t=>t.private))privacy?.setAttribute('aria-label','Close isolated private window');
    }
    scheduleLayout();
  });
})();
