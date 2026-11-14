'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const html=read('ui/index.html');
const settings=read('ui/settings-sections.js');
const updates=read('ui/updates.js');
const app=read('ui/app.js');
const native=read('native/desktop/src-tauri/src/main.rs');
const backend=read('native/desktop/src-tauri/src/extensions.rs');
test('release includes completed November extension manager and toolbar button',()=>{
 assert.match(html,/id="extensionsButton"/);
 assert.match(html,/id="extensionsPanel"/);
 assert.match(html,/src="\.\/extensions-ui\.js"/);
 assert.doesNotMatch(html,/class="extension-settings"/);
 assert.match(native,/mod extensions;/);
 assert.match(native,/"extensions-import"/);
 assert.match(native,/browser_extensions_enabled/);
 assert.match(backend,/pub fn any_enabled/);
});
test('Settings includes compact Updates accordion, not unstyled footer',()=>{
 assert.match(settings,/const updates=section\('Updates'\)/);
 assert.match(settings,/move\(updates,'updatesSection'\)/);
 for(const name of ['updates-versions','updates-version-row','updates-current-status','updates-actions','updates-release-notes'])assert.ok(updates.includes(name));
 assert.doesNotMatch(updates,/document.createElement\('h2'\)/);
});
test('in-place updater and WebView2 context menus are preserved',()=>{
 assert.match(native,/mod portable_updater;/);
 assert.match(native,/"update-install"/);
 assert.match(updates,/command\('update-install'\)/);
 assert.match(native,/site_context_menu::select/);
});
test('white page, focus and draft-preservation fixes survive',()=>{
 assert.match(app,/controller creation can transfer OS keyboard focus mid-keystroke/);
 assert.match(app,/dataset\.minternetTyped === 'true'\) return/);
 assert.match(native,/fn restore_visible_surfaces/);
 assert.match(native,/notify_native_compositor/);
});
test('recent download and navigation enhancements survive',()=>{
 assert.match(native,/download_mode:String/);
 assert.match(html,/src="\.\/navigation-history-ui\.js"/);
 assert.match(native,/initialization_script\(include_str!\("\.\.\/\.\.\/\.\.\/\.\.\/ui\/site-download-links\.js"\)\)/);
});
