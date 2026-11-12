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
  assert.match(native,/target\.LinkUri\(&mut value\)/);
  assert.match(native,/target\.SelectionText\(&mut value\)/);
  assert.match(native,/minternet:site-context/);
  assert.match(main,/site_context_menu::attach\(app,id,&created\)/);
});

test('site new windows always go through a Minternet tab, explicit right-click opens new process',()=>{
  const main=read('native/desktop/src-tauri/src/main.rs');
  const a=main.indexOf('.on_new_window(move |url, _features|');
  const b=main.indexOf('.on_page_load(move |view, event|',a);
  assert.ok(a>0 && b>a);
  const route=main.slice(a,b);
  assert.match(route,/open_site_popup_tab/);
  assert.match(route,/NewWindowResponse::Deny/);
  assert.doesNotMatch(route,/WebviewWindowBuilder::new|NewWindowResponse::Create/);
  assert.match(main,/fn spawn_browser_window/);
  assert.match(main,/--minternet-open-window/);
  assert.match(main,/fn new_window_startup/);
  assert.match(main,/schedule_session_save/);
  assert.match(main,/fn open_site_popup_tab/);
  assert.match(main,/"site-link-new-tab"/);
  assert.match(main,/"open-new-browser-window"/);
});
