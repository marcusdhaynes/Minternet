'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');

test('Updates checks native verified prereleases and reads actual installed build',async()=>{
  const calls=[];
  const installed={version:'0.3.0',buildId:'850',commit:'abcd'};
  const release={version:'0.3.0',buildId:'851',
    tag:'minternet-build-851',url:'https://github.com/marcusdhaynes/Minternet/releases/tag/minternet-build-851',
    downloadUrl:'https://github.com/marcusdhaynes/Minternet/releases/download/minternet-build-851/Minternet.exe'};
  const win={__TAURI__:{},minternet:{command:async(name,value)=>{
    calls.push({name,value});
    if(name==='updates-check')return {installed,update:release};
    return {ok:true};
  }},location:{reload:()=>{throw Error('Update must not reload active session');}}};
  const dom={readyState:'loading',addEventListener:()=>{},querySelector:()=>null};
  vm.runInNewContext(read('ui/updates.js'),{window:win,document:dom,
    fetch:()=>{throw Error('Browser-side API fetch should never be used in native build');},
    Date,Promise,localStorage:{getItem:()=>null,setItem:()=>{}}});
  const update=await win.MuseUpdates.checkForUpdate(true);
  assert.equal(update.buildId,'851');
  assert.equal(win.MuseUpdates.CURRENT_VERSION,'0.3.0');
  assert.equal(win.MuseUpdates.CURRENT_BUILD,'850');
  win.MuseUpdates.applyUpdate(update);
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(calls.some(call=>call.name==='updates-check'));
  assert.ok(calls.some(call=>call.name==='new-url'&&call.value===release.url));
});
test('Web preview checks prereleases instead of stable-only latest endpoint',async()=>{
  const tag='minternet-build-999';
  const source={draft:false,tag_name:tag,name:'Minternet Windows v0.3.0-build.999',
    html_url:'https://github.com/marcusdhaynes/Minternet/releases/tag/'+tag,
    assets:[{name:'Minternet-Windows-Portable-v0.3.0-build.999.exe',
      browser_download_url:'https://github.com/marcusdhaynes/Minternet/releases/download/'+tag+'/Minternet-Windows-Portable-v0.3.0-build.999.exe'}]};
  let checkedUrl='';
  const win={location:{}};
  const dom={readyState:'loading',addEventListener:()=>{},querySelector:()=>null};
  vm.runInNewContext(read('ui/updates.js'),{window:win,document:dom,
    fetch:async url=>{checkedUrl=url;return {ok:true,json:async()=>[source]};},
    Date,Promise,localStorage:{getItem:()=>null,setItem:()=>{}}});
  const update=await win.MuseUpdates.checkForUpdate(true);
  assert.match(checkedUrl,/\/releases\?per_page=/);
  assert.equal(update.tag,tag);
  assert.equal(update.buildId,'999');
  assert.match(read('ui/updates.js'),/dismissVersion\(info\.tag\|\|info\.version\)/);
  assert.match(read('ui/updates.js'),/updates-installed/);
  assert.doesNotMatch(read('ui/updates.js'),/var CURRENT_VERSION = '0\.1\.0'/);
});
test('URL bar drafts survive initial native focus handoffs',()=>{
  const source=read('ui/app.js');
  assert.match(source,/const addressDrafts=new Map\(\)/);
  assert.match(source,/addressDrafts\.set\(snapshot\.activeId,event\.currentTarget\.value\)/);
  assert.match(source,/addressDrafts\.get\(snapshot\.activeId\)/);
  assert.match(source,/if\(!addressEditedSinceNew\)field\?\.select\(\)/);
  assert.match(source,/document\.activeElement!==byId\('address'\)/);
  assert.match(source,/reloadPending\.sawLoading/);
  assert.match(source,/refresh-spinning/);
});
test('Renderer crashes recover without clearing cookies and extension selection remains stable',()=>{
  const source=read('native/desktop/src-tauri/src/main.rs');
  const updates=read('native/desktop/src-tauri/src/updates.rs');
  assert.match(source,/attach_webview_process_recovery/);
  assert.match(source,/add_ProcessFailed/);
  assert.match(source,/COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED/);
  assert.match(source,/SITE_EXTENSION_PROFILE/);
  assert.match(source,/extensions::isolated_site_dir\(app\)\.map\(\|dir\|dir\.exists\(\)\)/);
  assert.match(source,/let _=view\.hide\(\);\s*let _=view\.show\(\);/);
  assert.match(source,/minternet-empty-document-once/);
  assert.doesNotMatch(source,/remove_dir_all\(.*extension-sites/);
  assert.match(updates,/RELEASES_API.*releases\?per_page=30/);
  assert.match(updates,/fn acceptable_asset/);
  assert.match(updates,/fn installed/);
});
test('Encrypted login suggestions show unlock prompt and username-first forms',()=>{
  const suggestions=read('ui/form-suggestions.js');
  const native=read('native/desktop/src-tauri/src/main.rs');
  assert.match(suggestions,/Unlock Saved Logins/);
  assert.match(suggestions,/status\?\.unlocked/);
  assert.match(suggestions,/vault-fill/);
  assert.match(suggestions,/vault-capture-login/);
  assert.match(native,/const usernameFirst=/);
  assert.match(native,/const registrationRoute=/);
  assert.match(native,/vault-unlock/);
});
test('Windows build embeds release run number to avoid suggesting the installed EXE',()=>{
  const workflow=read('.github/workflows/native-windows.yml');
  assert.match(workflow,/MINTERNET_BUILD_RUN_ID:/);
  assert.match(workflow,/MINTERNET_BUILD_SHA:/);
  assert.match(workflow,/Upload uniquely versioned Windows portable artifact/);
  assert.match(read('.github/workflows/publish-current-portable.yml'),/Archive every successful Minternet build to GitHub Releases/);
});
