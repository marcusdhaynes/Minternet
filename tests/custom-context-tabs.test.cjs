'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('all Minternet chrome and bookmark context menus are app-owned DOM, not OS/Tauri menu popups',()=>{
  const ui=read('ui/chrome-native-menu.js');
  assert.doesNotMatch(ui,/api\.menu\.Menu\.new/);
  assert.doesNotMatch(ui,/native\.popup\(/);
  assert.match(ui,/options=\{\.\.\.options,custom:true\}/);
  assert.match(ui,/document\.addEventListener\?\.\('contextmenu'/);
  assert.match(ui,/minternet:site-context/);
  assert.match(ui,/site:details=>/);
  assert.match(ui,/chrome:event=>/);
  assert.match(ui,/Open Link in New Window/);
  assert.match(ui,/Open in New Window/);
});

test('WebView2 suppresses its default context menu and supplies trusted selected target',()=>{
  const native=read('native/desktop/src-tauri/src/site_context_menu.rs');
  const main=read('native/desktop/src-tauri/src/main.rs');
  assert.match(native,/ICoreWebView2_11/);
  assert.match(native,/add_ContextMenuRequested/);
  assert.match(native,/args\.SetHandled\(true\)/);
  assert.match(native,/args\.ContextMenuTarget\(\)/);
  assert.match(native,/target\.HasLinkUri\(&mut flag\)/);
  assert.match(native,/target\.LinkUri\(p\)/);
  assert.match(native,/args\.SetSelectedCommandId\(id\)/);
  assert.match(native,/target\.SelectionText\(p\)/);
  assert.match(native,/args\.MenuItems\(\)/);
  assert.match(native,/item\.CommandId\(&mut command_id\)/);
  assert.match(native,/minternet:site-context/);
  assert.match(main,/site_context_menu::attach\(app,id,&created\)/);
});

test('ordinary site windows become tabs while HTTPS OAuth windows keep their WebView2 opener',()=>{
  const main=read('native/desktop/src-tauri/src/main.rs');
  const a=main.indexOf('.on_new_window(move |url, _features|');
  const b=main.indexOf('.on_page_load(move |view, event|',a);
  assert.ok(a>0 && b>a);
  const route=main.slice(a,b);
  assert.match(route,/open_site_popup_tab/);
  assert.match(route,/NewWindowResponse::Deny/);
  // OAuth authentication is the sole exception: a managed WebView2 window
  // must preserve the original WindowProxy for postMessage/callbacks.
  assert.match(route,/auth_popup::preserve_opener\(&opener_url,&url\)/);
  assert.match(route,/WebviewWindowBuilder::new/);
  assert.match(route,/\.window_features\(_features\)/);
  assert.match(route,/NewWindowResponse::Create\{window\}/);
  assert.match(route,/\.on_navigation\(\|target\|/);
  assert.match(route,/target\.scheme\(\)=="https"/);
  assert.match(route,/\.on_download\(\|_,event\|/);
  assert.ok(route.indexOf('auth_popup::preserve_opener')<route.indexOf('open_site_popup_tab'));
  assert.match(read('native/desktop/src-tauri/src/auth_popup.rs'),/fn ordinary_web_links_stay_in_tabs/);
  assert.match(main,/fn spawn_browser_window/);
  assert.match(main,/--minternet-open-window/);
  assert.match(main,/--minternet-open-private-window/);
  assert.match(main,/if let Some\(\(_,private\)\)=new_window_target\.as_ref\(\)/);
  assert.match(main,/fn new_window_startup/);
  assert.match(main,/schedule_session_save/);
  assert.match(main,/fn open_site_popup_tab/);
  assert.match(main,/"site-link-new-tab"/);
  assert.match(main,/"open-new-browser-window"/);
});
