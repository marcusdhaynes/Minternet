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
  assert.match(main,/if is_auth_popup_url\(&url\)/);
  assert.match(main,/privacy_shield::block_popup/);
  assert.match(main,/restore_visible_surfaces/);
  assert.match(shield,/pub fn block_popup/);
  assert.match(shield,/pub fn block_navigation/);
  assert.match(shield,/fn host_matches/);
  assert.match(shield,/username|host_matches/);
});
