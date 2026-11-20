'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
test('four password prompts default to ON with independent explicit choices',()=>{
  const prefs=read('native/desktop/src-tauri/src/lock_preferences.rs');
  for(const section of ['logins','identities','payments','bookmarks']){
    assert.match(prefs,new RegExp('pub '+section+':bool'));
    assert.match(prefs,new RegExp('"'+section+'"'));
  }
  assert.match(prefs,/Self\{logins:true,identities:true,payments:true,bookmarks:true\}/);
  assert.match(prefs,/pub fn from_policy/);
});
test('opt-out credentials use Windows Credential Manager, never a plaintext local profile',()=>{
  const store=read('native/desktop/src-tauri/src/device_secrets.rs');
  assert.match(store,/CredWriteW/);assert.match(store,/CredReadW/);
  assert.match(store,/CredDeleteW/);assert.match(store,/CRED_PERSIST_LOCAL_MACHINE/);
  assert.doesNotMatch(store,/fs::write|localStorage\.setItem|JSON\.stringify\(/);
  const main=read('native/desktop/src-tauri/src/main.rs');
  assert.match(main,/lock-preferences-set/);
  assert.match(main,/scratch\.unlock\(&path,&secret,false\)/);
  assert.match(main,/scratch\.open\(&path,&secret,false\)/);
  assert.match(main,/device_secrets::write\(store,&secret\)/);
  assert.match(main,/device_secrets::remove\("vault"\)/);
  assert.match(main,/device_secrets::remove\("bookmarks"\)/);
  assert.match(main,/secret\.open\(&path,&code,false\)/);
  assert.match(main,/unlock_permitted_sections_from_device\(app\.handle\(\)\)/);
});
test('shared underlying vault does not authorize a locked category',()=>{
  const main=read('native/desktop/src-tauri/src/main.rs');
  assert.match(main,/vault_section_allowed\(&app,required_section\)/);
  assert.match(main,/required_section=if name\.starts_with\("vault-card-"\)/);
  assert.match(main,/name\.starts_with\("vault-identity-"\)/);
  assert.match(main,/vault_section_allowed\(app,"logins"\)/);
  assert.match(main,/section=value\.get\("section"\)/);
  assert.match(main,/let password_required=lock_preferences::load\(&app\)\.required\(section\)\?/);
  assert.match(main,/if !password_required && !vault_section_allowed\(&app,section\)/);
  assert.match(main,/unlock_permitted_sections_from_device\(&app\)/);
  assert.match(main,/access\.lock\(\).*permit\(section\)/s);
});
test('settings show independent passwords switches and one-time authorization',()=>{
  const ui=read('ui/settings-sections.js');
  assert.match(ui,/section\('Password Locks',userData\)/);
  for(const name of ['identities','logins','payments','bookmarks']){
    assert.ok(ui.includes("'"+name+"'"));
  }
  assert.match(ui,/lock-preferences-get/);
  assert.match(ui,/lock-preferences-set/);
  assert.match(ui,/master\.type='password'/);
  assert.doesNotMatch(ui,/localStorage\.setItem/);
  const html=read('ui/index.html');
  assert.match(html,/>▣ Payments <span>/);
  assert.match(html,/>☆ Bookmarks <span>/);
  assert.doesNotMatch(html,/>☆ Manage Bookmarks <span>/);
});
test('each manager requests its own native section access and password prompt',()=>{
  const logins=read('ui/password-ui.js');
  const identity=read('ui/identity-ui.js');
  const payments=read('ui/payment-ui.js');
  assert.match(logins,/section:'logins'/);
  assert.match(identity,/section:'identities'/);
  assert.match(identity,/vault-status','identities'/);
  assert.match(payments,/section:'payments'/);
  assert.match(payments,/vault-status','payments'/);
  assert.match(logins,/vault-lock','logins'/);
  assert.match(identity,/vault-lock','identities'/);
  assert.match(payments,/vault-lock','payments'/);
  const policy=read('native/desktop/src-tauri/src/lock_preferences.rs');
  assert.match(policy,/pub fn revoke\(&mut self,kind:&str\)/);
  assert.match(policy,/pub fn any\(&self\)->bool/);
});
