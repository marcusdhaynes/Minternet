'use strict';
// Trusted browser chrome only. Remote website WebViews have no access to this
// panel, the native downloads state or file-system reveal commands.
(() => {
  const api=window.minternet;
  const button=document.getElementById('downloadsButton');
  const badge=document.getElementById('downloadsBadge');
  if(!api||!button||!badge)return;
  let entries=[],panel=null,refreshing=false,activeProgress=false,dragPending=false;
  let acknowledging=false,ackPending=false;
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
    // Only downloads that appeared after the last panel review count.
    // Opening the panel acknowledges current transfers, but a future
    // download becomes a new notification again.
    const count=panel?0:entries.filter(entry=>
      (entry.status==='downloading'||entry.status==='completed')&&
      entry.unread===true).length;
    badge.hidden=!count;
    badge.textContent=count>9?'9+':String(count);
    badge.classList.toggle('in-progress',active>0);
    button.title=active?active+' downloads in progress':'Recent Downloads';
  }
  function formatBytes(n){
    if(!Number.isFinite(n)||n<1)return '0 B';
    const units=['B','KB','MB','GB'];let i=0;
    while(n>=1024&&i<units.length-1){n/=1024;i++;}
    return (i?n.toFixed(n>=10?1:2):Math.round(n))+' '+units[i];
  }
  function render(){
    updateBadge();
    // Preserve the originating row while the OS drag is being started.
    // Download progress polling must not replace it under the pointer.
    if(dragPending)return;
    activeProgress=entries.some(entry=>entry.status==='downloading');
    button.classList.toggle('downloads-running',activeProgress);
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
      symbol.textContent=completed?'✓':
        ['blocked','invalid','failed','interrupted'].includes(entry.status)?'!':'↓';
      const details=document.createElement('div');details.className='downloads-entry-details';
      const name=document.createElement('strong');name.textContent=entry.name;
      name.title=entry.name;
      const status=document.createElement('span');
      status.textContent=completed?'Ready · Drag out to desktop or a folder':
        entry.status==='blocked'?'Blocked: unsafe or mislabeled executable':
        entry.status==='invalid'?'Invalid executable: server returned non-EXE data':
        entry.status==='failed'?'Download failed':
        entry.status==='interrupted'?'Interrupted':'Downloading…';
      details.append(name,status);
      if(entry.status==='downloading'){
        const bar=document.createElement('div');bar.className='downloads-progress';
        bar.setAttribute('role','progressbar');
        bar.setAttribute('aria-label','Downloading '+entry.name);
        bar.setAttribute('aria-valuetext','Downloading'+(entry.receivedBytes?' · '+formatBytes(entry.receivedBytes)+' received':''));
        const fill=document.createElement('div');fill.className='downloads-progress-fill';
        bar.append(fill);details.append(bar);
        if(entry.receivedBytes){
          status.textContent='Downloading · '+formatBytes(entry.receivedBytes)+' received';
        }
      }
      const actions=document.createElement('div');actions.className='downloads-actions';
      const openFile=document.createElement('button');openFile.type='button';
      openFile.className='downloads-open';
      openFile.innerHTML=/\.(exe|msi)$/i.test(entry.name)
        ?'<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 10 7-10 7V5Z"/></svg>'
        :'<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M14 4h6v6M20 4 10 14M20 13v7H4V4h7"/></svg>';
      openFile.title=(/\.(exe|msi)$/i.test(entry.name)?'Run ':'Open ')+entry.name+' using the operating system';
      openFile.setAttribute('aria-label',openFile.title);
      openFile.disabled=!completed;
      openFile.addEventListener('click',async()=>{
        const result=await command('downloads-open',entry.id);
        if(result?.message)window.minternetToast?.(result.message);
      });
      const reveal=document.createElement('button');reveal.type='button';
      reveal.className='downloads-reveal';
      reveal.innerHTML='<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5"/><path d="m14.6 14.6 5.1 5.1"/></svg>';
      reveal.title='Show File Selected in Explorer';
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
        row.draggable=false;
        row.addEventListener('dragstart',event=>event.preventDefault());
        row.addEventListener('pointerdown',event=>{
          if(event.button!==0||event.target.closest('button'))return;
          start={id:event.pointerId,x:event.clientX,y:event.clientY,downloadId:entry.id};
          dragPending=true;
        });
        row.addEventListener('pointermove',event=>{
          if(!start||event.pointerId!==start.id||!(event.buttons&1))return;
          if(Math.hypot(event.clientX-start.x,event.clientY-start.y)<6)return;
          start=null;
          if(window.__TAURI__)void command('downloads-drag',entry.id).then(result=>{
            if(result?.message)window.minternetToast?.(result.message);
          }).catch(error=>window.minternetToast?.(String(error))).finally(()=>{
            dragPending=false;render();
          });
          else {dragPending=false;render();}
        });
        for(const type of ['pointerup','pointercancel','lostpointercapture'])
          row.addEventListener(type,()=>{start=null;if(dragPending){dragPending=false;render();}});
        name.addEventListener('click',()=>{void command('downloads-open',entry.id);});
      }
      row.append(symbol,details,actions);list.append(row);
    }
    const clear=panel.querySelector('.downloads-clear');
    clear.disabled=!entries.length;
  }
  async function acknowledgeDownloads(){
    for(const entry of entries)entry.unread=false;
    updateBadge();
    if(acknowledging){ackPending=true;return;}
    acknowledging=true;
    try{
      // A native mutation writes the acknowledgement to durable download
      // history. Rerun after concurrent downloads to avoid lost clears.
      do{
        ackPending=false;
        await command('downloads-acknowledge');
      }while(ackPending);
    }catch(error){window.minternetToast?.('Could not clear download counter: '+String(error));}
    finally{acknowledging=false;}
  }
  async function refresh(){
    if(refreshing)return;
    refreshing=true;
    try{
      const data=await command('downloads-list');
      if(Array.isArray(data)){entries=data;render();}
    }finally{refreshing=false;}
  }
  // Native DownloadEvent emits started/finished; while active, query bytes
  // from the destination file without ever exposing its path to the UI.
  setInterval(()=>{if(activeProgress)void refresh().catch(()=>{});},450);
  function position(){
    if(!panel)return;
    const rect=button.getBoundingClientRect();
    const box=panel.getBoundingClientRect();
    panel.style.left=Math.max(4,Math.min(innerWidth-box.width-4,rect.right-box.width))+'px';
    panel.style.top=Math.min(innerHeight-box.height-4,rect.bottom+5)+'px';
  }
  async function open(){
    if(panel){close();return;}
    // Clear existing notifications *persistently* on every open,
    // including those restored from an earlier browsing session.
    await acknowledgeDownloads();
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
      if(result?.ok){await refresh();render();}
    });
    header.append(title,clear);
    const list=document.createElement('div');list.className='downloads-entries';
    const footer=document.createElement('div');footer.className='downloads-footer';
    const footerLabel=document.createElement('span');
    footerLabel.textContent='Files remain in your selected Downloads folder';
    const openFolder=document.createElement('button');
    openFolder.type='button';openFolder.className='downloads-open-folder';
    openFolder.textContent='Open Folder';
    openFolder.addEventListener('click',async()=>{
      try{
        const result=await command('downloads-folder-open');
        if(result?.message)window.minternetToast?.(result.message);
      }catch(error){window.minternetToast?.(String(error));}
    });
    footer.append(footerLabel,openFolder);
    host.append(header,list,footer);
    document.body.append(host);
    panel=host;button.setAttribute('aria-expanded','true');
    position();render();
    document.addEventListener('pointerdown',outside,true);
    document.addEventListener('keydown',key,true);
    await refresh();
    await acknowledgeDownloads();
    position();
  }
  button.addEventListener('click',()=>{void open();});
  window.addEventListener('blur',()=>{if(panel)close();});
  if(window.__TAURI__?.event?.listen){
    window.__TAURI__.event.listen('minternet:download-blocked',event=>{
      // Make silent native failures visible without showing approval dialogs.
      const reason=event?.payload?.reason;
      window.minternetToast?.(typeof reason==='string'&&reason.length<350
        ?reason:'This download could not be started.');
    }).catch(()=>{});
    window.__TAURI__.event.listen('minternet:downloads',event=>{
      if(Array.isArray(event.payload)){
        entries=event.payload;
        render();
        if(panel&&entries.some(entry=>entry.unread))void acknowledgeDownloads();
        if(activeProgress)void refresh().catch(()=>{});
      }
    }).catch(()=>{});
  }
  void refresh();
  window.addEventListener('resize',position);
})();
