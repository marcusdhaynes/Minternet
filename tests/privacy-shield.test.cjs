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

test('Native WebView2 allows popups while preserving separate page policies',()=>{
  const main=source('native/desktop/src-tauri/src/main.rs');
  const shield=source('native/desktop/src-tauri/src/privacy_shield.rs');
  assert.match(main,/mod privacy_shield;/);
  assert.match(main,/\.initialization_script\(privacy_shield::script/);
  assert.match(main,/if auth_target \{/);
  assert.match(main,/NEXT_POPUP_ID\.fetch_add\(1,Ordering::Relaxed\)/);
  assert.match(main,/NewWindowResponse::Create\{window\}/);
  assert.doesNotMatch(main,/privacy_shield::block_popup|privacy_shield::block_blank_popup/);
  assert.match(main,/restore_visible_surfaces/);
  assert.doesNotMatch(shield,/pub fn block_popup|pub fn block_blank_popup/);
  assert.match(shield,/pub fn block_navigation/);
  assert.match(shield,/fn host_matches/);
  assert.match(shield,/username|host_matches/);
});

test('Website popup creation has no domain/origin filters, count caps or deduplication',()=>{
  const native=source('native/desktop/src-tauri/src/main.rs');
  const shield=source('native/desktop/src-tauri/src/privacy_shield.rs');
  const a=native.indexOf('.on_new_window(move |url, features|');
  const b=native.indexOf('.on_page_load(move |view, event|',a);
  assert.ok(a>0 && b>a);
  const handler=native.slice(a,b);
  assert.match(handler,/WebviewWindowBuilder::new/);
  assert.match(handler,/window_features\(features\)/);
  assert.match(handler,/NewWindowResponse::Create\{window\}/);
  assert.match(handler,/DownloadEvent::Requested\{\.\.\}=>false/);
  assert.doesNotMatch(handler,/block_popup|block_blank_popup|built_in_popup|should_open|open_popups|>= 8|shield-blocked/);
  assert.doesNotMatch(shield,/fn block_popup|fn block_blank_popup|fn built_in_popup|fn high_risk_popup_source/);
  assert.doesNotMatch(shield,/window\.open\s*=\s*function/);
});

test('Favicons are restored from validated persistent bytes, never persisted for private-only sites',()=>{
  const ui=source('ui/app.js');
  assert.match(ui,/const FAVICON_STORE='minternet\.tab-favicons\.v2'/);
  assert.match(ui,/restoreFaviconCache\(\)/);
  assert.match(ui,/cachedIconPattern\.test\(src\)/);
  assert.match(ui,/!t\.private&&!t\.secretTab/);
  assert.match(ui,/bookmark-icon-data/);
  assert.match(ui,/img\.decoding='async'/);
});

test('Password autofill uses unlocked unique HTTPS-origin logins and does not overwrite typed inputs',()=>{
  const main=source('native/desktop/src-tauri/src/main.rs');
  const vault=source('native/desktop/src-tauri/src/password_vault.rs');
  assert.match(main,/fill_saved_credential\(&task,id,false,None\)/);
  assert.match(main,/run_on_main_thread\(move\|\|\{/);
  assert.match(main,/fill_saved_credential\(&app,active,false,None\)/);
  assert.match(main,/if actual_origin!=tab_origin\{return Ok\(false\);\}/);
  assert.match(main,/tab\.private\|\|tab\.secret_id\.is_some\(\)/);
  assert.match(main,/token\(el\)\.includes\('new-password'\)/);
  assert.match(main,/if\(password\.value \|\| \(account\?\.value/);
  assert.match(main,/setTimeout\(stop,90000\)/);
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

test('Android and iOS both accept JavaScript-created popup windows',()=>{
  const android=source('native/android/app/src/main/java/app/minternet/browser/MainActivity.java');
  const ios=source('native/ios/Sources/MinternetApp.swift');
  assert.match(android,/setJavaScriptCanOpenWindowsAutomatically\(true\)/);
  assert.doesNotMatch(android,/if\(!userGesture\)return false/);
  assert.match(ios,/javaScriptCanOpenWindowsAutomatically = true/);
  assert.match(ios,/adoptedView: child/);
  assert.match(ios,/return state\.newTab\(privateMode: privateSource, adoptedView: child\)/);
});
