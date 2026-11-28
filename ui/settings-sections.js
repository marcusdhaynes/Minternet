'use strict';
// Keep existing Settings controls and their event handlers in place; move
// DOM nodes into compact, accessible native <details> submenus only after all
// other deferred scripts finish attaching listeners.
(() => {
  const panel=document.getElementById('bookmarkSettings');
  if(!panel)return;
  const get=id=>document.getElementById(id);
  const direct=id=>{
    const el=get(id);
    if(!el)return null;
    return ['LABEL','SECTION','DIV'].includes(el.tagName)?el:el;
  };
  const sections=document.createElement('nav');
  sections.id='settingsSections';sections.className='settings-sections';
  sections.setAttribute('aria-label','Settings Categories');
  // Maintain a stable parent for the sticky header/footer.
  const footer=panel.querySelector('.bookmark-settings-foot');
  if(footer)panel.insertBefore(sections,footer);else panel.append(sections);
  function section(title,parent=sections,open=false){
    const detail=document.createElement('details');
    detail.className='settings-section';detail.open=open;
    const summary=document.createElement('summary');summary.textContent=title;
    const body=document.createElement('div');body.className='settings-section-body';
    detail.append(summary,body);parent.append(detail);
    return body;
  }
  function move(body,id,selector){
    let el=get(id);
    if(!el)return;
    if(selector)el=el.closest(selector)||el;
    body.append(el);
  }
  const general=section('General');
  const dashboard=section('Dashboard',sections);
  move(dashboard,'dashboardSettings');
  move(general,'homePageUrl','.browser-path-setting');
  move(general,'defaultSearchEngine','.search-setting-field');
  move(general,'bookmarkBarToggle','.bookmark-toggle');
  const appearance=section('Appearance');
  move(appearance,'renderCompatibilityMode','.render-compat-settings');
  move(appearance,'groupTabWidth','.tab-layout-settings');
  move(appearance,'bookmarkFolderAppearance');
  move(appearance,'zoomLevel','.zoom-setting-row');
  const tabs=section('Tabs & Performance');
  move(tabs,'tabLimit','.browser-path-setting');
  move(tabs,'autoUnloadMinutes','.auto-unload-setting');
  move(tabs,'navigationHistoryHoldDelay','.auto-unload-setting');
  const downloads=section('Downloads');
  move(downloads,'downloadFolderPath','.browser-path-setting');
  const audio=section('Audio');
  move(audio,'volumeIncrement10','.volume-increments-setting');
  move(audio,'volumeMax','.auto-unload-setting');
  move(audio,'volumeHoldDelay','.auto-unload-setting');
  const miniplayer=section('Mini-player');
  move(miniplayer,'miniplayerSettings');
  const userData=section('User Data');
  move(userData,'identityManagerOpen');
  move(userData,'passwordManagerOpen');
  move(userData,'paymentManagerOpen');
  move(userData,'bookmarkSettingsManage');
  // The auto-lock timer is separate from the native master-password prompt:
  // turning it off permanently disables timeout-based revocation until the
  // user turns it back on. Each encrypted section is independent.
  const autoLockSection=section('Auto-Lock',userData);
  autoLockSection.id='vaultAutoLockPreferences';
  const autoLockIntro=document.createElement('p');
  autoLockIntro.className='lock-preference-explainer';
  autoLockIntro.textContent='Turn off automatic locking separately for each vault. Your choice is saved across restarts. Manual Lock and the master password still work.';
  autoLockSection.append(autoLockIntro);
  const autoLock=window.minternetVaultAutoLock;
  const autoLockToggles=new Map();
  for(const [key,title] of [
    ['identities','Identities'],['logins','Logins'],['payments','Payments']
  ]){
    const row=document.createElement('label');
    row.className='auto-lock-preference-row';
    const caption=document.createElement('span');
    caption.textContent=title+' — Auto-Lock';
    const toggle=document.createElement('input');
    toggle.type='checkbox';
    toggle.id='autoLockEnabled-'+key;
    toggle.checked=autoLock?.getEnabled(key)??true;
    toggle.setAttribute('aria-label','Enable automatic locking for '+title);
    toggle.addEventListener('change',()=>{
      const enabled=autoLock?.setEnabled(key,toggle.checked);
      toggle.checked=enabled===true;
    });
    row.append(caption,toggle);
    autoLockSection.append(row);
    autoLockToggles.set(key,toggle);
  }
  autoLock?.onChange((key,enabled)=>{
    const input=autoLockToggles.get(key);
    if(input)input.checked=enabled;
  });
  const lockSection=section('Password Locks',userData);
  lockSection.id='passwordLockPreferences';
  const lockIntro=document.createElement('p');
  lockIntro.className='lock-preference-explainer';
  lockIntro.textContent='New Windows vaults do not prompt by default. Each manager has its own Password Protection switch. Disabled sections are encrypted with a device-held key; anyone signed into your Windows account may access them.';
  lockSection.append(lockIntro);
  for(const [key,label] of [['identities','Identities'],['logins','Logins'],['payments','Payments'],['bookmarks','Secret Bookmarks']]){
    window.minternetPasswordProtection?.mount(lockSection,key,undefined,label+' — Password Protection');
  }

  const allOff=document.createElement('button');
  allOff.type='button';allOff.className='bookmark-menu-action';
  allOff.textContent='Disable All Master Passwords';
  const allForm=document.createElement('form');
  allForm.hidden=true;allForm.className='vault-password-form';allForm.autocomplete='off';
  const allNote=document.createElement('p');
  allNote.textContent='Existing protected vaults require their current passwords once. Leave a field empty if its device key is already saved or the vault is new. This allows anyone signed into your Windows account to access these sections.';
  const allMaster=document.createElement('input');
  allMaster.type='password';allMaster.autocomplete='off';allMaster.maxLength=1024;
  allMaster.placeholder='Current shared master password';
  allMaster.setAttribute('aria-label','Current shared master password');
  const allSecret=document.createElement('input');
  allSecret.type='password';allSecret.autocomplete='off';allSecret.maxLength=1024;
  allSecret.placeholder='Current Secret Bookmarks password';
  allSecret.setAttribute('aria-label','Current Secret Bookmarks password');
  const allApply=document.createElement('button');
  allApply.type='submit';allApply.textContent='Disable All';
  const allCancel=document.createElement('button');
  allCancel.type='button';allCancel.textContent='Cancel';
  const allStatus=document.createElement('small');allStatus.setAttribute('role','status');
  const clearAllFields=()=>{allMaster.value='';allSecret.value='';};
  allForm.append(allNote,allMaster,allSecret,allApply,allCancel);
  lockSection.append(allOff,allForm,allStatus);
  allOff.addEventListener('click',async()=>{
    try{
      const result=await window.minternet.command('lock-preferences-get');
      if(result?.supported!==true)throw Error(result?.message||'Device unlock requires Windows.');
      allForm.hidden=false;allStatus.textContent='';allMaster.focus();
    }catch(error){allStatus.textContent=String(error?.message||error);}
  });
  allCancel.addEventListener('click',()=>{clearAllFields();allForm.hidden=true;});
  allForm.addEventListener('submit',async event=>{
    event.preventDefault();if(allApply.disabled)return;
    const payload={password:allMaster.value,bookmarksPassword:allSecret.value};
    clearAllFields();allApply.disabled=true;allCancel.disabled=true;allOff.disabled=true;
    try{
      const result=await window.minternet.command('lock-preferences-disable-all',payload);
      if(!result?.ok||Object.values(result.passwordRequired||{}).some(Boolean))
        throw Error(result?.message||'Could not disable all passwords.');
      window.dispatchEvent(new CustomEvent('minternet:password-policy',{detail:result.passwordRequired}));
      allForm.hidden=true;allStatus.textContent='All four master password prompts are disabled.';
    }catch(error){allStatus.textContent=String(error?.message||error);}
    finally{payload.password='';payload.bookmarksPassword='';allApply.disabled=false;allCancel.disabled=false;allOff.disabled=false;}
  });

  const secrets=section('Secrets',userData);
  const openSecret=document.createElement('button');
  openSecret.type='button';openSecret.id='settingsSecretsOpen';
  openSecret.className='bookmark-menu-action';
  openSecret.textContent='◈ Secret Bookmarks ›';
  openSecret.addEventListener('click',()=>{
    // Use the same encrypted native vault screen as the bookmark manager.
    window.minternetBookmarks?.closeOverlay?.();
    window.minternetSecrets?.open?.();
  });
  secrets.append(openSecret);
  move(secrets,'secretGroupNameSettings','.auto-unload-setting');
  const imports=section('Import & Export',userData);
  move(imports,'importBookmarksFile','.bookmark-import-settings');
  move(imports,'importPasswords','.credential-import-settings');
  const privacy=section('Privacy & History');
  move(privacy,'privateLoginSettings');
  move(privacy,'historyManagerOpen');
  const mediaDevices=section('Media Devices',privacy);
  const mediaOpen=document.createElement('button');
  mediaOpen.id='settingsMediaDevicesOpen';mediaOpen.type='button';
  mediaOpen.className='bookmark-menu-action';
  mediaOpen.textContent='Manage Speaker, Microphone, Webcam & Site Permissions';
  mediaOpen.addEventListener('click',()=>{
    window.minternetMediaDevices?.open?.();
  });
  mediaDevices.append(mediaOpen);
  // Extension-owned settings are isolated under one expandable category.
  // No browser-specific extension receives a permanent top-level Settings row.
  const extensionSettings=section('Extensions');
  extensionSettings.id='extensionSettingsList';
  const extensionIntro=document.createElement('p');
  extensionIntro.className='extension-settings-intro';
  extensionIntro.textContent='Installed add-ons and their settings. Manage each add-on here; work with your media libraries in Marmaladeum.';
  extensionSettings.append(extensionIntro);
  const extensionCollection=document.createElement('div');
  extensionCollection.id='extensionSettingsCollection';
  extensionCollection.className='extension-settings-collection';
  extensionSettings.append(extensionCollection);
  const pluginRenderers=new Map();
  const addExtensionRenderer=(key,render)=>{
    if(typeof render==='function')pluginRenderers.set(key,render);
    void refreshExtensionSettings();
  };
  function extensionDetails(label,className,parent){
    const details=document.createElement('details');
    details.className='extension-settings-entry '+className;
    const summary=document.createElement('summary');
    summary.textContent=label;
    const body=document.createElement('div');
    body.className='extension-settings-entry-body';
    details.append(summary,body);
    parent.append(details);
    return {details,body};
  }
  function extensionNote(parent,text){
    const p=document.createElement('p');p.className='extension-settings-note';
    p.textContent=text;parent.append(p);return p;
  }
  function extensionButton(parent,text,fn){
    const button=document.createElement('button');
    button.type='button';button.className='extension-settings-button';
    button.textContent=text;button.addEventListener('click',()=>void fn());
    parent.append(button);return button;
  }
  let extensionRefreshSequence=0;
  async function refreshExtensionSettings(){
    const seq=++extensionRefreshSequence;
    const previousOpen=new Set([...extensionCollection.querySelectorAll('details[open]')]
      .map(el=>el.dataset.extensionKey||''));
    try{
      const result=await window.minternet?.command?.('extensions-list');
      if(seq!==extensionRefreshSequence)return;
      if(result?.message)throw Error(result.message);
      extensionCollection.replaceChildren();
      const all=(result?.extensions||[]).filter(x=>x&&x.name);
      if(!all.length){
        extensionNote(extensionCollection,'No extensions installed. Use the Extensions button in the browser toolbar to import one.');
        return;
      }
      const groups=new Map();
      for(const ext of all){
        const group=ext.nativeMediaServer?'Marmaladeum':
          (String(ext.settingsGroup||ext.name).trim()||'Other Extensions');
        if(!groups.has(group))groups.set(group,[]);
        groups.get(group).push(ext);
      }
      for(const [group,entries] of groups){
        const holder=extensionDetails(group,'extension-settings-group',extensionCollection);
        holder.details.dataset.extensionKey=group;
        holder.details.open=previousOpen.has(group);
        for(const ext of entries){
          const label=ext.nativeMediaServer?'Media Library':(ext.settingsSection||ext.name);
          const inner=extensionDetails(label,'extension-settings-subgroup',holder.body);
          inner.details.dataset.extensionKey=group+'/'+ext.id;
          inner.details.open=previousOpen.has(group+'/'+ext.id);
          const meta=document.createElement('div');
          meta.className='extension-settings-meta';
          const stateTag=document.createElement('span');
          stateTag.textContent=ext.enabled?'Enabled':'Disabled';
          stateTag.dataset.state=ext.enabled?'enabled':'disabled';
          const version=document.createElement('span');
          version.textContent='Version '+(ext.version||'—');
          meta.append(stateTag,version);
          inner.body.append(meta);
          if(ext.nativeMediaServer){
            const heading=document.createElement('strong');
            heading.className='extension-settings-subtitle';
            heading.textContent='Persistent Local Library';
            inner.body.append(heading);
            extensionNote(inner.body,
              'Marmaladeum controls libraries, folders, movies, and TV shows. This extension retains the folders and catalog on your computer, independently of browser folder permissions.');
            const metric=document.createElement('div');
            metric.className='extension-settings-metric';
            metric.textContent=ext.enabled?'Checking the saved media catalog…':'Enable this extension and restart Minternet to connect.';
            inner.body.append(metric);
            const summary=document.createElement('div');
            summary.className='extension-settings-library-list';
            inner.body.append(summary);
            if(ext.enabled){
              window.minternet.command('media-library-get').then(catalog=>{
                if(catalog?.message)throw Error(catalog.message);
                const videos=catalog?.items?.length||0;
                const folders=catalog?.folders?.length||0;
                const libraries=catalog?.collections||[];
                metric.replaceChildren();
                for(const [label,count] of [['Libraries',libraries.length],
                  ['Videos',videos],['Folders',folders]]){
                  const cell=document.createElement('div');
                  const number=document.createElement('strong');
                  number.textContent=String(count);
                  const caption=document.createElement('small');
                  caption.textContent=label;
                  cell.append(number,caption);metric.append(cell);
                }
                summary.replaceChildren();
                const head=document.createElement('strong');
                head.textContent='Saved Libraries';summary.append(head);
                if(!libraries.length){
                  extensionNote(summary,'No libraries yet. Open Marmaladeum to create one and choose a media folder.');
                }else{
                  for(const lib of libraries.slice(0,20)){
                    const row=document.createElement('div');row.className='extension-settings-library-row';
                    const title=document.createElement('span');title.textContent=lib.name;
                    const folderIds=new Set(lib.folderIds||[]);
                    const count=(catalog.items||[]).filter(item=>folderIds.has(item.folderId)).length;
                    const label=document.createElement('small');
                    label.textContent=count+' videos · '+folderIds.size+' folders';
                    row.append(title,label);summary.append(row);
                  }
                }
              }).catch(e=>{
                metric.textContent='Native media service unavailable: '+String(e?.message||e);
                summary.replaceChildren();
              });
            }
            const actions=document.createElement('div');
            actions.className='extension-settings-actions';
            extensionButton(actions,'Open Marmaladeum',async()=>{
              const r=await window.minternet.command('new-url','https://marcusdhaynes.github.io/MarmaladePlayer/');
              if(r?.message)metric.textContent='Could not open Marmaladeum: '+r.message;
            });
            extensionButton(actions,'Refresh Status',async()=>{
              await refreshExtensionSettings();
            });
            inner.body.append(actions);
          }else if(pluginRenderers.has(ext.name)){
            pluginRenderers.get(ext.name)(inner.body,ext);
          }else extensionNote(inner.body,
            'No additional settings provided. Enable, disable, or remove this extension from the toolbar Extensions manager.');
        }
      }
    }catch(e){
      if(seq!==extensionRefreshSequence)return;
      extensionCollection.replaceChildren();
      extensionNote(extensionCollection,'Could not load extensions: '+String(e?.message||e));
    }
  }
  window.minternetExtensionSettings={register:addExtensionRenderer,refresh:refreshExtensionSettings};
  extensionSettings.closest('details')?.addEventListener('toggle',event=>{
    if(event.target.open)void refreshExtensionSettings();
  });
  window.addEventListener('focus',()=>{
    if(extensionSettings.closest('details')?.open)void refreshExtensionSettings();
  });
  void refreshExtensionSettings();
  const accounts=section('Accounts & Sync');
  move(accounts,'googleSettings');
  // The updater mounts once into this existing node. Keep it within the
  // same collapsed accordion styling as every other Settings category.
  const updates=section('Updates');
  move(updates,'updatesSection');
  move(general,'browserPreferencesStatus');
  // All top-level categories start collapsed; each retains expansion state
  // while Settings remains mounted during this browser session.
  // All moving targets retain their original IDs and listener objects.
})();
