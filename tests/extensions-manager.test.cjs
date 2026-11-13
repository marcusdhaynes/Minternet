'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const html=read('ui/index.html');
const manager=read('ui/extensions-ui.js');
const styles=read('ui/styles.css');
const native=read('native/desktop/src-tauri/src/main.rs');
const backend=read('native/desktop/src-tauri/src/extensions.rs');

test('Extensions has a dedicated toolbar control immediately before Downloads',()=>{
  assert.match(html,/id="extensionsButton"/);
  assert.ok(html.indexOf('id="extensionsButton"')<html.indexOf('id="downloadsButton"'));
  assert.match(html,/src="\.\/extensions-ui\.js"/);
  assert.match(html,/id="extensionsPanel"/);
  assert.doesNotMatch(html,/class="extension-settings"/);
});
test('Minternet owns one full card; Firefox and Chrome have equal split source cards',()=>{
  assert.match(html,/extensions-minternet-card/);
  assert.equal((html.match(/extensions-split-card/g)||[]).length,2);
  assert.equal((html.match(/extensions-import-half/g)||[]).length,2);
  assert.equal((html.match(/extensions-store-half/g)||[]).length,2);
  assert.ok(html.indexOf('extensions-minternet-card')<html.indexOf('id="firefoxExtensionStore"'));
  assert.ok(html.indexOf('id="firefoxExtensionStore"')<html.indexOf('id="chromeExtensionStore"'));
  assert.match(styles,/\.extensions-source-card\s*\{[\s\S]*?aspect-ratio:1/);
  assert.match(styles,/\.extensions-card-half\s*\{[\s\S]*?flex:1 1 50%/);
  for(const source of ['minternet','firefox','chrome']){
    assert.match(html,new RegExp('data-extension-import="'+source+'"'));
  }
});
test('Import/enable/disable/remove use trusted native commands and restart semantics',()=>{
  assert.match(manager,/extensions-import/);
  assert.match(manager,/extensions-list/);
  assert.match(manager,/extensions-toggle/);
  assert.match(manager,/extensions-remove/);
  assert.match(manager,/window\.addEventListener\?\.\('blur'/);
  assert.match(native,/mod extensions;/);
  assert.match(native,/extensions::import/);
  assert.match(native,/extensions::set_enabled/);
  assert.match(native,/extensions::remove/);
  assert.match(native,/browser_extensions_enabled\(true\)/);
  assert.match(native,/extensions::isolated_site_dir/);
  assert.match(native,/extensions::active_dir/);
  assert.match(backend,/MAX_COMPRESSED/);
  assert.match(backend,/MAX_TOTAL/);
  assert.match(backend,/enclosed_name/);
  assert.match(backend,/extension_id_ok/);
  assert.match(backend,/manifest\.json/);
});
test('Store actions do not misrepresent unsupported one-click installation',()=>{
  assert.match(manager,/https:\/\/addons\.mozilla\.org\/en-US\/firefox\//);
  assert.match(manager,/https:\/\/chromewebstore\.google\.com\//);
  assert.match(html,/their Add buttons do not install directly/);
  assert.match(html,/Firefox-only APIs may not work/);
});
