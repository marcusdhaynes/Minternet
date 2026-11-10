'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const source=name=>fs.readFileSync(path.join(root,name),'utf8');

test('Privacy Shield toolbar, settings and trusted JS controller stay connected',()=>{
  const html=source('ui/index.html');
  const ui=source('ui/privacy-shield-ui.js');
  const section=source('ui/settings-sections.js');
  const ids=[
    'shieldButton','shieldSettings','shieldEnabled','shieldMode','shieldAds',
    'shieldTrackers','shieldVideoAds','shieldAnnoyances',
    'shieldSubscriptions','shieldAllowSites','shieldBlockedDomains','shieldSave','shieldStatus'
  ];
  for(const id of ids){
    assert.match(html,new RegExp('id="'+id+'"'),'Missing '+id);
    assert.match(ui,new RegExp("['\"]"+id+"['\"]"),'UI disconnected from '+id);
  }
  assert.match(html,/privacy-shield-ui\.js/);
  assert.match(section,/move\(privacy,'shieldSettings'\)/);
  assert.match(ui,/shield-get/);
  assert.match(ui,/shield-set/);
  new (require('node:vm').Script)(ui,{filename:'ui/privacy-shield-ui.js'});
});

test('Downloads notification resets on panel review, but future downloads still count',()=>{
  const downloads=source('ui/downloads-ui.js');
  assert.match(downloads,/const acknowledged=new Set\(\)/);
  assert.match(downloads,/for\(const entry of entries\)acknowledged\.add\(entry\.id\)/);
  assert.match(downloads,/!acknowledged\.has\(entry\.id\)/);
  assert.match(downloads,/badge\.hidden=true/);
});

test('Native WebView2 blocker honors authentication popup and configurable rules',()=>{
  const main=source('native/desktop/src-tauri/src/main.rs');
  const shield=source('native/desktop/src-tauri/src/privacy_shield.rs');
  assert.match(main,/mod privacy_shield;/);
  assert.match(main,/\.initialization_script\(privacy_shield::script/);
  assert.match(main,/if auth_target \{/);
  assert.match(main,/privacy_shield::block_popup/);
  assert.match(main,/restore_visible_surfaces/);
  assert.match(shield,/pub fn block_popup/);
  assert.match(shield,/pub fn block_navigation/);
  assert.match(shield,/fn host_matches/);
  assert.match(shield,/username|host_matches/);
});

test('Click-triggered third-party popunders are denied before OAuth popup creation',()=>{
  const native=source('native/desktop/src-tauri/src/main.rs');
  const policy=source('native/desktop/src-tauri/src/privacy_shield.rs');
  assert.match(native,/let deny=for_popup\.state::<privacy_shield::ShieldState>/);
  assert.match(native,/privacy_shield::block_blank_popup\(&settings,&opener\)/);
  assert.match(native,/if auth_target \{/);
  assert.match(policy,/high_risk_popup_source/);
  assert.match(policy,/123moviesfree\.net/);
  assert.match(policy,/built_in_popup/);
  assert.match(policy,/config\.mode=="strict"/);
  // A native denied popup supplies a dummy WindowProxy; the page must never
  // receive null from our own window.open override and abort video playback.
  assert.doesNotMatch(policy,/window\.open\s*=\s*function/);
  assert.doesNotMatch(policy,/return\s+null\s*;\s*\}\s*return\s+Reflect\.apply\(originalOpen/);
  assert.match(policy,/Do not replace window\.open/);
});

test('Favicons are restored from validated persistent bytes, never persisted for private-only sites',()=>{
  const ui=source('ui/app.js');
  assert.match(ui,/const FAVICON_STORE='minternet\.tab-favicons\.v2'/);
  assert.match(ui,/restoreFaviconCache\(\)/);
  assert.match(ui,/cachedIconPattern\.test\(src\)/);
  assert.match(ui,/!t\.private&&!t\.secretTab/);
  assert.match(ui,/bookmark-icon-data/);
  assert.match(ui,/img\.decoding='sync'/);
});

test('Password autofill uses unlocked unique HTTPS-origin logins and does not overwrite typed inputs',()=>{
  const main=source('native/desktop/src-tauri/src/main.rs');
  const vault=source('native/desktop/src-tauri/src/password_vault.rs');
  assert.match(main,/fill_saved_credential\(&for_load,id,false,None\)/);
  assert.match(main,/fill_saved_credential\(&app,active,false,None\)/);
  assert.match(main,/if actual_origin!=tab_origin\{return Ok\(false\);\}/);
  assert.match(main,/tab\.private\|\|tab\.secret_id\.is_some\(\)/);
  assert.match(main,/password\.autocomplete==='new-password'/);
  assert.match(main,/if\(password\.value\|\|user\?\.value/);
  assert.match(main,/observer\.disconnect\(\),9000/);
  assert.match(vault,/if matches\.next\(\)\.is_some\(\)\{return None;\}/);
});

test('Injected popup and login scripts compile before they are sent to WebView2',()=>{
  const vm=require('node:vm');
  const shield=source('native/desktop/src-tauri/src/privacy_shield.rs');
  const main=source('native/desktop/src-tauri/src/main.rs');
  const popupScript=shield.match(/const SCRIPT:&str=r###"([\s\S]*?)"###;/);
  const loginScript=main.match(/const LOGIN_FILL_JS:&str=r###"([\s\S]*?)"###;/);
  assert.ok(popupScript,'Missing injected popup script');
  assert.ok(loginScript,'Missing injected autofill script');
  new vm.Script(popupScript[1],{filename:'privacy_shield.document_start.js'});
  new vm.Script(loginScript[1],{filename:'login_form_autofill.js'});
});

test('Balanced video compatibility leaves third-party player windows intact',()=>{
  const policy=source('native/desktop/src-tauri/src/privacy_shield.rs');
  assert.match(policy,/Balanced must not mistake a cross-origin playback window/);
  assert.match(policy,/cdn-streaming-player\.example\/embed/);
  assert.match(policy,/popads\.net\/landing/);
  assert.match(policy,/p\.mode="strict"\.into\(\)/);
  assert.match(policy,/p\.mode="balanced"\.into\(\)/);
});
