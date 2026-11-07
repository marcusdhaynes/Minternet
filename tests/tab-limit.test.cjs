'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');

test('Tauri desktop removes 35-tab cap and persists zero-unlimited preference',()=>{
  const native=read('native/desktop/src-tauri/src/main.rs');
  assert.match(native,/tab_limit:0/);
  assert.match(native,/limit==0 \|\| existing\.checked_add/);
  assert.match(native,/"tab-limit-set"/);
  assert.match(native,/"tabLimit":tab_limit/);
  assert.doesNotMatch(native,/MAX_TABS|Maximum 35 tabs|take\(35\)/);
});
test('all native browser implementations honor zero unlimited',()=>{
  const electron=read('src/main.cjs');
  const android=read('native/android/app/src/main/java/app/minternet/browser/MainActivity.java');
  const ios=read('native/ios/Sources/MinternetApp.swift');
  assert.match(electron,/tabLimit>0 && tabs\.length>=tabLimit/);
  assert.match(android,/limit>0 && tabs\.size\(\)>=limit/);
  assert.match(ios,/tabLimit == 0 \|\| tabs\.count < tabLimit/);
  assert.doesNotMatch(android,/tabs\.size\(\)>=24/);
  assert.doesNotMatch(ios,/tabs\.count < 25/);
});
test('settings and preview support zero and positive limits',()=>{
  const html=read('ui/index.html');
  const js=read('ui/browser-settings.js');
  const preview=read('docs/preview-bridge.js');
  assert.match(html,/id="tabLimit"/);
  assert.match(html,/id="tabLimitSave"/);
  assert.match(js,/invoke\('tab-limit-set',n\)/);
  assert.match(js,/tabLimit\.value=String\(settings\.tabLimit\?\?0\)/);
  assert.match(preview,/case 'tab-limit-get'/);
  assert.match(preview,/case 'tab-limit-set'/);
  assert.doesNotMatch(preview,/Maximum 35 tabs|tabs\.length>=35/);
});
