'use strict';
// Trusted browser chrome only. Remote website WebViews have no access to this
// panel, the native downloads state or file-system reveal commands.
(() => {
  const api=window.minternet;
  const button=document.getElementById('downloadsButton');
  const badge=document.getElementById('downloadsBadge');
  if(!api||!button||!badge)return;
  let entries=[],panel=null;
  const command=(name,value)=>api.command(name,value);
  function close(){
    if(!panel)return;
    panel.remove();panel=null;
    button.setAttribute('aria-expanded','false');
    document.removeEventListener('pointerdown',outside,true);
    document.removeEventListener('keydown',key,true);
    if(window.__TAURI__)void command('chrome-overlay',false);
  }
  function outside(event){
    if(panel&&!panel.contains(event.target)&&!button.contains(event.target))close();
  }
  function key(event){if(event.key==='Escape'){event.preventDefault();close();button.focus();}}
  function updateBadge(){
    const active=entries.filter(entry=>entry.status==='downloading').length;
    const count=active||entries.filter(entry=>entry.status==='completed').length;
    badge.hidden=!count;
    badge.textContent=count>9?'9+':String(count);
    badge.classList.toggle('in-progress',active>0);
    button.title=active?active+' downloads in progress':'Recent Downloads';
  }
  function render(){
    updateBadge();
    if(!panel)return;
    const list=panel.querySelector('.downloads-entries');
    list.replaceChildren();
    if(!entries.length){
      const empty=document.createElement('p');
      empty.className='downloads-empty';
      empty.textContent='No recent downloads';
      list.append(empty);
    }
    for(const entry of entries.slice(0,25)){
      const completed=entry.status==='completed';
      const row=document.createElement('div');
      row.className='downloads-entry'+(completed?' downloads-draggable':'');
      row.dataset.downloadId=String(entry.id);
      const symbol=document.createElement('span');symbol.className='downloads-entry-symbol';
      symbol.textContent=completed?'✓':entry.status==='invalid'?'!':entry.status==='failed'?'!':'↓';
      const details=document.createElement('div');details.className='downloads-entry-details';
      const name=document.createElement('strong');name.textContent=entry.name;
      name.title=entry.name;
      const status=document.createElement('span');
      status.textContent=completed?'Ready · Drag out to desktop or a folder':
        entry.status==='invalid'?'Invalid executable: server returned non-EXE data':
        entry.status==='failed'?'Download failed':entry.status==='interrupted'?'Interrupted':'Downloading…';
      details.append(name,status);
      const actions=document.createElement('div');actions.className='downloads-actions';
      const openFile=document.createElement('button');openFile.type='button';
      openFile.className='downloads-open';
      openFile.textContent=/\\.(exe|msi)$/i.test(entry.name)?'Run':'Open';
      openFile.title='Open '+entry.name+' using the operating system';
      openFile.setAttribute('aria-label',openFile.title);
      openFile.disabled=!completed;
      openFile.addEventListener('click',async()=>{
        const result=await command('downloads-open',entry.id);
        if(result?.message)window.minternetToast?.(result.message);
      });
      const reveal=document.createElement('button');reveal.type='button';
      reveal.className='downloads-reveal';
      reveal.textContent='⌕';
      reveal.title='Show in folder';
      reveal.setAttribute('aria-label','Show '+entry.name+' in folder');
      reveal.disabled=!completed;
      reveal.addEventListener('click',async()=>{
        const result=await command('downloads-reveal',entry.id);
        if(result?.message)window.minternetToast?.(result.message);
      });
      actions.append(openFile,reveal);
      if(completed){
        row.title='Drag this file directly into Explorer, Finder, or your desktop';
        // A native drag is necessary: HTML5 can only drag URLs, not real
        // filesystem files, into Windows Explorer. Wait for a short genuine
        // pointer movement so simple clicks still open the correct controls.
        let start=null;
        row.addEventListener('pointerdown',event=>{
          if(event.button!==0||event.target.closest('button'))return;
          start={id:event.pointerId,x:event.clientX,y:event.clientY};
        });
        row.addEventListener('pointermove',event=>{
          if(!start||event.pointerId!==start.id||!(event.buttons&1))return;
          if(Math.hypot(event.clientX-start.x,event.clientY-start.y)<6)return;
          start=null;
          if(window.__TAURI__)void command('downloads-drag',entry.id).then(result=>{
            if(result?.message)window.minternetToast?.(result.message);
          });
        });
        for(const type of ['pointerup','pointercancel','lostpointercapture'])
          row.addEventListener(type,()=>{start=null;});
        name.addEventListener('click',()=>{void command('downloads-open',entry.id);});
      }
      row.append(symbol,details,actions);list.append(row);
    }
    const clear=panel.querySelector('.downloads-clear');
    clear.disabled=!entries.length;
  }
  async function refresh(){
    const data=await command('downloads-list');
    if(Array.isArray(data)){entries=data;render();}
  }
  function position(){
    if(!panel)return;
    const rect=button.getBoundingClientRect();
    const box=panel.getBoundingClientRect();
    panel.style.left=Math.max(4,Math.min(innerWidth-box.width-4,rect.right-box.width))+'px';
    panel.style.top=Math.min(innerHeight-box.height-4,rect.bottom+5)+'px';
  }
  async function open(){
    if(panel){close();return;}
    if(window.__TAURI__)await command('chrome-overlay',true);
    const host=document.createElement('section');
    host.className='system-popup-root minternet-context-menu downloads-popup';
    host.id='downloadsPopup';
    host.setAttribute('role','dialog');
    host.setAttribute('aria-label','Recent Downloads');
    const header=document.createElement('div');header.className='downloads-popup-header';
    const title=document.createElement('strong');title.textContent='Recent Downloads';
    const clear=document.createElement('button');clear.type='button';clear.className='downloads-clear';
    clear.textContent='Clear';clear.title='Clear download history (does not delete files)';
    clear.addEventListener('click',async()=>{
      const result=await command('downloads-clear');
      if(result?.ok){entries=[];render();}
    });
    header.append(title,clear);
    const list=document.createElement('div');list.className='downloads-entries';
    const footer=document.createElement('div');footer.className='downloads-footer';
    footer.textContent='Files are saved in your Downloads folder';
    host.append(header,list,footer);
    document.body.append(host);
    panel=host;button.setAttribute('aria-expanded','true');
    position();render();
    document.addEventListener('pointerdown',outside,true);
    document.addEventListener('keydown',key,true);
    await refresh();
    position();
  }
  button.addEventListener('click',()=>{void open();});
  if(window.__TAURI__?.event?.listen){
    window.__TAURI__.event.listen('minternet:downloads',event=>{
      if(Array.isArray(event.payload)){entries=event.payload;render();}
    }).catch(()=>{});
  }
  void refresh();
  window.addEventListener('resize',position);
})();
