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
  // The authentic OpenAI knot path from Bootstrap Icons (MIT licensed),
  // rendered in white for ChatGPT and in purple for Temporary Chat.
  const chatgptIcon='<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="'+"M14.949 6.547a3.94 3.94 0 0 0-.348-3.273 4.11 4.11 0 0 0-4.4-1.934A4.1 4.1 0 0 0 8.423.2 4.15 4.15 0 0 0 6.305.086a4.1 4.1 0 0 0-1.891.948 4.04 4.04 0 0 0-1.158 1.753 4.1 4.1 0 0 0-1.563.679A4 4 0 0 0 .554 4.72a3.99 3.99 0 0 0 .502 4.731 3.94 3.94 0 0 0 .346 3.274 4.11 4.11 0 0 0 4.402 1.933c.382.425.852.764 1.377.995.526.231 1.095.35 1.67.346 1.78.002 3.358-1.132 3.901-2.804a4.1 4.1 0 0 0 1.563-.68 4 4 0 0 0 1.14-1.253 3.99 3.99 0 0 0-.506-4.716m-6.097 8.406a3.05 3.05 0 0 1-1.945-.694l.096-.054 3.23-1.838a.53.53 0 0 0 .265-.455v-4.49l1.366.778q.02.011.025.035v3.722c-.003 1.653-1.361 2.992-3.037 2.996m-6.53-2.75a2.95 2.95 0 0 1-.36-2.01l.095.057L5.29 12.09a.53.53 0 0 0 .527 0l3.949-2.246v1.555a.05.05 0 0 1-.022.041L6.473 13.3c-1.454.826-3.311.335-4.15-1.098m-.85-6.94A3.02 3.02 0 0 1 3.07 3.949v3.785a.51.51 0 0 0 .262.451l3.93 2.237-1.366.779a.05.05 0 0 1-.048 0L2.585 9.342a2.98 2.98 0 0 1-1.113-4.094zm11.216 2.571L8.747 5.576l1.362-.776a.05.05 0 0 1 .048 0l3.265 1.86a3 3 0 0 1 1.173 1.207 2.96 2.96 0 0 1-.27 3.2 3.05 3.05 0 0 1-1.36.997V8.279a.52.52 0 0 0-.276-.445m1.36-2.015-.097-.057-3.226-1.855a.53.53 0 0 0-.53 0L6.249 6.153V4.598a.04.04 0 0 1 .019-.04L9.533 2.7a3.07 3.07 0 0 1 3.257.139c.474.325.843.778 1.066 1.303.223.526.289 1.103.191 1.664zM5.503 8.575 4.139 7.8a.05.05 0 0 1-.026-.037V4.049c0-.57.166-1.127.476-1.607s.752-.864 1.275-1.105a3.08 3.08 0 0 1 3.234.41l-.096.054-3.23 1.838a.53.53 0 0 0-.265.455zm.742-1.577 1.758-1 1.762 1v2l-1.755 1-1.762-1z"+'"/></svg>';
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
    const address=document.getElementById('address');
    if(address)address.placeholder=current==='chatgpt-private'
      ?'Ask ChatGPT (Temporary) or enter a website'
      :chatgpt?'Ask ChatGPT or enter a website'
      :'Search Google or enter a website';
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
  window.addEventListener('blur',()=>{if(popup)close();});
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
