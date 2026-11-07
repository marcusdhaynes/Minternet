'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
test('identities are encrypted by the native password vault, never localStorage',()=>{
 const native=read('native/desktop/src-tauri/src/password_vault.rs');
 const ui=read('ui/identity-ui.js');
 assert.match(native,/struct Identity/);
 assert.match(native,/identities:self\.identities\.clone\(\)/);
 assert.match(native,/pub fn put_identity/);
 assert.match(native,/pub fn list_identities/);
 assert.doesNotMatch(ui,/localStorage\.setItem/);
 assert.match(ui,/vault-identity-put/);
 assert.match(ui,/vault-identity-fill/);
});
test('form inspection is metadata only and secret saving requires explicit action',()=>{
 const native=read('native/desktop/src-tauri/src/main.rs');
 const ui=read('ui/form-suggestions.js');
 const span=native.split('const FORM_FIELD_CONTEXT_JS:&str=')[1]
   .split('const CAPTURE_LOGIN_JS:&str=')[0];
 assert.match(span,/hasValue:entered/);
 assert.match(span,/fieldIndex/);
 assert.doesNotMatch(span,/password:pw\[/);
 assert.match(native,/vault-capture-login/);
 assert.match(native,/vault-identity-capture/);
 assert.match(ui,/action\('Ignore'/);
 assert.match(ui,/action\('✎ Edit Identities'/);
});
test('bookmark manager collapses by default and supports multi-move',()=>{
 const ui=read('ui/bookmark-ui.js');
 const model=read('ui/bookmark-model.js');
 assert.match(ui,/expandedFolders=new Set\(\)/);
 assert.match(ui,/bindHoldSelect/);
 assert.match(ui,/model\.moveMany\(data/);
 assert.match(model,/function moveMany/);
});
test('identities sync only through the end-to-end encrypted vault path',()=>{
 const core=read('ui/live-sync-core.js');
 const sync=read('ui/google-sync-ui.js');
 assert.match(core,/['"]identity['"]/);
 assert.match(core,/opaqueId\('identity'/);
 assert.match(sync,/identities:vault/);
 assert.match(sync,/kind==='identity'/);
});
