'use strict';
// The trusted Minternet chrome owns bookmarks. Website webviews cannot read this storage.
(() => {
  const model = window.MinternetBookmarks;
  const api = window.minternet;
  if (!model || !api) return;
  const $ = id => document.getElementById(id);
  const STORE = 'minternet.bookmark-tree.v1';
  const ICON_STORE = 'minternet.bookmark-icon-thumbnails.v1';
  // Persist compact, site-specific 24px thumbnails. They are read before the
  // first paint, so known bookmarks never wait for network favicon requests.
  const thumbs=new Map(),thumbnailJobs=new Set();
  try{
    const cached=JSON.parse(localStorage.getItem(ICON_STORE)||'{}');
    for(const [address,png] of Object.entries(cached||{}).slice(-220))
      if(model.url(address)&&typeof png==='string'&&png.length<=10000&&
         /^data:image\/png;base64,[a-z0-9+/=]+$/i.test(png))thumbs.set(address,png);
  }catch{}
  function rememberThumb(address,png){
    if(!model.url(address)||typeof png!=='string'||png.length>10000||
       !/^data:image\/png;base64,[a-z0-9+/=]+$/i.test(png))return;
    thumbs.delete(address);thumbs.set(address,png);
    while(thumbs.size>170)thumbs.delete(thumbs.keys().next().value);
    try{localStorage.setItem(ICON_STORE,JSON.stringify(Object.fromEntries(thumbs)));}catch{}
  }
  async function cacheIconThumbnail(address,source){
    if(!window.__TAURI__||thumbs.has(address)||thumbnailJobs.has(address))return;
    thumbnailJobs.add(address);
    try{
      const data=await api.command('bookmark-icon-data',source);
      if(typeof data!=='string'||!/^data:image\/(?:png|jpeg|webp|x-icon);base64,[a-z0-9+/=]+$/i.test(data))return;
      const image=new Image();image.src=data;await image.decode();
      const canvas=document.createElement('canvas');
      canvas.width=24;canvas.height=24;
      const ctx=canvas.getContext('2d');
      if(!ctx||!image.naturalWidth||!image.naturalHeight)return;
      const scale=Math.min(24/image.naturalWidth,24/image.naturalHeight);
      ctx.clearRect(0,0,24,24);
      ctx.drawImage(image,(24-image.naturalWidth*scale)/2,
        (24-image.naturalHeight*scale)/2,image.naturalWidth*scale,image.naturalHeight*scale);
      rememberThumb(address,canvas.toDataURL('image/png'));
    }catch{}finally{thumbnailJobs.delete(address);}
  }
  let data;
  try { data = model.hydrate(localStorage.getItem(STORE)); }
  catch { data = model.blank(); }
  let currentUrl = '', currentTitle = '', mode = null, folderId = null, draft = null, customIcon = '';
  let lastUndoJson=JSON.stringify(data);
  // Store only changed string spans, not a complete bookmark tree on every
  // edit. Renaming one item costs roughly that item's old name in history.
  function makeUndoPatch(before,after){
    let start=0;
    while(start<before.length&&start<after.length&&before[start]===after[start])start++;
    let suffix=0;
    while(suffix<before.length-start&&suffix<after.length-start&&
      before[before.length-1-suffix]===after[after.length-1-suffix])suffix++;
    return {start,remove:after.length-start-suffix,
      insert:before.slice(start,before.length-suffix)};
  }
  function restoreUndoBookmark(patch){
    try{
      if(!patch||!Number.isSafeInteger(patch.start)||!Number.isSafeInteger(patch.remove)||
         patch.start<0||patch.remove<0||typeof patch.insert!=='string')return false;
      const now=JSON.stringify(data);
      if(patch.start+patch.remove>now.length||patch.insert.length>950000)return false;
      const before=now.slice(0,patch.start)+patch.insert+now.slice(patch.start+patch.remove);
      const raw=JSON.parse(before);
      if(!raw || !Array.isArray(raw.items))return false;
      const parsed=model.hydrate(raw);
      data=parsed;
      applyVisibility();
      persist(true);
      return true;
    }catch{return false;}
  }
  const toast = message => {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('visible');
    clearTimeout(toast.hideTimer);
    toast.hideTimer = setTimeout(() => el.classList.remove('visible'), 2700);
  };
  function persist(skipUndo=false) {
    const json=JSON.stringify(data);
    if(!skipUndo && json!==lastUndoJson && window.__TAURI__){
      const patch=makeUndoPatch(lastUndoJson,json);
      if(patch.insert.length<240000){
        void api.command('undo-ui-checkpoint',{kind:'bookmarks',patch});
      }
    }
    lastUndoJson=json;
    try {
      if (json.length > 950000) throw new Error('Bookmark storage is full');
      localStorage.setItem(STORE, json);
    } catch {
      toast('Bookmarks could not be saved. Free space or reduce icon sizes.');
    }
    renderBar();
    renderStar();
    if(!skipUndo)window.dispatchEvent(new CustomEvent('minternet:local-change',{detail:{kind:'bookmark'}}));
    if (mode === 'manager') renderManager();
    if (mode === 'folder') renderFolder();
  }
  // A website may declare /Project/favicon.svg or an image with a cache-
  // busting query. Read its <link rel="icon"> declarations through the native
  // browser, rather than assuming every site has /favicon.ico at its root.
  // Cache requests for identical bookmarks; never touch manually chosen icons.
  const faviconCandidates=new Map();
  const faviconGood=new Map();
  const faviconBad=new Set();
  const iconJobs=[];
  let iconsRunning=0;
  function runIconJobs(){
    while(iconsRunning<3 && iconJobs.length){
      const task=iconJobs.shift();
      iconsRunning++;
      Promise.resolve().then(task.run).then(task.resolve,()=>task.resolve([]))
        .finally(()=>{iconsRunning--;runIconJobs();});
    }
  }
  // Google migrated Gmail and Calendar branding in May 2026. Some logged-in
  // Google apps expose a generic google.com favicon or their login page instead
  // of the app icon. Use the official current product-logo assets for only
  // these exact hosts, without replacing a user's explicit custom icon.
  function currentGoogleIcons(address){
    let host='';
    try{host=new URL(address).hostname.toLowerCase();}catch{return [];}
    if(['mail.google.com','gmail.google.com','gmail.com'].includes(host)){
      return [
        'https://ssl.gstatic.com/images/branding/productlogos/gmail_2026/v2/ico/gmail_2026_256dp.ico',
        'https://ssl.gstatic.com/ui/v1/icons/mail/rfr/gmail.ico',
        'https://ssl.gstatic.com/ui/v1/icons/mail/images/favicon5.ico'
      ];
    }
    if(['calendar.google.com','www.google.com'].includes(host)){
      // Do not hijack normal Google Search bookmarks that happen to share
      // the www.google.com origin.
      const isCalendar=host==='calendar.google.com'||new URL(address).pathname.startsWith('/calendar');
      if(isCalendar)return [
        'https://ssl.gstatic.com/images/branding/productlogos/calendar_2026/v2/ico/calendar_2026_256dp.ico',
        'https://calendar.google.com/googlecalendar/images/favicons_2020q4/calendar_31_256.ico',
        'https://calendar.google.com/googlecalendar/images/favicons_2020q4/calendar_31.ico'
      ];
    }
    return [];
  }
  function fallbackIcons(address){
    const safe=model.url(address);
    if(!safe)return [];
    // Try the site's HTTPS icon even for a legacy HTTP bookmark; never
    // display insecure icon resources inside the trusted browser chrome.
    const secure=safe.replace(/^http:/i,'https:');
    const root=model.favicon(secure);
    try{
      const page=new URL(secure);
      return [
        new URL('./favicon.svg',page).href,
        new URL('./favicon.png',page).href,
        new URL('./favicon.ico',page).href,
        new URL('./apple-touch-icon.png',page).href,
        root
      ].filter((candidate,index,all)=>candidate&&all.indexOf(candidate)===index);
    }catch{return root?[root]:[];}
  }
  function iconSources(address){
    const safe=model.url(address);
    if(!safe)return Promise.resolve([]);
    if(faviconGood.has(safe))return Promise.resolve([faviconGood.get(safe)]);
    if(faviconCandidates.has(safe))return faviconCandidates.get(safe);
    // Do not fetch YouTube/Google page HTML just to discover a favicon.
    // Those unauthenticated page probes can produce extra requests and make
    // site-side unusual-traffic checks more likely on shared IP networks.
    const host=new URL(safe).hostname.toLowerCase();
    if(host==='youtube.com'||host==='www.youtube.com'||host==='m.youtube.com'||host==='youtu.be'){
      return Promise.resolve(['https://www.youtube.com/favicon.ico']);
    }
    const branded=currentGoogleIcons(safe);
    if(branded.length){
      // Avoid slow logged-in HTML scanning and preserve true product icons.
      const promise=Promise.resolve(branded);
      faviconCandidates.set(safe,promise);
      return promise;
    }
    const promise=new Promise(resolve=>{
      iconJobs.push({resolve,run:async()=>{
        let declared=[];
        if(window.__TAURI__){
          const results=await api.command('bookmark-site-icons',safe);
          if(Array.isArray(results))declared=results.filter(src=>{
            try{
              const icon=new URL(src);
              return icon.protocol==='https:'&&!icon.username&&!icon.password;
            }catch{return false;}
          }).slice(0,16);
        }
        return [...new Set([...declared,...fallbackIcons(safe)])];
      }});
      runIconJobs();
    });
    faviconCandidates.set(safe,promise);
    return promise;
  }
  function tryIcon(slot,address,candidates,index=0){
    // Keep the site-specific host-letter icon when no usable favicon exists.
    if(index>=candidates.length)return;
    const candidate=candidates[index];
    if(faviconBad.has(candidate)){tryIcon(slot,address,candidates,index+1);return;}
    const img=document.createElement('img');
    img.alt='';
    img.decoding='async';
    img.referrerPolicy='no-referrer';
    img.addEventListener('load',()=>{
      faviconGood.set(address,candidate);
      slot.replaceChildren(img);
      slot.classList.remove('bookmark-site-fallback');
      slot.style.removeProperty('--bookmark-icon-hue');
      void cacheIconThumbnail(address,candidate);
    },{once:true});
    img.addEventListener('error',()=>{
      faviconBad.add(candidate);
      tryIcon(slot,address,candidates,index+1);
    },{once:true});
    img.src=candidate;
  }
  function iconNode(item,isFolder=item?.kind==='folder'){
    const slot=document.createElement('span');
    slot.className='bookmark-emoji';
    const value=model.icon(item?.icon);
    if(/^data:image\/(?:png|jpeg|webp);base64,/i.test(value)){
      const img=document.createElement('img');
      img.src=value;img.alt='';
      slot.append(img);
    }else if(/^https:\/\//i.test(value)){
      const img=document.createElement('img');
      img.alt='';img.referrerPolicy='no-referrer';img.decoding='async';
      img.addEventListener('error',()=>{slot.textContent=isFolder?'📁':'🔖';},{once:true});
      img.src=value;slot.append(img);
    }else if(value){
      slot.textContent=value;
    }else if(!isFolder && model.url(item?.url)){
      const safe=model.url(item.url);
      const thumbnail=thumbs.get(safe);
      if(thumbnail){
        const img=document.createElement('img');img.alt='';img.src=thumbnail;
        slot.append(img);return slot;
      }
      const hostname=new URL(safe).hostname.replace(/^www\./,'');
      // A missing favicon is represented by this site's own initial and
      // stable host color, never by a generic bookmark icon.
      slot.classList.add('bookmark-site-fallback');
      slot.textContent=(hostname[0]||'◆').toUpperCase();
      let hue=0;for(const letter of hostname)hue=(hue*31+letter.charCodeAt(0))>>>0;
      slot.style.setProperty('--bookmark-icon-hue',String(hue%360));
      void iconSources(safe).then(candidates=>tryIcon(slot,safe,candidates));
    }else{
      slot.textContent=isFolder?'📁':'🔖';
    }
    return slot;
  }
  function textFor(node) {
    return node.name || (node.kind === 'folder' ? 'Unnamed Folder' : model.url(node.url)?.replace(/^https:\/\//, '') || 'Bookmark');
  }
  function act(name, arg) { return api.command(name, arg); }
  function applyVisibility() {
    $('bookmarkBar').hidden = !data.visible;
    $('bookmarkBarToggle').checked = data.visible;
    document.documentElement.classList.toggle('has-bookmarks', data.visible);
    if (window.__TAURI__) void act('bookmark-bar-visibility', data.visible);
  }
  function changeVisibility(visible) {
    data.visible = Boolean(visible);
    applyVisibility();
    persist();
  }
  function renderBar() {
    const holder = $('bookmarkItems');
    holder.replaceChildren();
    for (const item of model.barItems(data)) {
      const el = document.createElement('button');
      el.className = 'bookmark-item';
      el.type = 'button';
      el.append(iconNode(item));
      if (item.name) {
        const name = document.createElement('span');
        name.className = 'bookmark-caption';
        name.textContent = item.name;
        el.append(name);
      }
      el.dataset.bookmarkId = item.id;
      el.dataset.bookmarkKind = item.kind;
      if(item.kind==='link')el.draggable=true;
      el.addEventListener('dragstart',event=>{
        if(item.kind!=='link')return;
        event.dataTransfer?.setData('application/x-minternet-bookmark',
          JSON.stringify({id:item.id,url:item.url,name:item.name||''}));
        event.dataTransfer?.setData('text/uri-list',item.url);
        if(event.dataTransfer)event.dataTransfer.effectAllowed='copyMove';
      });
      el.title = item.kind === 'folder' ? textFor(item) : (item.name || item.url);
      el.setAttribute('aria-label', item.kind === 'folder' ? 'Open Folder: ' + textFor(item) : 'Open Bookmark: ' + textFor(item));
      el.addEventListener('click', event => {
        if(item.kind === 'folder') {
          if(window.minternetMenus?.folder) window.minternetMenus.folder(item.id,el);
          else openFolder(item.id);
        } else if(event.ctrlKey || event.metaKey || event.button===1) {
          openInNewTab(item.id);
        } else openLink(item.url);
      });
      el.addEventListener('auxclick', event => {
        if(event.button===1 && item.kind==='link'){
          event.preventDefault();
          openInNewTab(item.id);
        }
      });
      el.addEventListener('contextmenu', event => {
        event.preventDefault();
        if(window.minternetMenus?.bookmark) window.minternetMenus.bookmark(item.id,event);
        else edit(item.id);
      });
      holder.append(el);
    }
  }
  function renderStar() {
    const star = $('bookmarkThisPage');
    const valid = model.url(currentUrl);
    const saved = valid && model.byUrl(data, valid);
    star.disabled = !valid;
    star.classList.toggle('active', Boolean(saved));
    star.textContent = saved ? '★' : '☆';
    star.title = saved ? 'Remove Bookmark (Ctrl+D)' : 'Bookmark This Page (Ctrl+D)';
  }
  function toggleBookmark() {
    const url = model.url(currentUrl);
    if (!url) return toast('Open an HTTPS webpage to bookmark it.');
    const existing = model.byUrl(data, url);
    if (existing) {
      model.remove(data, existing.id);
      toast('Bookmark removed');
    } else {
      const name = currentTitle && currentTitle !== 'New Tab' ? currentTitle : new URL(url).hostname;
      if (!model.add(data, 'link', null, { name, url })) return toast('This website is already bookmarked.');
      toast('Page bookmarked');
    }
    persist();
  }
  function openLink(url) {
    closeOverlay();
    if (!model.url(url)) return toast('Unsafe bookmark URL');
    void act('navigate', url);
  }
  function openInNewTab(id) {
    const node=model.find(data,id);
    if(!node || node.kind!=='link')return false;
    const target=model.url(node.url);
    if(!target)return false;
    // A private tab's Ctrl-click must stay private, and remain in the background.
    const browser=window.minternetGroups?.getLatest();
    const privateTab=Boolean(browser?.tabs?.find(tab=>tab.id===browser.activeId)?.private);
    void act(privateTab?'new-private-background-url':'new-background-url',target);
    return true;
  }
  function deleteBookmark(id,secureMove=false) {
    const node=model.find(data,id);
    if(!node)return false;
    if(node.kind==='folder' && node.children.length &&
      !window.confirm('Delete this folder and everything inside it?'))return false;
    if(!model.remove(data,id))return false;
    // An encrypted move must not create a new undo snapshot containing the
    // site's formerly public URL; still notify encrypted sync to delete it.
    persist(secureMove);
    if(secureMove)window.dispatchEvent(new CustomEvent('minternet:local-change',
      {detail:{kind:'bookmark'}}));
    if(mode==='folder' && folderId===id)closeOverlay();
    toast('Bookmark removed');
    return true;
  }
  // External browser drags arrive as HTML links, URI lists, Firefox
  // bookmark-place objects, or file/directory entries depending on the source.
  // Import into a detached validated tree and save once: one Undo operation.
  const imported=window.MinternetBookmarkImport;
  function appendImported(items,parentId=null){
    if(!imported||!Array.isArray(items)||!items.length)return 0;
    // All-or-nothing capacity check: never create an empty or half-imported
    // folder when Firefox supplied a large nested tree.
    let total=0,maxDepth=0;
    const measure=(nodes,depth)=>{
      for(const node of nodes||[]){
        if(!node||!['folder','link'].includes(node.kind))continue;
        if(node.kind==='link'&&!model.url(node.url))continue;
        total++;maxDepth=Math.max(maxDepth,depth);
        if(node.kind==='folder')measure(node.children,depth+1);
      }
    };
    const destinationDepth=parentId==null?1:(model.location(data,parentId)?.depth??0)+1;
    measure(items,destinationDepth);
    if(model.count(data)+total>model.MAX_ITEMS||maxDepth>=12){
      toast('Folder cannot fit: too many bookmarks or nested folder levels.');
      return 0;
    }
    const draftState=model.hydrate(JSON.stringify(data));
    let added=0;
    const limit=2000;
    function insert(node,parent,depth){
      if(!node||depth>11||added>=limit)return;
      if(node.kind==='folder'){
        const created=model.add(draftState,'folder',parent,{name:node.name||'Imported Folder',icon:node.icon||''});
        if(!created)return;
        added++;
        for(const child of node.children||[])insert(child,created.id,depth+1);
      }else if(node.kind==='link'){
        if(!model.url(node.url))return;
        const created=model.add(draftState,'link',parent,{name:node.name,url:node.url,icon:node.icon||''});
        if(created)added++;
      }
    }
    for(const item of items)insert(item,parentId,0);
    if(!added)return 0;
    if(JSON.stringify(draftState).length>950000){
      toast('This folder is too large for the bookmark store; nothing was imported.');
      return 0;
    }
    data=draftState;
    persist();
    return added;
  }
  async function readImportedFile(file){
    if(!file||file.size>2_000_000)return [];
    const text=await file.text();
    return imported?.parseFile(file.name,text)||[];
  }
  function readDirectory(entry,depth=0){
    if(depth>9)return Promise.resolve([]);
    if(entry.isFile)return new Promise(resolve=>entry.file(async file=>{
      try {resolve(await readImportedFile(file));}
      catch{resolve([]);}
    },()=>resolve([])));
    if(!entry.isDirectory)return Promise.resolve([]);
    const reader=entry.createReader(),children=[];
    return new Promise(resolve=>{
      const read=()=>{
        reader.readEntries(async entries=>{
          if(!entries.length){resolve([{
            kind:'folder',name:entry.name,children
          }]);return;}
          for(const child of entries.slice(0,300)){
            children.push(...await readDirectory(child,depth+1));
          }
          if(children.length>=1000){resolve([{kind:'folder',name:entry.name,children}]);return;}
          read();
        },()=>resolve([]));
      };
      read();
    });
  }
  async function importedFromTransfer(dt){
    const files=Array.from(dt.files||[]);
    const entries=Array.from(dt.items||[]).map(item=>
      item.webkitGetAsEntry?.()).filter(Boolean);
    if(entries.some(entry=>entry.isDirectory)){
      const all=[];
      for(const entry of entries.slice(0,50))all.push(...await readDirectory(entry));
      return all;
    }
    if(files.length){
      const all=[];
      for(const file of files.slice(0,100))all.push(...await readImportedFile(file));
      if(all.length)return all;
    }
    return imported?.parseTransfer(dt)||[];
  }
  function dropTarget(event){
    const target=event.target;
    if(!target?.closest)return null;
    const bookmark=target.closest('.bookmark-item, .bookmark-tree-line, .bookmark-folder-row');
    if(bookmark){
      const id=bookmark.dataset.bookmarkId;
      const node=id&&model.find(data,id);
      if(node?.kind==='folder')return id;
    }
    if(target.closest('#bookmarkFolderMenu')&&mode==='folder')return folderId;
    if(target.closest('#bookmarkBar,#bookmarkManager,#bookmarkTree,#bookmarkItems'))return model.BOOKMARK_BAR_ID;
    return null;
  }
  function externalTransfer(dt){
    const types=Array.from(dt?.types||[]);
    return types.some(type=>['Files','text/uri-list','text/html','text/plain',
      'text/x-moz-url','text/x-moz-place','application/x-moz-place',
      'application/x-moz-place-container','text/x-moz-place-container',
      'application/x-bookmark-folder','application/json'].includes(type));
  }
  let hoverTarget=null;
  function clearDrop(){
    hoverTarget?.classList.remove('bookmark-drop-target');
    hoverTarget=null;
    document.documentElement.classList.remove('bookmark-drag-over');
  }
  document.addEventListener('dragover',event=>{
    // Secret Bookmarks drop targets belong exclusively to the encrypted
    // importer. Never copy their dropped URL into normal bookmark storage.
    if(event.target?.closest?.('[data-secret-target],#secretBookmarksBar,#secretTree'))return;
    if(!externalTransfer(event.dataTransfer))return;
    const parent=dropTarget(event);
    // Browser-chrome must never navigate to dropped external files or URLs.
    event.preventDefault();
    if(parent===null){clearDrop();return;}
    event.dataTransfer.dropEffect='copy';
    clearDrop();
    hoverTarget=event.target.closest('.bookmark-item,.bookmark-tree-line,.bookmark-folder-row')
      || event.target.closest('#bookmarkManager,#bookmarkBar,#bookmarkFolderMenu');
    hoverTarget?.classList.add('bookmark-drop-target');
    document.documentElement.classList.add('bookmark-drag-over');
  },true);
  document.addEventListener('drop',event=>{
    if(event.target?.closest?.('[data-secret-target],#secretBookmarksBar,#secretTree'))return;
    const parent=dropTarget(event);
    if(!externalTransfer(event.dataTransfer))return;
    event.preventDefault();event.stopPropagation();
    if(parent===null){clearDrop();return;}
    // Capture text formats synchronously: browser DataTransfer is cleared after
    // the drop event finishes, even while files are read asynchronously.
    const dt=event.dataTransfer;
    const plain=imported?.parseTransfer(dt)||[];
    const firefoxFolder=imported?.mozillaFolderReference(dt)||null;
    const folderFlavor=Array.from(dt.types||[]).some(type=>
      type==='text/x-moz-place-container'||type==='application/x-moz-place-container'
      ||type==='application/x-bookmark-folder');
    const files=Array.from(dt.files||[]);
    const entries=Array.from(dt.items||[]).map(item=>item.webkitGetAsEntry?.()).filter(Boolean);
    clearDrop();
    void (async()=>{
      let items=plain;
      if(firefoxFolder&&window.__TAURI__){
        // Prioritize the actual Firefox Places folder over any generic .url
        // files or text/uri-list representations the OS supplies in parallel.
        // A Firefox reference identifies precisely the dropped folder.
        const result=await api.command('firefox-folder-import',firefoxFolder);
        if(result?.kind==='folder'){
          items=[result];
        }else if(!items.some(node=>node.kind==='folder'&&node.children?.length)){
          toast(result?.message||'Firefox could not provide the folder contents. Export it as bookmarks HTML to import.');
          return;
        }
      }else if(entries.some(entry=>entry.isDirectory)){
        items=[];
        for(const entry of entries.slice(0,50))items.push(...await readDirectory(entry));
      }else if(files.length){
        items=[];
        for(const file of files.slice(0,100))items.push(...await readImportedFile(file));
        if(!items.length)items=plain;
      }
      if(folderFlavor&&!firefoxFolder&&!items.some(node=>node.kind==='folder')){
        toast('This browser did not expose the folder contents. Export bookmarks as HTML and drop the file instead.');
        return;
      }
      if(items.some(node=>node.kind==='folder'&&Array.isArray(node.children)&&node.children.length===0)
        &&firefoxFolder&&items.length===1&&!window.__TAURI__){
        toast('Firefox only supplied the folder name; import a bookmarks HTML export to preserve its contents.');
        return;
      }
      const added=appendImported(items,parent||model.BOOKMARK_BAR_ID);
      if(added){
        toast('Imported '+added+' bookmark'+(added===1?'':'s')+' / folders');
      }else if(!items.length){
        toast('No transferable bookmarks found. Export bookmarks as HTML and drop that file here.');
      }
    })();
  },true);
  document.addEventListener('dragend',clearDrop,true);
  document.addEventListener('dragleave',event=>{
    if(!event.relatedTarget)clearDrop();
  },true);
  $('bookmarkImportFile')?.addEventListener('click',()=>$('bookmarkImportInput')?.click());
  $('bookmarkImportInput')?.addEventListener('change',async event=>{
    let items=[];
    for(const file of Array.from(event.target.files||[]).slice(0,100)){
      items.push(...await readImportedFile(file));
    }
    const added=appendImported(items,mode==='folder'?folderId:model.BOOKMARK_BAR_ID);
    toast(added?'Imported '+added+' items':'No supported bookmarks found in selected files');
    event.target.value='';
  });
  function nativeOverlay(open) {
    if (window.__TAURI__) void act('chrome-overlay', open);
  }
  function setMode(next) {
    mode = next;
    $('bookmarkOverlay').hidden = !next;
    for (const [name, id] of [
      ['settings', 'bookmarkSettings'], ['folder', 'bookmarkFolderMenu'],
      ['manager', 'bookmarkManager'], ['editor', 'bookmarkEditor']
    ]) $(id).hidden = next !== name;
    $('settings').setAttribute('aria-expanded', String(next === 'settings'));
    // Settings is separate from the bookmark manager; the bookmark list stays
    // out of view until Manage Bookmarks is explicitly selected.
    document.documentElement.classList.toggle('settings-visible',next==='settings');
    nativeOverlay(Boolean(next));
  }
  function closeOverlay() {
    if (!mode) return;
    setMode(null);
    $('settings').focus();
  }
  function openSettings() {
    if (mode === 'settings') closeOverlay();
    else setMode('settings');
  }
  function openFolder(id) {
    const folder = model.find(data, id);
    if (!folder || folder.kind !== 'folder') return toast('Folder no longer exists');
    folderId = id;
    renderFolder();
    setMode('folder');
  }
  function folderParent() {
    const info = model.location(data, folderId);
    if (info?.parent) openFolder(info.parent.id);
    else { renderManager(); setMode('manager'); }
  }
  function entryForMenu(item) {
    const row = document.createElement('div');
    row.className = 'bookmark-folder-row';
    row.dataset.bookmarkId=item.id;
    const open = document.createElement('button');
    open.className = 'bookmark-folder-entry';
    open.type = 'button';
    open.append(iconNode(item));
    const name = document.createElement('span');
    name.textContent = textFor(item);
    open.append(name);
    const label = document.createElement('span');
    label.textContent = item.kind === 'folder' ? '›' : '↗';
    open.append(label);
    open.title = textFor(item);
    open.addEventListener('click', () => item.kind === 'folder' ? openFolder(item.id) : openLink(item.url));
    const editButton = document.createElement('button');
    editButton.className = 'edit';
    editButton.textContent = '✎';
    editButton.type = 'button';
    editButton.title = 'Edit ' + textFor(item);
    editButton.setAttribute('aria-label', 'Edit ' + textFor(item));
    editButton.addEventListener('click', () => edit(item.id));
    row.append(open, editButton);
    return row;
  }
  function renderFolder() {
    const folder = model.find(data, folderId);
    if (!folder || folder.kind !== 'folder') { setMode('manager'); return; }
    $('bookmarkFolderTitle').textContent = textFor(folder);
    const contents = $('bookmarkFolderContents');
    contents.replaceChildren();
    if (!folder.children.length) {
      const empty = document.createElement('div');
      empty.className = 'bookmark-settings-foot';
      empty.textContent = 'Empty folder · Add a subfolder or save this page.';
      contents.append(empty);
    }
    for (const item of folder.children) contents.append(entryForMenu(item));
    $('bookmarkFolderEdit').hidden=folder.id===model.BOOKMARK_BAR_ID;
  }
  function renderManager() {
    const tree = $('bookmarkTree');
    tree.replaceChildren();
    if (!model.barItems(data).length) {
      const empty = document.createElement('div');
      empty.className = 'bookmark-settings-foot';
      empty.textContent = 'No bookmarks yet · Create a folder or star a page.';
      tree.append(empty);
    }
    function walk(items, depth) {
      for (const item of items) {
        const row = document.createElement('div');
        row.className = 'bookmark-tree-line';
        row.dataset.bookmarkId=item.id;
        if(item.kind==='link'){
          row.draggable=true;
          row.addEventListener('dragstart',event=>{
            event.dataTransfer?.setData('application/x-minternet-bookmark',
              JSON.stringify({id:item.id,url:item.url,name:item.name||''}));
            event.dataTransfer?.setData('text/uri-list',item.url);
            if(event.dataTransfer)event.dataTransfer.effectAllowed='copyMove';
          });
        }
        row.style.paddingLeft = Math.min(160, depth * 13 + 4) + 'px';
        const icon = iconNode(item);
        const label = document.createElement('button');
        label.className = 'label';
        label.textContent = textFor(item);
        label.title = item.kind === 'link' ? item.url : textFor(item);
        label.addEventListener('click', () => item.kind === 'folder' ? openFolder(item.id) : openLink(item.url));
        row.append(icon, label);
        if (item.kind === 'folder') {
          const add = document.createElement('button');
          add.className = 'action';
          add.textContent = '＋';
          add.title = 'Add Subfolder';
          add.setAttribute('aria-label', 'Add Subfolder to ' + textFor(item));
          add.addEventListener('click', () => openEditor('folder', null, item.id));
          row.append(add);
        }
        if(item.id!==model.BOOKMARK_BAR_ID){
          const editButton = document.createElement('button');
          editButton.className = 'action';
          editButton.textContent = '✎';
          editButton.title = 'Edit / Move';
          editButton.setAttribute('aria-label', 'Edit ' + textFor(item));
          editButton.addEventListener('click', () => edit(item.id));
          row.append(editButton);
        }
        tree.append(row);
        if (item.kind === 'folder') walk(item.children, depth + 1);
      }
    }
    walk(data.items, 0);
  }
  function edit(id) {
    if(id===model.BOOKMARK_BAR_ID)return openFolder(id);
    const node = model.find(data, id);
    if (!node) return toast('Bookmark not found');
    const info = model.location(data, id);
    openEditor(node.kind, id, info?.parent?.id ?? null);
  }
  function openEditor(kind, id = null, parentId = null) {
    if(id===model.BOOKMARK_BAR_ID)return openFolder(id);
    const node = id ? model.find(data, id) : null;
    draft = { kind, id, parentId };
    $('bookmarkEditorTitle').textContent = id ? 'Edit ' + (kind === 'folder' ? 'Folder' : 'Bookmark') : 'New ' + (kind === 'folder' ? 'Folder' : 'Bookmark');
    $('bookmarkName').value = node?.name || '';
    $('bookmarkUrlField').hidden = kind === 'folder';
    $('bookmarkUrl').value = node?.url || (kind === 'link' ? model.url(currentUrl) || '' : '');
    $('bookmarkRemove').hidden = !id;
    customIcon = node?.icon || '';
    $('bookmarkIcon').value = customIcon.startsWith('data:') || customIcon.startsWith('https://') ? '' : customIcon;
    $('bookmarkImageFile').value = '';
    const sourceSelect=$('bookmarkIconSource');
    sourceSelect.replaceChildren(new Option('Use Any Bookmark’s Icon…',''));
    const collect=items=>{
      for(const item of items){
        if(item.kind==='link')sourceSelect.add(new Option(textFor(item).slice(0,85),item.id));
        else if(item.kind==='folder')collect(item.children||[]);
      }
    };
    collect(data.items);
    sourceSelect.value='';
    renderIconPreview();
    const parentList = $('bookmarkParent');
    parentList.replaceChildren();
    const rootOption = document.createElement('option');
    rootOption.value = '';
    rootOption.value = model.BOOKMARK_BAR_ID;
    rootOption.textContent = 'Bookmark Bar';
    parentList.append(rootOption);
    for (const f of model.folders(data)) {
      if(f.id===model.BOOKMARK_BAR_ID)continue;
      const option = document.createElement('option');
      option.value = f.id;
      option.textContent = '  '.repeat(f.depth) + (f.icon && !f.icon.startsWith('data:') ? f.icon + ' ' : '📁 ') + (f.name || 'Unnamed Folder');
      if (id === f.id || (kind === 'folder' && id && model.location(data, f.id)?.depth > model.location(data, id)?.depth && isDescendant(id, f.id))) option.disabled = true;
      parentList.append(option);
    }
    parentList.value = parentId || model.BOOKMARK_BAR_ID;
    if (parentList.value !== (parentId || model.BOOKMARK_BAR_ID)) parentList.value = model.BOOKMARK_BAR_ID;
    setMode('editor');
    $('bookmarkName').focus();
  }
  function isDescendant(ancestorId, candidateId) {
    let cursor = model.location(data, candidateId);
    while (cursor?.parent) {
      if (cursor.parent.id === ancestorId) return true;
      cursor = model.location(data, cursor.parent.id);
    }
    return false;
  }
  function renderIconPreview() {
    const el = $('bookmarkIconPreview');
    el.replaceChildren();
    el.append(iconNode({
      icon:customIcon,kind:draft?.kind || 'folder',
      url:draft?.kind==='link'?$('bookmarkUrl').value:''
    }, draft?.kind === 'folder'));
  }
  function saveEditor(event) {
    event.preventDefault();
    if (!draft) return;
    const parent = $('bookmarkParent').value || model.BOOKMARK_BAR_ID;
    const name = $('bookmarkName').value;
    const url = draft.kind === 'link' ? model.url($('bookmarkUrl').value) : null;
    if (draft.kind === 'link' && !url) return toast('Enter a valid HTTPS website address.');
    if (draft.id) {
      if (parent !== (draft.parentId||model.BOOKMARK_BAR_ID) && !model.move(data, draft.id, parent)) return toast('Cannot move a folder into itself or its descendant.');
      if (!model.update(data, draft.id, { name, icon:customIcon, ...(draft.kind === 'link' ? {url} : {}) })) return toast('Could not update this bookmark.');
    } else {
      const item = model.add(data, draft.kind, parent, {name, icon:customIcon, ...(draft.kind === 'link' ? {url} : {})});
      if (!item) return toast('Could not create bookmark. Check folder depth or item limit.');
    }
    persist();
    closeOverlay();
  }
  function deleteEditor() {
    if (!draft?.id || draft.id===model.BOOKMARK_BAR_ID) return;
    const node = model.find(data, draft.id);
    if (node?.kind === 'folder' && node.children.length &&
        !window.confirm('Delete this folder and everything inside it?')) return;
    if (model.remove(data, draft.id)) {
      persist();
      closeOverlay();
      toast('Removed');
    }
  }
  async function imageFromFile(file) {
    if (!file || !(file.type.startsWith('image/') ||
        /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif|heic|tiff?)$/i.test(file.name)) ||
        file.size > 12000000) {
      throw new Error('Choose an image file smaller than 12 MB.');
    }
    const source = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read image'));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(file);
    });
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('Could not decode image'));
      img.src = source;
    });
    const canvas = document.createElement('canvas');
    canvas.width = 32; canvas.height = 32;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Image conversion is unavailable.');
    ctx.clearRect(0,0,32,32);
    const scale = Math.min(32/img.naturalWidth,32/img.naturalHeight);
    const w = Math.max(1,Math.round(img.naturalWidth*scale));
    const h = Math.max(1,Math.round(img.naturalHeight*scale));
    ctx.drawImage(img,(32-w)/2,(32-h)/2,w,h);
    const result = canvas.toDataURL('image/png');
    if (!model.icon(result)) throw new Error('Image is too complex to store as a small icon.');
    return result;
  }
  $('bookmarkThisPage').addEventListener('click', toggleBookmark);
  $('bookmarkThisPage').addEventListener('contextmenu', event => {
    event.preventDefault();
    const existing = model.byUrl(data, currentUrl);
    if (existing) edit(existing.id);
    else if (model.url(currentUrl)) openEditor('link');
  });
  $('settings').addEventListener('click', openSettings);
  $('bookmarkBackdrop').addEventListener('click', closeOverlay);
  $('bookmarkSettingsClose').addEventListener('click', closeOverlay);
  $('bookmarkManageClose').addEventListener('click', closeOverlay);
  $('bookmarkFolderClose').addEventListener('click', closeOverlay);
  $('bookmarkEditClose').addEventListener('click', closeOverlay);
  $('bookmarkCancel').addEventListener('click', closeOverlay);
  $('bookmarkBarToggle').addEventListener('change', event => changeVisibility(event.target.checked));
  const idleSelect=$('autoUnloadMinutes');
  if(idleSelect){
    const saved=localStorage.getItem('minternet.autoUnloadMinutes.v1');
    if(saved!==null && [...idleSelect.options].some(opt=>opt.value===saved))idleSelect.value=saved;
    idleSelect.addEventListener('change',()=>{
      localStorage.setItem('minternet.autoUnloadMinutes.v1',idleSelect.value);
    });
  }
  $('bookmarkSettingsManage').addEventListener('click', () => { renderManager(); setMode('manager'); });
  $('bookmarkBarManage').addEventListener('click', () => { renderManager(); setMode('manager'); });
  $('bookmarkManageNewFolder').addEventListener('click', () => openEditor('folder'));
  $('bookmarkManageNewLink').addEventListener('click', () => openEditor('link'));
  $('bookmarkFolderBack').addEventListener('click', folderParent);
  $('bookmarkFolderNew').addEventListener('click', () => openEditor('folder',null,folderId));
  $('bookmarkFolderEdit').addEventListener('click', () => edit(folderId));
  $('bookmarkEditForm').addEventListener('submit', saveEditor);
  $('bookmarkRemove').addEventListener('click', deleteEditor);
  $('bookmarkUrl').addEventListener('input',()=>{
    if(draft?.kind==='link'&&!customIcon)renderIconPreview();
  });
  $('bookmarkIcon').addEventListener('input', event => {
    customIcon = event.target.value;
    renderIconPreview();
  });
  $('bookmarkIconUpload').addEventListener('click', () => $('bookmarkImageFile').click());
  $('bookmarkIconSource').addEventListener('change', async event=>{
    const node=model.find(data,event.target.value);
    if(!node||node.kind!=='link')return;
    const editorId=draft?.id,editorKind=draft?.kind;
    let selected=model.icon(node.icon);
    if(!selected){
      const candidates=await iconSources(node.url);
      selected=candidates[0]||model.favicon(node.url)||'';
    }
    if(draft?.id!==editorId||draft?.kind!==editorKind)return;
    customIcon=model.icon(selected);
    $('bookmarkIcon').value=customIcon.startsWith('data:')||customIcon.startsWith('https://')?'':customIcon;
    renderIconPreview();
  });
  $('bookmarkImageFile').addEventListener('change', async event => {
    try {
      const file = event.target.files?.[0];
      if (!file) return;
      customIcon = await imageFromFile(file);
      $('bookmarkIcon').value = '';
      renderIconPreview();
    } catch(e) { toast(e.message || 'Could not use image.'); }
  });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && mode) { event.preventDefault(); closeOverlay(); }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'b') {
      event.preventDefault(); changeVisibility(!data.visible); return;
    }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'o') {
      event.preventDefault(); renderManager(); setMode('manager'); return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      toggleBookmark();
    }
  });
  // Controllers are accessible only within trusted local chrome. Remote
  // website WebView2 pages have neither this JS context nor native menu IPC.
  window.minternetBookmarks = {
    getState: () => data,
    edit, deleteBookmark, openInNewTab, newFolder: parent => openEditor('folder',null,parent||null),
    savePage: parent => {
      const target=model.url(currentUrl);
      if(!target)return toast('Open an HTTPS page to bookmark it.');
      if(!model.add(data,'link',parent||null,{
        name:currentTitle||new URL(target).hostname,url:target
      }))return toast('Website already bookmarked; no duplicate created.');
      persist();toast('Page bookmarked');
    },
    openLink, toggleBookmark, manager:()=>{renderManager();setMode('manager');},
    toggleBar:()=>changeVisibility(!data.visible),
    closeOverlay,restoreUndoBookmark,
    applySyncedState:incoming=>{
      if(!incoming || !Array.isArray(incoming.items))return false;
      data=model.hydrate(incoming);
      applyVisibility();persist(true);
      return true;
    }
  };
  api.onState(state => {
    const tab = state.tabs.find(t => t.id === state.activeId);
    currentUrl = tab?.url || '';
    currentTitle = tab?.title || '';
    renderStar();
  });
  // Persist the one-time flat-root to Bookmark Bar migration without Undo.
  try{
    const json=JSON.stringify(data);
    if(localStorage.getItem(STORE)!==json)localStorage.setItem(STORE,json);
  }catch{}
  // Initial hydration is synchronous and survives portable EXE restarts in the
  // trusted Tauri WebView2 profile, independent of website sessions.
  applyVisibility();
  renderBar();
  renderStar();
})();
