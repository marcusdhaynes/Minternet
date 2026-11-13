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
  back.addEventListener('click',()=>void open('back'));
  forward.addEventListener('click',()=>void open('forward'));
  window.minternetNavigationHistory={close};
})();
