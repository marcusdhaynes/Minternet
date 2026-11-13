'use strict';
// Native per-tab navigation history; only ten rows are mounted at a time.
// Scroll to reveal the next ten, never more than fifty per direction.
(() => {
  const api=window.minternet;
  const back=document.getElementById('back'),forward=document.getElementById('forward');
  if(!api||!back||!forward)return;
  let panel=null,entries=[],shown=0,direction='',request=0;
  function close(){
    request++;
    panel?.remove();panel=null;
    document.removeEventListener('pointerdown',outside,true);
    document.removeEventListener('keydown',escape,true);
    if(window.__TAURI__)void api.command('chrome-overlay',false).catch(()=>{});
  }
  function outside(event){
    if(panel&&!panel.contains(event.target)&&!back.contains(event.target)&&!forward.contains(event.target))close();
  }
  function escape(event){if(event.key==='Escape'){event.preventDefault();close();}}
  function titleFor(item){
    if(item.title&&item.title!==item.url)return item.title;
    try{return new URL(item.url).hostname;}catch{return item.url;}
  }
  function nextTen(){
    if(!panel)return;
    const list=panel.querySelector('.navigation-history-list');
    for(const item of entries.slice(shown,shown+10)){
      const option=document.createElement('button');
      option.type='button';option.className='navigation-history-entry';
      const label=document.createElement('strong');label.textContent=titleFor(item);
      const detail=document.createElement('small');detail.textContent=item.url;
      option.append(label,detail);
      option.title=item.url;
      option.addEventListener('click',()=>{
        close();void api.command('navigation-history-jump',item.index).catch(()=>{});
      });
      list.append(option);
    }
    shown=Math.min(entries.length,shown+10);
  }
  async function open(side){
    if(panel&&direction===side){close();return;}
    close();direction=side;
    const token=++request;
    const trigger=side==='back'?back:forward;
    let data;
    try{data=await api.command('navigation-history-list',side);}catch{return;}
    if(token!==request||!Array.isArray(data))return;
    entries=data.slice(0,50);shown=0;
    if(!entries.length)return;
    panel=document.createElement('section');panel.className='navigation-history-popup system-popup-root minternet-context-menu';
    panel.setAttribute('role','dialog');panel.setAttribute('aria-label',(side==='back'?'Back':'Forward')+' History');
    const title=document.createElement('strong');title.className='navigation-history-title';
    title.textContent=side==='back'?'Previous Pages':'Forward Pages';
    const list=document.createElement('div');list.className='navigation-history-list';
    list.addEventListener('scroll',()=>{
      if(list.scrollTop+list.clientHeight>=list.scrollHeight-48)nextTen();
    });
    panel.append(title,list);
    document.body.append(panel);
    const rect=trigger.getBoundingClientRect();
    panel.style.left=Math.max(4,Math.min(rect.left,innerWidth-304))+'px';
    panel.style.top=(rect.bottom+4)+'px';
    nextTen();
    document.addEventListener('pointerdown',outside,true);
    document.addEventListener('keydown',escape,true);
    if(window.__TAURI__)void api.command('chrome-overlay',true).catch(()=>{});
  }
  // Short click behaves like a conventional browser navigation button.
  // Holding a button opens its scrollable history instead.
  const DELAY_KEY='minternet.navigationHoldSeconds.v1';
  const setting=document.getElementById('navigationHistoryHoldDelay');
  let holdSeconds=0.25;
  try{
    const saved=Number(localStorage.getItem(DELAY_KEY));
    if(Number.isFinite(saved)&&saved>=0.1&&saved<=2)holdSeconds=saved;
  }catch{}
  if(setting){
    setting.value=String(holdSeconds);
    const save=()=>{
      const value=Number(setting.value);
      if(!Number.isFinite(value)||value<0.1||value>2)return;
      holdSeconds=Math.round(value*100)/100;
      try{localStorage.setItem(DELAY_KEY,String(holdSeconds));}catch{}
    };
    setting.addEventListener('change',save);
  }
  function bindNavigation(button,side){
    let timer=null,held=false,suppressNextClick=false,startX=0,startY=0;
    const cancel=()=>{if(timer!==null)clearTimeout(timer);timer=null;};
    button.addEventListener('pointerdown',event=>{
      if(event.button!==0 || button.disabled)return;
      cancel();held=false;suppressNextClick=false;
      startX=event.clientX;startY=event.clientY;
      timer=setTimeout(()=>{
        timer=null;
        if(button.disabled)return;
        held=true;
        suppressNextClick=true;
        void open(side);
      },Math.round(holdSeconds*1000));
    });
    button.addEventListener('pointermove',event=>{
      if(timer!==null&&(Math.abs(event.clientX-startX)>10||
                          Math.abs(event.clientY-startY)>10))cancel();
    });
    button.addEventListener('pointerup',cancel);
    button.addEventListener('pointercancel',()=>{cancel();held=false;suppressNextClick=false;});
    button.addEventListener('pointerleave',cancel);
    button.addEventListener('click',event=>{
      if(held||suppressNextClick){
        held=false;suppressNextClick=false;
        event.preventDefault();return;
      }
      cancel();
      close();
      void api.command(side).catch(()=>{});
    });
    // Native browser convention: right-click shows the same history list.
    button.addEventListener('contextmenu',event=>{
      event.preventDefault();
      cancel();held=false;suppressNextClick=true;
      if(!button.disabled)void open(side);
    });
  }
  bindNavigation(back,'back');
  bindNavigation(forward,'forward');
  window.minternetNavigationHistory={close};
})();
