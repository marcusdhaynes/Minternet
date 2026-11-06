'use strict';
// Secret Bookmarks never use localStorage for addresses, content, codes, or
// ciphertext. Only the chosen tab-group display name is a public preference.
(() => {
  const api=window.minternet;
  if(!api)return;
  const $=id=>document.getElementById(id);
  const model=window.MinternetBookmarks;
  const screen=$('secretScreen'),tree=$('secretTree'),lockedForm=$('secretAuthForm');
  if(!screen||!tree||!lockedForm)return;
  const GROUP_PREF='minternet.secret-group-name.v1';
  let status={exists:false,unlocked:false,items:[]};
  let selected=new Set(),folder=null,pendingAdd=null,pendingDrop=null,pendingReveal=null;
  let editMode=null,editId=null,editorTrueTitle='',pendingNormalId=null,starMenu=null,autoLockTimer=null,suppressStarClick=false;
  let lastState=null;
  const tell=message=>{
    const el=$('secretMessage');
    el.textContent=String(message||'');
    window.minternetToast?.(message);
  };
  const request=async(name,value)=>{
    const result=await api.command(name,value);
    if(result?.message)throw new Error(result.message);
    return result;
  };
  function overlay(open){
    screen.hidden=!open;
    if(window.__TAURI__)void api.command('chrome-overlay',open);
    if(open)$('secretCode').focus();
  }
  const setGroupPreference=input=>{
    const value=String(input||'#####').trim().slice(0,42)||'#####';
    $('secretGroupName').value=value;
    if($('secretGroupNameSettings'))$('secretGroupNameSettings').value=value;
    try{localStorage.setItem(GROUP_PREF,value);}catch{}
    return value;
  };
  const savePreference=()=>setGroupPreference($('secretGroupName').value);
  try{setGroupPreference(localStorage.getItem(GROUP_PREF)||'#####');}
  catch{setGroupPreference('#####');}
  $('secretGroupName').addEventListener('change',savePreference);
  $('secretGroupNameSettings')?.addEventListener('change',event=>setGroupPreference(event.target.value));
  function securePreview(){
    const bytes=new Uint8Array(18);
    crypto.getRandomValues(bytes);
    return [...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');
  }
  function refreshPreview(){
    $('secretScrambledName').textContent=securePreview();
    $('secretScrambledLink').textContent=securePreview();
  }
  function updateState(next){
    if(next?.message)throw new Error(next.message);
    if(next?.items)status.items=next.items;
    if(typeof next?.exists==='boolean')status.exists=next.exists;
    if(typeof next?.unlocked==='boolean')status.unlocked=next.unlocked;
    $('secretAuthForm').hidden=status.unlocked;
    $('secretUnlocked').hidden=!status.unlocked;
    $('secretLock').hidden=!status.unlocked;
    $('secretAuthButton').textContent=status.exists?'Unlock Secret Bookmarks':'Create Secret Code & Vault';
    if(status.unlocked){
      if(folder&&!status.items.some(item=>item.id===folder&&item.kind==='folder'))folder=null;
      render();
    }
  }
  async function readStatus(){updateState(await request('secret-status'));}
  async function open(){
    if(!window.__TAURI__){tell('Secret Bookmarks requires the installed Minternet application.');return;}
    await readStatus();
    // The secret dialog takes over the trusted chrome; leave no ordinary
    // bookmark manager behind it that could receive dropped secret content.
    window.minternetBookmarks?.closeOverlay();
    overlay(true);
    if(status.unlocked)render();
    else{
      $('secretAuthButton').textContent=status.exists?'Unlock Secret Bookmarks':'Create Secret Code & Vault';
      $('secretCode').value='';
      tell(status.exists?
        'Unlock using the separate Secret Bookmarks code. URLs remain encrypted while locked.':
        'Create a separate secret code before saving encrypted bookmarks. The code is never stored.');
    }
  }
  function close(){
    overlay(false);
    $('secretEditor').hidden=true;
    $('secretCode').value='';
    pendingAdd=null;pendingDrop=null;pendingNormalId=null;editorTrueTitle='';
  }
  async function lock(){
    try{await request('secret-lock');}catch(error){tell(error.message);return;}
    status.unlocked=false;
    updateState(status);
    $('secretCode').value='';
    $('secretEditor').hidden=true;
    selected.clear();
    clearTimeout(autoLockTimer);
    tell('Secret Bookmarks locked. The encryption key was cleared from Minternet memory.');
  }
  function armLock(){
    clearTimeout(autoLockTimer);
    autoLockTimer=setTimeout(()=>{
      if(status.unlocked)void lock();
    },10*60*1000);
  }
  function ancestry(id){
    const chain=[];let node=status.items.find(x=>x.id===id);
    let safety=0;
    while(node&&safety++<12){
      chain.unshift(node);
      node=status.items.find(x=>x.id===node.parent);
    }
    return chain;
  }
  function breadcrumb(){
    const el=$('secretBreadcrumb');el.replaceChildren();
    const root=document.createElement('button');
    root.textContent='◈ Secret Bookmarks';root.type='button';
    root.addEventListener('click',()=>{folder=null;render();});
    el.append(root);
    for(const part of ancestry(folder)){
      const b=document.createElement('button');b.type='button';
      b.textContent='› '+(part.visibleName||'Untitled Folder');
      b.addEventListener('click',()=>{folder=part.id;render();});
      el.append(b);
    }
  }
  function makeRow(item){
    const row=document.createElement('div');
    row.className='secret-row';
    row.dataset.secretId=item.id;
    row.dataset.secretTarget=item.kind==='folder'?item.id:'';
    row.setAttribute('role','listitem');
    row.draggable=false;
    const kind=item.kind==='folder';
    if(!kind){
      const box=document.createElement('input');box.type='checkbox';
      box.className='secret-pick';box.checked=selected.has(item.id);
      box.setAttribute('aria-label','Select '+(item.visibleName||'Secret Bookmark'));
      box.addEventListener('change',()=>{
        if(box.checked)selected.add(item.id);else selected.delete(item.id);
      });
      row.append(box);
    }else{
      const folderIcon=document.createElement('span');
      folderIcon.textContent='📁';folderIcon.className='secret-folder-icon';
      row.append(folderIcon);
    }
    const title=document.createElement('button');title.type='button';title.className='secret-row-title';
    title.textContent=item.visibleName || (kind?'Secret Folder':'◈ Untitled Secret');
    title.title=kind?'Open Secret Folder':'Open this secret bookmark in an unloaded background tab';
    title.addEventListener('click',()=>{
      if(kind){folder=item.id;render();}
      else void openMany([item.id]);
    });
    row.append(title);
    const edit=document.createElement('button');edit.type='button';edit.className='secret-row-action';
    edit.textContent='✎';edit.title='Edit visible label';
    edit.addEventListener('click',()=>editLabel(item));
    const del=document.createElement('button');del.type='button';del.className='secret-row-action';
    del.textContent='×';del.title='Delete encrypted bookmark';
    del.addEventListener('click',()=>void removeItem(item));
    row.append(edit,del);
    // A secret bookmark must never be draggable back into a regular bookmark
    // bar or website. The root and child folders remain drop *targets* only.
    row.addEventListener('dragstart',event=>{event.preventDefault();event.stopPropagation();},true);
    return row;
  }
  function render(){
    if(!status.unlocked)return;
    breadcrumb();tree.replaceChildren();
    const children=status.items.filter(item=>(item.parent||null)===(folder||null));
    if(!children.length){
      const empty=document.createElement('div');
      empty.className='secret-empty';empty.textContent='No secret bookmarks in this folder';
      tree.append(empty);
    }
    for(const item of children)tree.append(makeRow(item));
    $('secretOpenSelected').disabled=!status.items.some(x=>selected.has(x.id));
  }
  function editor(kind='link',url='',title='',id=null){
    if(!status.unlocked){
      pendingAdd={kind,url,title};
      void open();return;
    }
    editMode=kind;editId=id;editorTrueTitle=title||'';
    $('secretUnlocked').hidden=true;
    $('secretEditor').hidden=false;
    $('secretEditorTitle').textContent=id?'Edit Visible Name':kind==='folder'?'New Secret Folder':'New Secret Bookmark';
    $('secretUrlLabel').hidden=kind==='folder'||Boolean(id);
    $('secretUrl').value=url||'';
    $('secretVisibleName').value=id
      ?status.items.find(x=>x.id===id)?.visibleName||'':'';
    refreshPreview();
    $('secretVisibleName').focus();
  }
  function addPage(url,title){
    if(!url)url=lastState?.tabs.find(t=>t.id===lastState.activeId)?.url||'';
    if(!model?.url(url)||url==='about:blank'){
      tell('Open a website before adding a secret bookmark.');return;
    }
    pendingAdd={kind:'link',url,title:title||lastState?.tabs.find(t=>t.id===lastState.activeId)?.title||''};
    void open().then(()=>{if(status.unlocked&&pendingAdd){
      const item=pendingAdd;pendingAdd=null;editor(item.kind,item.url,item.title);
    }}).catch(e=>tell(e.message));
  }
  function editLabel(item){editor(item.kind,'','',item.id);}
  async function removeItem(item){
    const label=item.visibleName||'Secret Bookmark';
    if(!window.confirm('Permanently delete '+label+' and any contents?'))return;
    try{updateState(await request('secret-delete',{id:item.id}));selected.delete(item.id);}
    catch(e){tell(e.message);}
  }
  async function openMany(ids){
    if(!status.unlocked){
      pendingDrop={openIds:ids};
      try{await open();}catch(e){tell(e.message);}
      return;
    }
    try{
      const unique=[...new Set(ids)];
      const result=await request('secret-open',{ids:unique});
      const tabIds=result.tabIds||[];
      if(tabIds.length>1){
        const groups=window.minternetGroups;
        const g=groups?.createGroup(savePreference(),'violet');
        if(g)for(const id of tabIds)groups.assign(id,g.id);
      }
      selected.clear();render();
      tell(tabIds.length+' Secret Bookmark'+(tabIds.length===1?'':'s')+
        ' opened in background, unloaded. Select a tab and press its eye to load.');
      armLock();
    }catch(error){tell(error.message);}
  }
  async function reveal(){
    const state=lastState;
    const tab=state?.tabs.find(x=>x.id===state.activeId);
    if(!tab?.secretPending)return;
    try{
      const result=await request('secret-reveal',{tabId:tab.id});
      if(result?.ok)armLock();
    }catch(error){
      if(/unlock|code|locked/i.test(error.message)){
        pendingReveal=tab.id;
        void open().catch(e=>tell(e.message));
      }else tell(error.message);
    }
  }
  async function saveEditor(event){
    event.preventDefault();
    if(!status.unlocked)return;
    const visibleName=$('secretVisibleName').value.trim();
    try{
      const result=editId
        ?await request('secret-edit',{id:editId,visibleName})
        :await request('secret-put',{kind:editMode,parent:folder,
          visibleName,url:editMode==='link'?$('secretUrl').value:'',title:editorTrueTitle});
      updateState(result);
      const savedUrl=editMode==='link'&&!editId?$('secretUrl').value:'';
      // Best-effort removal from ordinary local history after the encrypted
      // write succeeds. It cannot erase network/OS logs or cloud backups.
      if(savedUrl)void api.command('history-remove',savedUrl);
      $('secretUrl').value='';
      if(pendingNormalId){
        window.minternetBookmarks?.deleteBookmark(pendingNormalId,true);
        pendingNormalId=null;
      }
      editorTrueTitle='';
      $('secretEditor').hidden=true;
      $('secretUnlocked').hidden=false;
      editId=null;editMode=null;
      render();armLock();
      tell('Saved with authenticated encryption. The actual URL is not displayed or stored in ordinary bookmarks.');
    }catch(error){tell(error.message);}
  }
  async function authenticate(event){
    event.preventDefault();
    const code=$('secretCode').value;
    if([...code].length>16 || [...code].length<1){
      tell('Code must contain 1–16 characters, including any punctuation.');return;
    }
    try{
      // The code is used only as raw UTF-8 Argon2id input by the native app.
      const result=await request('secret-auth',{code,create:!status.exists});
      $('secretCode').value='';
      updateState(result);
      armLock();
      tell('Secret Bookmarks unlocked.');
      if(pendingAdd){
        const item=pendingAdd;pendingAdd=null;
        editor(item.kind,item.url,item.title);
      }else if(pendingDrop){
        const task=pendingDrop;pendingDrop=null;
        if(task.openIds)await openMany(task.openIds);
        else await saveDropped(task);
      }else if(pendingReveal!=null){
        const id=pendingReveal;pendingReveal=null;
        const current=lastState?.tabs.find(x=>x.id===lastState?.activeId);
        if(current?.id===id)await reveal();
      }
    }catch(error){
      $('secretCode').value='';
      tell(error.message);
    }
  }
  function websiteTransfer(dt){
    const get=type=>{try{return dt.getData(type)||'';}catch{return '';}};
    let custom=get('application/x-minternet-bookmark');
    if(custom){
      try{
        const raw=JSON.parse(custom);
        if(model?.url(raw.url))return [{kind:'link',url:raw.url,name:raw.name||'',
          sourceId:typeof raw.id==='string'?raw.id:null}];
      }catch{}
    }
    const imported=window.MinternetBookmarkImport?.parseTransfer(dt)||[];
    return imported;
  }
  async function saveDropped({nodes,parent}){
    if(!status.unlocked){pendingDrop={nodes,parent};await open();return;}
    let saved=0;
    async function go(node,where,depth){
      if(depth>=12||saved>=100)return;
      if(node.kind==='folder'){
        const result=await request('secret-put',{kind:'folder',parent:where,
          visibleName:node.name||'Imported Folder'});
        saved++;
        for(const child of node.children||[])await go(child,result.id,depth+1);
      }else if(node.kind==='link'&&model?.url(node.url)){
        await request('secret-put',{kind:'link',parent:where,
          visibleName:node.name||'',url:node.url,title:node.name||''});
        saved++;
        void api.command('history-remove',node.url);
        if(node.sourceId)window.minternetBookmarks?.deleteBookmark(node.sourceId,true);
      }
    }
    try{
      for(const node of nodes.slice(0,100))await go(node,parent,0);
      updateState(await request('secret-status'));
      tell('Encrypted '+saved+' dropped item'+(saved===1?'':'s')+'.');
      armLock();
    }catch(error){tell('Imported '+saved+' items before error: '+error.message);}
  }
  function isSecretDropTarget(event){
    const target=event.target?.closest?.('[data-secret-target],#secretBookmarksBar,#secretTree');
    if(!target)return null;
    return target.dataset.secretTarget||'root';
  }
  document.addEventListener('dragover',event=>{
    const id=isSecretDropTarget(event);
    if(id===null)return;
    const dt=event.dataTransfer;
    if(!dt||!Array.from(dt.types||[]).some(type=>
      ['text/uri-list','text/plain','text/html','text/x-moz-url',
        'application/x-minternet-bookmark','text/x-moz-place','Files'].includes(type)))return;
    event.preventDefault();event.stopImmediatePropagation();
    dt.dropEffect='copy';
  },true);
  document.addEventListener('drop',event=>{
    const id=isSecretDropTarget(event);
    if(id===null)return;
    event.preventDefault();event.stopImmediatePropagation();
    const imported=websiteTransfer(event.dataTransfer);
    if(!imported.length){tell('Drop a website or bookmark onto Secret Bookmarks.');return;}
    pendingDrop={nodes:imported,parent:id==='root'?null:id};
    void open().then(async()=>{
      if(status.unlocked&&pendingDrop){
        const task=pendingDrop;pendingDrop=null;await saveDropped(task);
      }
    }).catch(e=>tell(e.message));
  },true);
  document.addEventListener('dragstart',event=>{
    if(event.target.closest?.('.secret-row,#secretBookmarksManager,#secretBookmarksBar')){
      event.preventDefault();event.stopImmediatePropagation();
    }
  },true);
  function contextualStar(event){
    event.preventDefault();
    starMenu?.remove();
    const menu=document.createElement('div');menu.className='secret-star-menu';
    const add=document.createElement('button');
    add.textContent='◈  Add to Secret Bookmarks';
    add.addEventListener('click',()=>{starMenu?.remove();starMenu=null;addPage();});
    const normal=document.createElement('button');
    normal.textContent='☆  '+(window.minternetBookmarks?.getState()&&
      model.byUrl(window.minternetBookmarks.getState(),
        lastState?.tabs.find(t=>t.id===lastState.activeId)?.url||'')?'Edit Bookmark':'Bookmark Page');
    normal.addEventListener('click',()=>{
      starMenu?.remove();starMenu=null;
      const url=lastState?.tabs.find(t=>t.id===lastState.activeId)?.url||'';
      const existing=model.byUrl(window.minternetBookmarks?.getState(),url);
      if(existing)window.minternetBookmarks?.edit(existing.id);
      else window.minternetBookmarks?.toggleBookmark();
    });
    menu.append(add,normal);
    document.body.append(menu);starMenu=menu;
    // A native child WebView2 can overlap an HTML popup unless the trusted
    // browser chrome is raised while this context menu is open.
    if(window.__TAURI__)void api.command('chrome-overlay',true);
    menu.style.left=Math.max(5,Math.min(event.clientX,window.innerWidth-235))+'px';
    menu.style.top=Math.max(5,Math.min(event.clientY,window.innerHeight-75))+'px';
    const dismiss=e=>{if(menu.contains(e.target))return;
      menu.remove();if(starMenu===menu)starMenu=null;
      if(screen.hidden&&$('bookmarkOverlay')?.hidden&&window.__TAURI__)
        void api.command('chrome-overlay',false);
      document.removeEventListener('pointerdown',dismiss,true);
    };
    document.addEventListener('pointerdown',dismiss,true);
  }
  function installStarHold(){
    const star=$('bookmarkThisPage');if(!star)return;
    let timer=null,activated=false;
    const start=event=>{
      if(event.button!==0 || star.disabled)return;
      activated=false;
      clearTimeout(timer);
      timer=setTimeout(()=>{
        activated=true;suppressStarClick=true;
        star.classList.add('secret-star-flash');
        let done=false;
        const finish=()=>{
          if(done)return;
          done=true;star.classList.remove('secret-star-flash');addPage();
        };
        star.addEventListener('animationend',finish,{once:true});
        setTimeout(finish,1050);
      },620);
    };
    const stop=()=>clearTimeout(timer);
    star.addEventListener('pointerdown',start);
    for(const event of ['pointerup','pointercancel','pointerleave'])star.addEventListener(event,stop);
    star.addEventListener('click',event=>{
      if(!suppressStarClick)return;
      event.preventDefault();event.stopImmediatePropagation();
      suppressStarClick=false;
    },true);
    star.addEventListener('contextmenu',event=>{
      event.stopImmediatePropagation();contextualStar(event);
    },true);
  }
  $('secretBookmarksBar')?.addEventListener('click',()=>void open().catch(e=>tell(e.message)));
  $('secretSettingsOpen')?.addEventListener('click',()=>void open().catch(e=>tell(e.message)));
  $('secretBookmarksManager')?.addEventListener('click',()=>void open().catch(e=>tell(e.message)));
  $('secretAuthForm').addEventListener('submit',event=>void authenticate(event));
  $('secretClose').addEventListener('click',close);
  $('secretBackdrop').addEventListener('click',close);
  $('secretLock').addEventListener('click',()=>void lock());
  $('secretNewFolder').addEventListener('click',()=>editor('folder'));
  $('secretAddPage').addEventListener('click',()=>addPage());
  $('secretAddLink').addEventListener('click',()=>editor('link'));
  $('secretOpenSelected').addEventListener('click',()=>void openMany([...selected]));
  $('secretEditor').addEventListener('submit',event=>void saveEditor(event));
  $('secretDiscard').addEventListener('click',()=>{
    $('secretUrl').value='';$('secretEditor').hidden=true;
    $('secretUnlocked').hidden=false;editId=null;editMode=null;
    editorTrueTitle='';pendingNormalId=null;
  });
  $('secretReveal').addEventListener('click',()=>void reveal());
  $('secretGroupName').addEventListener('input',savePreference);
  window.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&!screen.hidden){event.preventDefault();close();}
  });
  api.onState(state=>{
    lastState=state;
    const active=state.tabs.find(tab=>tab.id===state.activeId);
    $('secretPendingScreen').hidden=!active?.secretPending;
    document.documentElement.classList.toggle('secret-active',Boolean(active?.secretTab));
  });
  installStarHold();
  // Expose only explicit UI actions; never expose the decryption key or URL.
  window.minternetSecrets={
    open:()=>void open().catch(e=>tell(e.message)),
    addPage,contextualStar,
    addFromNormal:id=>{
      const item=model?.find(window.minternetBookmarks?.getState(),id);
      if(item?.kind==='link'){
        pendingNormalId=id;addPage(item.url,item.name);
      }
    },
    renderManagerLink(){
      const button=$('secretBookmarksManager');
      if(button)button.hidden=false;
    }
  };
  if(window.__TAURI__)void readStatus().catch(()=>{});
})();