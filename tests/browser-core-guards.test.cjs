'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const source=name=>fs.readFileSync(path.join(root,name),'utf8');

test('retired Privacy Shield is uninstalled from native code and UI',()=>{
  const native=source('native/desktop/src-tauri/src/main.rs');
  const html=source('ui/index.html');
  const styles=source('ui/styles.css');
  const sections=source('ui/settings-sections.js');
  assert.doesNotMatch(native,/mod privacy_shield|privacy_shield::|minternet:shield-blocked|name=="shield-(get|set)"/);
  assert.doesNotMatch(html,/shieldButton|shieldSettings|privacy-shield-ui\.js|shieldMode|shieldSave|shieldPopup/);
  assert.doesNotMatch(styles,/\.shield-popup|\.shield-settings|#shieldButton/);
  assert.doesNotMatch(sections,/shieldSettings/);
  assert.match(native,/remove_file\(folder\.join\("privacy-shield\.v1\.json"\)\)/);
  assert.match(native,/initialization_script\(include_str!\("..\/..\/..\/..\/ui\/site-media-bridge\.js"\)\)/);
  assert.match(native,/initialization_script\(include_str!\("..\/..\/..\/..\/ui\/site-download-links\.js"\)\)/);
  assert.match(native,/auth_popup::preserve_opener/);
  assert.match(html,/id="extensionsButton"/);
});

test('Downloads acknowledgement persists across reviews, restarts and refreshing',()=>{
  const downloads=source('ui/downloads-ui.js');
  const native=source('native/desktop/src-tauri/src/main.rs');
  assert.match(downloads,/entry\.unread===true/);
  assert.match(downloads,/downloads-acknowledge/);
  assert.match(downloads,/await acknowledgeDownloads\(\)/);
  assert.match(native,/"downloads-acknowledge"/);
  assert.match(native,/unread:bool/);
  assert.match(native,/entry\.unread=false/);
  assert.match(native,/save_recent_downloads\(&app\)/);
});

test('regular site windows use Minternet tabs, authenticated OAuth windows preserve the opener',()=>{
  const main=source('native/desktop/src-tauri/src/main.rs');
  const context=source('native/desktop/src-tauri/src/site_context_menu.rs');
  const a=main.indexOf('.on_new_window(move |url, _features|');
  const b=main.indexOf('.on_page_load(move |view, event|',a);
  assert.ok(a>0&&b>a);
  const handler=main.slice(a,b);
  assert.match(handler,/open_site_popup_tab/);
  assert.match(handler,/NewWindowResponse::Deny/);
  assert.match(handler,/auth_popup::preserve_opener\(&opener_url,&url\)/);
  assert.match(handler,/NewWindowResponse::Create\{window\}/);
  assert.match(handler,/\.window_features\(_features\)/);
  assert.match(handler,/target\.scheme\(\)=="https"/);
  assert.match(handler,/DownloadEvent::Requested\{\.\.\}=>false/);
  assert.ok(handler.indexOf('NewWindowResponse::Create')<handler.indexOf('open_site_popup_tab'));
  assert.match(source('native/desktop/src-tauri/src/auth_popup.rs'),/fn ordinary_web_links_stay_in_tabs/);
  assert.match(main,/spawn_browser_window/);
  assert.match(main,/"open-new-browser-window"/);
  assert.match(context,/ContextMenuRequestedEventHandler/);
  assert.match(context,/SetHandled\(true\)/);
});

test('Favicons are restored from validated persistent bytes, never persisted for private-only sites',()=>{
  const ui=source('ui/app.js');
  assert.match(ui,/const FAVICON_STORE='minternet\.tab-favicons\.v2'/);
  assert.match(ui,/restoreFaviconCache\(\)/);
  assert.match(ui,/cachedIconPattern\.test\(src\)/);
  assert.match(ui,/!t\.private&&!t\.secretTab/);
  assert.match(ui,/bookmark-icon-data/);
  assert.match(ui,/img\.decoding='async'/);
});

test('Password autofill uses unlocked unique HTTPS-origin logins and does not overwrite typed inputs',()=>{
  const main=source('native/desktop/src-tauri/src/main.rs');
  const vault=source('native/desktop/src-tauri/src/password_vault.rs');
  assert.match(main,/fill_saved_credential\(&task,id,false,None\)/);
  assert.match(main,/run_on_main_thread\(move\|\|\{/);
  assert.match(main,/fill_saved_credential\(&app,active,false,None\)/);
  assert.match(main,/if actual_origin!=tab_origin\{return Ok\(false\);\}/);
  assert.match(main,/tab\.private\|\|tab\.secret_id\.is_some\(\)/);
  const injected=source('native/desktop/src-tauri/src/login_autofill.js');
  assert.match(main,/include_str!\("login_autofill\.js"\)/);
  assert.match(injected,/token\(el\)\.includes\('new-password'\)/);
  assert.match(injected,/password\.value&&!marked\.has\(password\)/);
  assert.match(injected,/marked\.add\(element\)/);
  assert.match(injected,/setTimeout\(stop,90000\)/);
  assert.match(vault,/let preferred=eligible\.into_iter\(\)\.filter\(\|e\|e\.preferred\)/);
  assert.match(vault,/if preferred\.len\(\)==1/);
  assert.match(main,/vault_section_allowed\(app,"logins"\)/);
});

test('Injected login script compiles before it is sent to WebView2',()=>{
  const vm=require('node:vm');
  const main=source('native/desktop/src-tauri/src/main.rs');
  assert.match(main,/const LOGIN_FILL_JS:&str=include_str!\("login_autofill\.js"\)/);
  const loginScript=source('native/desktop/src-tauri/src/login_autofill.js');
  assert.ok(loginScript.includes('__MINTERNET_LOGIN_PAYLOAD__'),'Missing native credential placeholder');
  new vm.Script(loginScript,{filename:'login_autofill.js'});
});

test('Android and iOS both accept JavaScript-created popup windows',()=>{
  const android=source('native/android/app/src/main/java/app/minternet/browser/MainActivity.java');
  const ios=source('native/ios/Sources/MinternetApp.swift');
  assert.match(android,/setJavaScriptCanOpenWindowsAutomatically\(true\)/);
  assert.doesNotMatch(android,/if\(!userGesture\)return false/);
  assert.match(ios,/javaScriptCanOpenWindowsAutomatically = true/);
  assert.match(ios,/adoptedView: child/);
  assert.match(ios,/return state\.newTab\(privateMode: privateSource, adoptedView: child\)/);
});
