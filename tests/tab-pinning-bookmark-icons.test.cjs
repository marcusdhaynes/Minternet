'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
test('all bookmark bar favicons are centered and have no decorative outline',()=>{
 const css=read('ui/styles.css');
 const block=css.slice(css.indexOf('/* Precisely centered Bookmark Bar artwork'),
    css.indexOf('.tab-symbol.secret-tab-icon'));
 assert.match(block,/place-items:center!important/);
 assert.match(block,/place-content:center!important/);
 assert.match(block,/border:0!important;outline:0!important/);
 assert.match(block,/box-shadow:none!important/);
 assert.doesNotMatch(block,/border:1px solid/);
 assert.match(block,/filter:saturate\(\.5\)/);
});
test('open normal-tab bookmark pages are muted but Secret Tabs are excluded',()=>{
 const ui=read('ui/bookmark-ui.js');
 assert.match(ui,/openBookmarkUrls=new Set/);
 assert.match(ui,/filter\(t=>!t\.secretTab\)/);
 assert.match(ui,/classList\.toggle\('bookmark-open-page'/);
});
test('pinning confirms native success before modifying group membership',()=>{
 const ui=read('ui/tab-group-ui.js');
 const pin=ui.slice(ui.indexOf('async function pin('),ui.indexOf('function currentDraggedTab'));
 assert.ok(pin.indexOf("const response=await api.command(")<pin.indexOf('model.assign(state,tabId,null)'));
 assert.match(pin,/response\?\.ok!==true/);
 assert.match(ui,/drag-pin-over/);
 const native=read('native/desktop/src-tauri/src/main.rs');
 assert.match(native,/"pin" \| "unpin" \| "toggle-pin"/);
 assert.match(native,/save_pinned\(&app\)/);
});
