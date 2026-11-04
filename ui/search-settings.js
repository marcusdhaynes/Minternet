'use strict';
// The toolbar and settings share one allowlisted search-provider choice.
// All icons are packaged SVG markup: no remote icon requests or injected HTML.
(() => {
  const key='minternet.search-engine.v1';
  // Older provider codes remain accepted for existing automated smoke runs;
  // only Google and ChatGPT are presented in the user-facing selector.
  const supported=['google','chatgpt','chatgpt-private',
    'duckduckgo','bing','brave','startpage','ecosia'];
  const valid=value=>supported.includes(value)?value:'google';
  const visible=new Set(['google','chatgpt','chatgpt-private']);
  const googleIcon='<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'+
    '<path fill="#4285F4" d="M21.35 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.24a4.48 4.48 0 0 1-1.94 2.94v2.45h3.13c1.83-1.69 2.92-4.18 2.92-7.22Z"/>'+
    '<path fill="#34A853" d="M12 21.75c2.63 0 4.84-.87 6.45-2.3l-3.13-2.45c-.87.58-1.98.93-3.32.93-2.55 0-4.72-1.72-5.49-4.04H3.27v2.53A9.75 9.75 0 0 0 12 21.75Z"/>'+
    '<path fill="#FBBC05" d="M6.51 13.89a5.85 5.85 0 0 1 0-3.78V7.58H3.27a9.75 9.75 0 0 0 0 8.84l3.24-2.53Z"/>'+
    '<path fill="#EA4335" d="M12 6.07c1.43 0 2.72.49 3.74 1.47l2.79-2.79C16.84 3.17 14.62 2.25 12 2.25a9.75 9.75 0 0 0-8.73 5.33l3.24 2.53C7.28 7.79 9.45 6.07 12 6.07Z"/></svg>';
  // A compact sixfold, interlocked knot glyph used for both ChatGPT modes.
  // The private variant reuses the same geometry with the purple accent.
  const knotSegments=Array.from({length:6},(_,index)=>
    '<path transform="rotate('+(index*60)+' 12 12)" d="M12 3.6c-1.7-.95-4-.6-5.3.9-1.5 1.6-1.6 3.8-.5 5.6l2.6 4.4 3.2-1.8" />').join('');
  const chatgptIcon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linejoin="round" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'+knotSegments+
    '<path d="M12 8.5 15.1 10.2v3.6L12 15.5l-3.1-1.7v-3.6Z" stroke-width="1.2"/></svg>';
  const label=engine=>engine==='chatgpt-private'?'ChatGPT · Temporary':
    engine==='chatgpt'?'ChatGPT':'Google';
  let current='google';
  try {current=valid(localStorage.getItem(key));}catch{}
  if(!visible.has(current))current='google';
  const select=document.getElementById('defaultSearchEngine');
  const button=document.getElementById('connectionIcon');
  let popup=null,holdTimer=null,held=false;

  function display(){
    if(select)select.value=current;
    if(!button)return;
    const chatgpt=current==='chatgpt'||current==='chatgpt-private';
    button.innerHTML=chatgpt?chatgptIcon:googleIcon;
    button.classList.toggle('provider-chatgpt',chatgpt);
    button.classList.toggle('provider-temporary',current==='chatgpt-private');
    button.title=label(current)+(chatgpt?' · Hold to toggle Temporary Chat':'')+' · Click to change';
    button.setAttribute('aria-label','Search Engine: '+label(current));
    button.setAttribute('aria-expanded',String(Boolean(popup)));
  }
  function setEngine(engine){
    current=valid(engine);
    display();
    try{localStorage.setItem(key,current);}
    catch{window.minternetToast?.('Search preference could not be saved.');}
    return current;
  }
  function close(){
    if(!popup)return;
    popup.remove();popup=null;
    document.removeEventListener('pointerdown',outside,true);
    document.removeEventListener('keydown',onKey,true);
    if(window.__TAURI__)void window.minternet?.command('chrome-overlay',false);
    display();
  }
  function outside(event){
    if(popup&&!popup.contains(event.target)&&!button?.contains(event.target))close();
  }
  function onKey(event){
    if(event.key==='Escape'){event.preventDefault();close();button?.focus();}
  }
  function position(){
    if(!popup||!button)return;
    const anchor=button.getBoundingClientRect();
    const bounds=popup.getBoundingClientRect();
    popup.style.left=Math.max(3,Math.min(anchor.left,innerWidth-bounds.width-3))+'px';
    popup.style.top=Math.max(3,Math.min(anchor.bottom+4,innerHeight-bounds.height-3))+'px';
  }
  function togglePrivate(){
    if(current==='chatgpt')setEngine('chatgpt-private');
    else if(current==='chatgpt-private')setEngine('chatgpt');
    else return;
    close();
  }
  async function open(){
    if(!button)return;
    if(popup){close();return;}
    const host=document.createElement('div');
    host.className='system-popup-root minternet-context-menu search-provider-menu';
    host.setAttribute('role','menu');
    host.setAttribute('aria-label','Choose Search Engine');
    const title=document.createElement('div');
    title.className='minternet-context-heading';
    title.textContent='SEARCH ENGINE';
    host.append(title);
    const options=current==='google'?['chatgpt']:['google'];
    for(const engine of options){
      const row=document.createElement('button');
      row.type='button';row.className='search-provider-option';
      row.setAttribute('role','menuitem');
      row.innerHTML=(engine==='google'?googleIcon:chatgptIcon);
      const name=document.createElement('span');
      name.textContent=label(engine);
      row.append(name);
      row.addEventListener('click',()=>{setEngine(engine);close();});
      host.append(row);
    }
    if(current!=='google'){
      const hint=document.createElement('div');
      hint.className='search-provider-hint';
      hint.textContent='Hold the ChatGPT icon to toggle Temporary Chat';
      host.append(hint);
    }
    document.body.append(host);
    popup=host;
    display();
    if(window.__TAURI__)void window.minternet?.command('chrome-overlay',true);
    position();
    document.addEventListener('pointerdown',outside,true);
    document.addEventListener('keydown',onKey,true);
  }
  if(select){
    select.addEventListener('change',()=>setEngine(select.value));
  }
  if(button){
    button.addEventListener('pointerdown',event=>{
      if(event.button!==0||event.isPrimary===false)return;
      held=false;
      if(current==='chatgpt'||current==='chatgpt-private'){
        clearTimeout(holdTimer);
        holdTimer=setTimeout(()=>{
          held=true;togglePrivate();
        },650);
      }
    });
    const stopHold=()=>{clearTimeout(holdTimer);holdTimer=null;};
    button.addEventListener('pointerup',stopHold);
    button.addEventListener('pointercancel',stopHold);
    button.addEventListener('pointerleave',stopHold);
    button.addEventListener('click',event=>{
      if(held){held=false;event.preventDefault();return;}
      void open();
    });
    button.addEventListener('contextmenu',event=>{
      if(current==='chatgpt'||current==='chatgpt-private'){
        event.preventDefault();stopHold();held=true;togglePrivate();
      }
    });
    button.addEventListener('keydown',event=>{
      if(event.shiftKey&&event.key==='Enter'&&current!=='google'){
        event.preventDefault();held=true;togglePrivate();
      }
    });
    window.addEventListener('resize',position);
  }
  display();
  window.minternetSearch={
    getEngine:()=>current,
    setEngine,
    getProviderHome:()=>current==='chatgpt-private'
      ?'https://chatgpt.com/?temporary-chat=true'
      :current==='chatgpt'?'https://chatgpt.com/':'https://www.google.com/',
    togglePrivate
  };
})();
