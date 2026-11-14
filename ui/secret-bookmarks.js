'use strict';
// Secret Bookmarks never use localStorage for addresses, content, or
// ciphertext. Only the chosen tab-group display name is a public preference.
(() => {
  const api=window.minternet;
  if(!api)return;
  const $=id=>document.getElementById(id);
  const model=window.MinternetBookmarks;
  const screen=$('secretScreen'),tree=$('secretTree'),lockedForm=$('secretAuthForm');
  if(!screen||!tree||!lockedForm)return;
  const GROUP_PREF='minternet.secret-group-name.v1';
  const GROUP_ID_PREF='minternet.secret-tabs-group-id.v1';
  const CLOSE_LOCK_PREF='minternet.secret-close-lock.v1';
  // Public, user-chosen visible labels only; true titles and secret URLs stay native.
  const secretTabNames=new Map();
  window.minternetSecretTabNames=secretTabNames;
  let status={exists:false,unlocked:false,items:[]};
  let selected=new Set(),folder=null,pendingAdd=null,pendingDrop=null,pendingReveal=null,entryTask=null;
  let editMode=null,editId=null,editorTrueTitle='',pendingNormalId=null,starMenu=null,autoLockTimer=null,suppressStarClick=false;
  let lockPromise=null,closeDeadline=0;
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
    if(open){
      const shouldFocus=!status.unlocked&&!$('secretAuthForm').hidden;
      if(shouldFocus)$('secretCode').focus();
    }
  }
  function eraseUnsavedSecretEditor(){
    // The editor is the only normal chrome form allowed to hold a secret URL
    // during creation; clear it whenever the editor is hidden.
    for(const id of ['secretUrl'])if($(id))$(id).value='';
    editorTrueTitle='';
    previewRevision++;
  }
  function clearPasswordForms(){
    for(const id of ['secretOldPassword','secretNewPassword','secretNewPasswordConfirm',
      'secretResetPhrase']){if($(id))$(id).value='';}
    if($('secretResetAcknowledged'))$('secretResetAcknowledged').checked=false;
    $('secretPasswordChangeForm').hidden=true;
    $('secretPasswordResetForm').hidden=true;
  }
  function showPasswordForm(which){
    clearPasswordForms();
    const form=$(which==='change'?'secretPasswordChangeForm':'secretPasswordResetForm');
    if(which==='change'&&!status.unlocked){
      tell('Unlock the Secret Folder before changing its password.');
      return;
    }
    if(which==='reset'&&!status.exists){
      tell('No Secret Bookmarks vault exists to reset.');return;
    }
    $('secretUnlocked').hidden=true;
    $('secretAuthForm').hidden=true;
    $('secretAccessForm').hidden=true;
    $('secretEditor').hidden=true;
    eraseUnsavedSecretEditor();
    form.hidden=false;
    form.querySelector('input')?.focus();
  }
  function finishPasswordForm(){
    clearPasswordForms();
    $('secretAuthForm').hidden=status.unlocked;
    $('secretUnlocked').hidden=!status.unlocked;
    if(status.unlocked)render();
    else $('secretCode').focus();
  }
  async function changeFolderPassword(event){
    event.preventDefault();
    let current=$('secretOldPassword').value;
    let next=$('secretNewPassword').value;
    const repeated=$('secretNewPasswordConfirm').value;
    const length=[...next].length;
    if(!current||length<1||length>16||next!==repeated||next===current){
      tell('Enter the current password and matching new 1–16-character password, different from the old one.');
      return;
    }
    const submit=$('secretPasswordChangeForm').querySelector('button[type="submit"]');
    submit.disabled=true;
    try{
      const result=await request('secret-change-password',{current,next});
      updateState(result);
      finishPasswordForm();
      armLock();
      tell('Secret Folder password changed. Existing bookmarks were securely re-encrypted.');
    }catch(error){tell(error.message);}
    finally{
      current='';next='';
      $('secretOldPassword').value='';
      $('secretNewPassword').value='';
      $('secretNewPasswordConfirm').value='';
      submit.disabled=false;
    }
  }
  async function resetSecretVault(event){
    event.preventDefault();
    if($('secretResetPhrase').value!=='DELETE SECRET BOOKMARKS'||
       !$('secretResetAcknowledged').checked){
      tell('Type DELETE SECRET BOOKMARKS and explicitly acknowledge the permanent deletion.');return;
    }
    if(!window.confirm('FINAL CONFIRMATION: Permanently delete EVERY Secret Bookmark, folder, and encrypted entry? This cannot be undone inside Minternet.')){
      return;
    }
    const submit=$('secretResetConfirm');
    submit.disabled=true;
    try{
      // The OS may retain snapshots, SSD remapped sectors or backups. This
      // operation removes Minternet's live keys and its accessible vault file.
      const result=await request('secret-reset',{
        phrase:'DELETE SECRET BOOKMARKS',acknowledged:true,confirm:'PERMANENTLY DELETE'
      });
      if(result?.exists!==false)throw new Error('Vault deletion did not complete.');
      selected.clear();folder=null;
      pendingAdd=null;pendingDrop=null;pendingReveal=null;
      $('secretCode').value='';$('secretAccessCode').value='';
      updateState(result);
      finishPasswordForm();
      tell('Secret Bookmarks vault deleted. Create a NEW folder password to start again. Regular bookmarks and the password manager were not changed.');
    }catch(error){tell(error.message);}
    finally{submit.disabled=false;}
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
  let previewRevision=0,previewTimer=null;
  function refreshPreview(){
    // Native uses the real authenticated encryption algorithm and the exact
    // folder-key/name-binding mode selected in the editor.
    const revision=++previewRevision;
    clearTimeout(previewTimer);
    $('secretScrambledName').textContent='Encrypting…';
    $('secretScrambledLink').textContent='Encrypting…';
    if(!window.__TAURI__||!status.unlocked){
      $('secretScrambledName').textContent='Unlock Secret Bookmarks to preview';
      $('secretScrambledLink').textContent='—';return;
    }
    previewTimer=setTimeout(async()=>{
      try{
        const preview=await request('secret-preview',{
          title:editorTrueTitle||$('secretVisibleName').value,
          visibleName:$('secretVisibleName').value.trim(),
          bindVisibleName:$('secretBindVisibleName').checked,
          url:editMode==='folder'?'':$('secretUrl').value
        });
        if(revision!==previewRevision||$('secretEditor').hidden)return;
        $('secretScrambledName').textContent=preview.scrambledName||'—';
        $('secretScrambledLink').textContent=preview.scrambledLink||'—';
      }catch{
        if(revision!==previewRevision||$('secretEditor').hidden)return;
        $('secretScrambledName').textContent='Preview unavailable';
        $('secretScrambledLink').textContent='Enter a valid website address';
      }
    },180);
  }
  function updateState(next){
    if(next?.message)throw new Error(next.message);
    if(next?.items){
      status.items=next.items;
      // Mutations return updated items but not always a legacy count.
      if(typeof next.legacyCount!=='number')
        status.legacyCount=next.items.filter(item=>item.legacyCodeRequired).length;
    }
    if(typeof next?.exists==='boolean')status.exists=next.exists;
    if(typeof next?.unlocked==='boolean')status.unlocked=next.unlocked;
    if(typeof next?.legacyCount==='number')status.legacyCount=next.legacyCount;
    if(!status.unlocked){
      status.items=[];
      $('secretAccessForm').hidden=true;
      entryTask=null;
    }
    $('secretAuthForm').hidden=status.unlocked;
    $('secretUnlocked').hidden=!status.unlocked;
    $('secretLock').hidden=!status.unlocked;
    $('secretAuthButton').textContent=status.exists?'Unlock Secret Folder':'Create Secret Folder Password';
    $('secretChangePassword').hidden=!status.unlocked;
    $('secretResetStart').hidden=!status.exists;
    $('secretMigrateLegacy').hidden=!status.unlocked||!status.legacyCount;
    if(status.unlocked){
      if(folder&&!status.items.some(item=>item.id===folder&&item.kind==='folder'))folder=null;
      render();
    }
  }
  async function readStatus(){updateState(await request('secret-status'));}
  async function open(){
    if(!window.__TAURI__){tell('Secret Bookmarks requires the installed Minternet application.');return;}
    // Reopening before the chosen close delay cancels the pending lock.
    clearTimeout(autoLockTimer);autoLockTimer=null;closeDeadline=0;
    // Never show stale unlocked metadata while the previous close is still
    // clearing the native encryption key.
    if(lockPromise)await lockPromise;
    await readStatus();
    clearPasswordForms();
    // The secret dialog takes over the trusted chrome; leave no ordinary
    // bookmark manager behind it that could receive dropped secret content.
    window.minternetBookmarks?.closeOverlay();
    overlay(true);
    if(status.unlocked){
      render();
      if(status.legacyCount>0){
        tell(status.legacyCount+' older bookmark(s) need a one-time upgrade using their former codes. New bookmarks never need entry codes.');
      }
    }else{
      $('secretAuthButton').textContent=status.exists?'Unlock Secret Folder':'Create Secret Folder Password';
      $('secretCode').value='';
      tell(status.exists?
        'Unlock the Secret Folder to access all modern encrypted bookmarks with this password.':
        'Create one Secret Folder password. Individual bookmark codes are not required.');
    }
  }
  function closeLockMillis(){
    const amount=Math.max(0,Math.min(999999,Math.trunc(Number($('secretAutoLockAmount').value)||0)));
    const unit=['seconds','minutes','hours'].includes($('secretAutoLockUnit').value)
      ?$('secretAutoLockUnit').value:'seconds';
    return amount*(unit==='hours'?3600000:unit==='minutes'?60000:1000);
  }
  function saveCloseLockPreference(){
    const amount=Math.max(0,Math.min(999999,Math.trunc(Number($('secretAutoLockAmount').value)||0)));
    const unit=['seconds','minutes','hours'].includes($('secretAutoLockUnit').value)
      ?$('secretAutoLockUnit').value:'seconds';
    $('secretAutoLockAmount').value=String(amount);
    try{localStorage.setItem(CLOSE_LOCK_PREF,JSON.stringify({amount,unit}));}catch{}
  }
  try{
    const saved=JSON.parse(localStorage.getItem(CLOSE_LOCK_PREF)||'null');
    $('secretAutoLockAmount').value=String(Math.max(0,Math.min(999999,Math.trunc(Number(saved?.amount)||0))));
    $('secretAutoLockUnit').value=['seconds','minutes','hours'].includes(saved?.unit)?saved.unit:'seconds';
  }catch{
    $('secretAutoLockAmount').value='0';$('secretAutoLockUnit').value='seconds';
  }
  // The timer applies AFTER the Secret Bookmarks window is closed, not while
  // the user is actively editing or viewing it. Zero is the secure default.
  function scheduleCloseLock(){
    clearTimeout(autoLockTimer);autoLockTimer=null;
    if(!status.unlocked)return;
    const ms=closeLockMillis();
    if(ms===0){void lock(true);return;}
    closeDeadline=Date.now()+ms;
    const step=()=>{
      if(!screen.hidden||!status.unlocked)return;
      const remaining=closeDeadline-Date.now();
      if(remaining<=0){void lock(true);return;}
      autoLockTimer=setTimeout(step,Math.min(remaining,2147483647));
    };
    step();
  }
  function close(){
    if(screen.hidden)return;
    clearPasswordForms();
    eraseUnsavedSecretEditor();
    overlay(false);
    $('secretEditor').hidden=true;
    $('secretCode').value='';
    pendingAdd=null;pendingDrop=null;pendingNormalId=null;editorTrueTitle='';
    entryTask=null;$('secretAccessCode').value='';$('secretAccessForm').hidden=true;
    // The native key is erased immediately at the default 0 seconds.
    scheduleCloseLock();
  }
  async function lock(quiet=false){
    if(lockPromise)return lockPromise;
    clearTimeout(autoLockTimer);autoLockTimer=null;closeDeadline=0;
    const operation=(async()=>{
      clearPasswordForms();
      eraseUnsavedSecretEditor();
      await request('secret-lock');
      updateState({unlocked:false,items:[]});
      $('secretCode').value='';
      $('secretEditor').hidden=true;
      $('secretAccessForm').hidden=true;
      $('secretAccessCode').value='';
      entryTask=null;selected.clear();
      if(!quiet)tell('Secret Bookmarks locked. The encryption key was cleared from Minternet memory.');
    })();
    lockPromise=operation;
    try{await operation;}
    catch(error){tell(error.message);}
    finally{lockPromise=null;}
  }
  function armLock(){
    // Activity while the panel is open must not unexpectedly lock it.
    if(screen.hidden&&status.unlocked)scheduleCloseLock();
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
        $('secretOpenSelected').disabled=!selected.size;
      });
      row.append(box);
    }else{
      const folderIcon=document.createElement('span');
      folderIcon.textContent='📁';folderIcon.className='secret-folder-icon';
      row.append(folderIcon);
    }
    const title=document.createElement('button');title.type='button';title.className='secret-row-title';
    title.textContent=item.visibleName || (kind?'Secret Folder':'◈ Untitled Secret');
    title.title=kind?'Open Secret Folder':item.legacyCodeRequired?
      'Upgrade this older bookmark using its former code':'Open this secret bookmark in an unloaded background tab';
    title.addEventListener('click',()=>{
      if(kind){folder=item.id;render();}
      else void openMany([item.id]);
    });
    row.append(title);
    const edit=document.createElement('button');edit.type='button';edit.className='secret-row-action';
    edit.textContent='✎';edit.title='Edit visible label and encryption setting';
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
  function promptEntry(task){
    // The only remaining entry-code input is for migration of previously
    // created bookmarks. New bookmarks never ask for independent codes.
    if(!status.unlocked){tell('Unlock the Secret Folder first.');return;}
    entryTask=task;
    $('secretEditor').hidden=true;
    $('secretUnlocked').hidden=true;
    $('secretAccessForm').hidden=false;
    $('secretAccessCode').value='';
    $('secretAccessTitle').textContent='Upgrade Older Bookmarks';
    $('secretAccessMessage').textContent=
      'Only bookmarks created by older Minternet versions used separate entry codes. Enter the previous code once to re-encrypt matching bookmarks using your Secret Folder password and Visible Name. Repeat for other old codes if needed.';
    $('secretAccessSubmit').textContent='Upgrade Matching Bookmarks';
    $('secretAccessCode').focus();
  }
  function cancelEntry(){
    entryTask=null;$('secretAccessCode').value='';
    $('secretAccessForm').hidden=true;
    if(status.unlocked){$('secretUnlocked').hidden=false;render();}
  }
  async function finishFolderUnlock(){
    if(pendingAdd){
      const item=pendingAdd;pendingAdd=null;
      editor(item.kind,item.url,item.title);
    }else if(pendingDrop){
      const task=pendingDrop;pendingDrop=null;
      if(task.openIds)await openMany(task.openIds);
      else await saveDropped(task);
    }else if(pendingReveal!=null){
      const id=pendingReveal;pendingReveal=null;
      try{
        await request('secret-authorize-tab',{tabId:id});
        await request('secret-reveal',{tabId:id});
      }catch(error){tell(error.message);}
    }
  }
  async function authorizeEntries(event){
    event.preventDefault();
    const task=entryTask;
    if(!task||task.kind!=='migrate')return;
    let code=$('secretAccessCode').value;
    if([...code].length<1||[...code].length>16){
      tell('Previous bookmark code must contain 1–16 characters.');return;
    }
    $('secretAccessSubmit').disabled=true;
    try{
      const result=await request('secret-migrate',{code});
      updateState(result);
      cancelEntry();
      tell('Upgraded '+result.migrated+' older bookmark(s). '+(status.legacyCount||0)+' still need their former code.');
      if(task.openIds)await openMany(task.openIds);
    }catch(error){tell(error.message);}
    finally{
      code='';$('secretAccessCode').value='';
      $('secretAccessSubmit').disabled=false;
    }
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
    $('secretBindVisibleNameLabel').hidden=kind==='folder';
    const existing=id?status.items.find(x=>x.id===id):null;
    $('secretBindVisibleName').checked=existing?.bindVisibleName??true;
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
  // Native tab creation sends a state event asynchronously. The tab-group
  // controller must see those tab IDs before assigning them; otherwise bulk
  // opening could create a group with no children on slower computers.
  function waitForGroupTabs(group,ids){
    if(ids.every(id=>group.getLatest()?.tabs?.some(tab=>tab.id===id)))return Promise.resolve(true);
    return new Promise(resolve=>{
      let finished=false,off=()=>{};
      const finish=ok=>{
        if(finished)return;
        finished=true;clearTimeout(timeout);off();resolve(ok);
      };
      const check=()=>{
        if(ids.every(id=>group.getLatest()?.tabs?.some(tab=>tab.id===id)))finish(true);
      };
      const timeout=setTimeout(()=>finish(false),4500);
      off=api.onState(()=>setTimeout(check,0));
      setTimeout(check,0);
    });
  }
  async function openMany(ids){
    if(!status.unlocked){
      pendingDrop={openIds:ids};
      try{await open();}catch(e){tell(e.message);}
      return;
    }
    const unique=[...new Set(ids)];
    if(!unique.length)return tell('Select a Secret Bookmark.');
    if(unique.some(id=>status.items.find(item=>item.id===id)?.legacyCodeRequired)){
      promptEntry({kind:'migrate',openIds:unique});return;
    }
    try{await openAuthorized(unique);}catch(error){tell(error.message);}
  }
  async function openAuthorized(ids){
    const result=await request('secret-open',{ids});
    const tabIds=result.tabIds||[];
    // Visible aliases, not true page titles/addresses, appear beneath the
    // dedicated Secret Group. Keep this mapping in RAM, never in synced tabs.
    for(let i=0;i<tabIds.length;i++){
      const item=status.items.find(entry=>entry.id===ids[i]);
      secretTabNames.set(tabIds[i],item?.visibleName||'Secret Tab');
    }
    let grouped=false;
    const groups=window.minternetGroups;
    if(tabIds.length&&groups&&await waitForGroupTabs(groups,tabIds)){
      const groupName=savePreference();
      let groupId=null;
      try{groupId=localStorage.getItem(GROUP_ID_PREF);}catch{}
      let group=groupId?groups.get(groupId):null;
      if(!group){
        group=groups.createGroup(groupName,'violet');
        if(group)try{localStorage.setItem(GROUP_ID_PREF,group.id);}catch{}
      }else if(group.name!==groupName||group.collapsed||!group.visible){
        groups.updateGroup(group.id,{name:groupName,visible:true,collapsed:false});
      }
      if(group){
        grouped=true;
        for(const id of tabIds)if(!groups.assign(id,group.id))grouped=false;
      }
    }
    window.minternetRenderTabs?.();
    selected.clear();render();
    tell(tabIds.length+' Secret Bookmark'+(tabIds.length===1?'':'s')+
      ' opened unloaded inside the '+savePreference()+' group. Press the eye to load.'+
      (!grouped?' Group assignment could not be verified.':''));
    armLock();
  }
  async function reveal(){
    const tab=lastState?.tabs.find(x=>x.id===lastState.activeId);
    if(!tab?.secretPending)return;
    try{
      await request('secret-reveal',{tabId:tab.id});
      armLock();
    }catch(error){
      if(/authorization expired|unlock|locked/i.test(error.message)){
        if(!status.unlocked){
          pendingReveal=tab.id;
          void open().catch(e=>tell(e.message));
        }else{
          try{
            await request('secret-authorize-tab',{tabId:tab.id});
            await request('secret-reveal',{tabId:tab.id});
            armLock();
          }catch(e){tell(e.message);}
        }
      }else tell(error.message);
    }
  }
  async function saveEditor(event){
    event.preventDefault();
    if(!status.unlocked)return;
    const visibleName=$('secretVisibleName').value.trim();
    const bindVisibleName=$('secretBindVisibleName').checked;
    try{
      const result=editId
        ?await request('secret-edit',{id:editId,visibleName,bindVisibleName})
        :await request('secret-put',{kind:editMode,parent:folder,
          visibleName,url:editMode==='link'?$('secretUrl').value:'',
          title:editorTrueTitle,bindVisibleName});
      updateState(result);
      const savedUrl=editMode==='link'&&!editId?$('secretUrl').value:'';
      // Best-effort removal from regular history after encrypted saving.
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
      tell('Secret Bookmark saved with '+(bindVisibleName?'folder password and Visible Name binding.':'folder password encryption.'));
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
      await finishFolderUnlock();
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
          visibleName:node.name||'',url:node.url,title:node.name||'',
          bindVisibleName:true});
        saved++;
        void api.command('history-remove',node.url);
        if(node.sourceId)window.minternetBookmarks?.deleteBookmark(node.sourceId,true);
      }
    }
    try{
      for(const node of nodes.slice(0,100))await go(node,parent,0);
      updateState(await request('secret-status'));
      tell('Encrypted '+saved+' dropped item'+(saved===1?'':'s')+' using the Secret Folder password.');
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
    let timer=null;
    const start=event=>{
      if(event.button!==0 || star.disabled)return;
      clearTimeout(timer);
      timer=setTimeout(()=>{
        timer=null;suppressStarClick=true;
        // Save immediately on the hold threshold: no extra animation-end
        // wait, flashing repaint, or artificial one-second timeout.
        addPage();
      },420);
    };
    const stop=()=>{clearTimeout(timer);timer=null;};
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
  $('secretChangePassword').addEventListener('click',()=>showPasswordForm('change'));
  $('secretResetStart').addEventListener('click',()=>showPasswordForm('reset'));
  $('secretPasswordChangeForm').addEventListener('submit',event=>void changeFolderPassword(event));
  $('secretPasswordResetForm').addEventListener('submit',event=>void resetSecretVault(event));
  $('secretPasswordChangeCancel').addEventListener('click',finishPasswordForm);
  $('secretPasswordResetCancel').addEventListener('click',finishPasswordForm);
  $('secretAuthForm').addEventListener('submit',event=>void authenticate(event));
  $('secretAccessForm').addEventListener('submit',event=>void authorizeEntries(event));
  $('secretAccessCancel').addEventListener('click',cancelEntry);
  $('secretClose').addEventListener('click',close);
  $('secretBackdrop').addEventListener('click',close);
  document.addEventListener('pointerdown',event=>{
    if(screen.hidden)return;
    if(event.target.closest?.('#secretScreen .secret-panel'))return;
    // The secret panel can use several nested layouts; keep all interactions
    // inside the visible dialog active, but dismiss on outside pointer-down.
    const dialog=screen.querySelector('.secret-panel,.secret-bookmarks-panel,aside,[role="dialog"]');
    if(dialog?.contains(event.target))return;
    close();
  },true);
  window.addEventListener('blur',()=>{if(!screen.hidden)close();});
  $('secretLock').addEventListener('click',()=>void lock());
  $('secretAutoLockAmount').addEventListener('change',saveCloseLockPreference);
  $('secretAutoLockUnit').addEventListener('change',saveCloseLockPreference);
  $('secretNewFolder').addEventListener('click',()=>editor('folder'));
  $('secretAddPage').addEventListener('click',()=>addPage());
  $('secretAddLink').addEventListener('click',()=>editor('link'));
  $('secretOpenSelected').addEventListener('click',()=>void openMany([...selected]));
  $('secretMigrateLegacy').addEventListener('click',()=>promptEntry({kind:'migrate'}));
  $('secretEditor').addEventListener('submit',event=>void saveEditor(event));
  $('secretVisibleName').addEventListener('input',refreshPreview);
  $('secretUrl').addEventListener('input',refreshPreview);
  $('secretBindVisibleName').addEventListener('change',refreshPreview);
  $('secretDiscard').addEventListener('click',()=>{
    $('secretUrl').value='';
    $('secretEditor').hidden=true;
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
    const current=new Set(state.tabs.map(tab=>tab.id));
    for(const id of secretTabNames.keys())if(!current.has(id))secretTabNames.delete(id);
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