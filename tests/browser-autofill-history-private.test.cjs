'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const get=p=>fs.readFileSync(path.join(__dirname,'../',p),'utf8');

test('payment method button opens the encrypted native vault, not an untrusted website panel',()=>{
 const html=get('ui/index.html');
 const ui=get('ui/payment-ui.js');
 assert.match(html,/id="paymentToolbarButton"/);
 assert.match(ui,/toolbar\?\.addEventListener\('click',\(\)=>void open\(\)\)/);
 assert.match(ui,/vault-card-fill/);
 assert.match(ui,/vault-card-list/);
 assert.match(ui,/vault-card-put/);
 assert.match(ui,/vault-card-remove/);
 assert.match(ui,/vault-lock/);
});
test('new normal and private blank tabs focus the address bar',()=>{
 const ui=get('ui/app.js');
 assert.match(ui,/const isNewTab=/);
 assert.match(ui,/data\.tabs\.some\(tab=>tab\.id===data\.activeId&&tab\.url==='about:blank'\)/);
 assert.match(ui,/address\?\.focus\(\)/);
 assert.match(ui,/\['newPrivate','new-private'\]/);
});
test('private tab history cannot be saved or queried in the native browser',()=>{
 const source=get('native/desktop/src-tauri/src/main.rs');
 assert.match(source,/if tab\.private\{return;\}/);
 assert.match(source,/if private\{return Ok\(json!\(\[\]\)\);\}/);
 assert.match(source,/\.incognito\(private\)/);
 assert.match(source,/new-private-background-url/);
});
test('address suggestions order recent visits ahead of matching bookmarked sites',()=>{
 const source=get('ui/history-ui.js');
 assert.match(source,/\.\.\.\(Array\.isArray\(recent\)\?recent:\[\]\),\.\.\.filteredBookmarks/);
 assert.match(source,/const recent=privateActive\(\)\?\[\]/);
 assert.match(source,/history-search/);
});
