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
  // Every section has an independently configurable prompt. Disabled prompts
  // use Windows Credential Manager (bound to the signed-in OS user) rather
  // than plaintext profile settings. Encrypted vault data stays encrypted.
  const lockSection=section('Password Locks',userData);
  lockSection.id='passwordLockPreferences';
  const lockIntro=document.createElement('p');
  lockIntro.className='lock-preference-explainer';
  lockIntro.textContent='Choose which areas ask for their master password. Turning a prompt off requires entering its current password once; afterward Windows Credential Manager can unlock it for your Windows account. Bookmarks controls Secret Bookmarks only; ordinary Bookmarks are never password-locked.';
  lockSection.append(lockIntro);
  const lockOptions=[
    ['identities','Identities'],['logins','Logins'],
    ['payments','Payments'],['bookmarks','Bookmarks']
  ];
  const lockRows=new Map();
  const lockApi=(name,payload)=>window.minternet?.command(name,payload);
  let preferencesReady=false;
  const lockMessage=document.createElement('p');
  lockMessage.id='passwordLockPreferencesStatus';lockMessage.setAttribute('role','status');
  const lockStatus=message=>{lockMessage.textContent=String(message||'');};
  lockSection.append(lockMessage);
  for(const [key,labelText] of lockOptions){
    const row=document.createElement('div');row.className='lock-preference-row';
    const label=document.createElement('label');label.className='lock-preference-label';
    const toggle=document.createElement('input');toggle.type='checkbox';
    toggle.id='lockPreference-'+key;toggle.checked=true;toggle.disabled=true;
    label.append(toggle,document.createTextNode(labelText+' — Require Password'));
    const approval=document.createElement('form');
    approval.className='lock-preference-approval';approval.hidden=true;
    const master=document.createElement('input');master.type='password';
    master.autocomplete='off';master.spellcheck=false;master.maxLength=1024;
    master.placeholder=key==='bookmarks'
      ?'Current Secret Bookmarks password':'Current vault master password';
    master.setAttribute('aria-label','Current '+labelText+' password');
    const allow=document.createElement('button');allow.type='submit';
    allow.textContent='Disable Password Prompt';
    const cancel=document.createElement('button');cancel.type='button';
    cancel.textContent='Cancel';
    cancel.addEventListener('click',()=>{
      master.value='';approval.hidden=true;toggle.checked=true;
    });
    approval.append(master,allow,cancel);
    row.append(label,approval);lockSection.append(row);
    lockRows.set(key,{toggle,master,approval,allow});
    toggle.addEventListener('change',async()=>{
      if(!preferencesReady)return;
      if(toggle.checked){
        toggle.disabled=true;
        try{
          const result=await lockApi('lock-preferences-set',{section:key,locked:true});
          if(result?.message)throw Error(result.message);
          approval.hidden=true;master.value='';
          lockStatus(labelText+' now requires its master password.');
        }catch(error){
          toggle.checked=false;
          lockStatus(String(error?.message||error));
        }finally{toggle.disabled=false;}
      }else{
        // Re-enable the unchecked display only after secure authorization.
        toggle.checked=true;
        approval.hidden=false;
        lockStatus('Enter the existing '+labelText+' password once to disable its prompt.');
        master.focus();
      }
    });
    approval.addEventListener('submit',async event=>{
      event.preventDefault();
      const password=master.value;master.value='';
      if(!password)return lockStatus('Enter the existing master password.');
      allow.disabled=true;
      try{
        const result=await lockApi('lock-preferences-set',
          {section:key,locked:false,password});
        if(result?.message)throw Error(result.message);
        toggle.checked=false;approval.hidden=true;
        lockStatus(labelText+' will unlock without prompting when signed in to this Windows account.');
      }catch(error){
        lockStatus(String(error?.message||error));
      }finally{allow.disabled=false;}
    });
  }
  async function loadLockPreferences(){
    if(!window.__TAURI__) {
      lockStatus('Password lock preferences require the Windows desktop application.');
      return;
    }
    try{
      const result=await lockApi('lock-preferences-get');
      if(!result?.supported)throw Error('Windows Credential Manager is not available on this platform.');
      preferencesReady=true;
      for(const [key,{toggle}] of lockRows){
        toggle.checked=result.passwordRequired?.[key]!==false;
        toggle.disabled=false;
      }
      lockStatus('');
    }catch(error){lockStatus(String(error?.message||error));}
  }
  void loadLockPreferences();

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
