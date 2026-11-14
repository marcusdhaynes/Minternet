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
  move(imports,'importPasswords','.credential-import-settings');
  const privacy=section('Privacy & History');
  move(privacy,'shieldSettings');
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
