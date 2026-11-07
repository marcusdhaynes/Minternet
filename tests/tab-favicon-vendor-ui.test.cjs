'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');

test('websites use their real WebView2 favicon rather than an invented letter',()=>{
  const native=read('native/desktop/src-tauri/src/main.rs');
  const ui=read('ui/app.js');
  assert.match(native,/listen_native_tab_favicon/);
  assert.match(native,/add_FaviconChanged/);
  assert.match(native,/favicon:if t\.secret_id\.is_some\(\)\{None\}/);
  assert.match(ui,/tab\.favicon/);
  assert.match(ui,/function faviconKey\(/);
  assert.match(ui,/const project=url\.hostname\.endsWith\('\.github\.io'\)/);
  assert.doesNotMatch(ui,/\.charAt\(0\)\.toUpperCase\(\)/);
  assert.match(ui,/site-icon-fallback/);
  assert.match(read('ui/styles.css'),/\.tabs \.site-icon-fallback svg/);
});

test('tab strip scrolls to right for new foreground tabs only',()=>{
  const ui=read('ui/app.js');
  assert.match(ui,/isNewForegroundTab/);
  assert.match(ui,/!previouslyKnown\.has\(opened\.id\)&&!opened\.openerId/);
  assert.match(ui,/tabs\.scrollLeft=tabs\.scrollWidth/);
  assert.match(read('native/desktop/src-tauri/src/main.rs'),/let background = name == "new-background-url"/);
});

test('Minternet disables vendor-native bottom-left status bar in every Windows webview',()=>{
  const native=read('native/desktop/src-tauri/src/main.rs');
  assert.match(native,/fn suppress_native_vendor_status_bar/);
  assert.match(native,/settings\.SetIsStatusBarEnabled\(false\)/);
  assert.match(native,/suppress_native_vendor_status_bar\(&created\)/);
  assert.match(native,/suppress_native_vendor_status_bar\(&chrome_webview\)/);
  assert.match(native,/suppress_native_vendor_status_bar\(&view\)/);
  // Keep normal site interactions and built-in download support functional.
  assert.doesNotMatch(native,/SetAreDefaultContextMenusEnabled\(false\)/);
});
