'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const source=file=>fs.readFileSync(path.join(root,file),'utf8');

test('authentication windows preserve the real opener in a managed native WebView',()=>{
  const main=source('native/desktop/src-tauri/src/main.rs');
  const policy=source('native/desktop/src-tauri/src/auth_popup.rs');
  assert.match(main,/auth_popup::preserve_opener\(&opener_url,&url\)/);
  assert.match(main,/\.window_features\(_features\)/);
  assert.match(main,/NewWindowResponse::Create\{window\}/);
  assert.match(main,/\.on_navigation\(\|target\|\{/);
  assert.match(main,/\.on_permission_request\(\|_,kind\|/);
  assert.match(policy,/about:blank/);
  assert.match(policy,/accounts\.google\.com/);
  assert.match(policy,/code_challenge/);
  assert.match(policy,/fn ordinary_web_links_stay_in_tabs/);
});

test('passkeys are OS-owned and accessible from Logins while vault is locked',()=>{
  const html=source('ui/index.html');
  const ui=source('ui/password-ui.js');
  const native=source('native/desktop/src-tauri/src/passkey_support.rs');
  const main=source('native/desktop/src-tauri/src/main.rs');
  assert.match(html,/<details id="vaultPasskeys"/);
  assert.ok(html.indexOf('id="vaultPasskeys"')<html.indexOf('id="vaultAuthForm"'));
  for(const id of ['passkeyStatus','passkeyCheck','passkeyManage','passkeyTest']){
    assert.match(html,new RegExp('id="'+id+'"'));
    assert.match(ui,new RegExp("'"+id+"'"));
  }
  assert.match(native,/WebAuthNGetApiVersionNumber/);
  assert.match(native,/WebAuthNIsUserVerifyingPlatformAuthenticatorAvailable/);
  assert.match(native,/ms-settings:savedpasskeys/);
  assert.match(main,/name=="passkey-status"/);
  assert.match(main,/name=="passkey-open-settings"/);
  assert.doesNotMatch(native,/VaultPayload|vault\.save|credentials\.create\(/);
});

test('CI includes actual WebView2 popup messaging and HTTPS WebAuthn probes',()=>{
  const main=source('native/desktop/src-tauri/src/main.rs');
  const workflow=source('.github/workflows/native-windows.yml');
  assert.match(main,/event\.source===child/);
  assert.match(main,/window\.opener\.postMessage/);
  assert.match(main,/PublicKeyCredential/);
  assert.match(main,/isUserVerifyingPlatformAuthenticatorAvailable/);
  assert.match(workflow,/--minternet-auth-popup-smoke/);
  assert.match(workflow,/--minternet-passkey-smoke/);
  assert.match(workflow,/ConvertFrom-Json/);
});
