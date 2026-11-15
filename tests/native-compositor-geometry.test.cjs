'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const get=name=>fs.readFileSync(path.join(root,name),'utf8');
test('real Windows child HWND is measured independently from cached Tauri bounds',()=>{
  const src=get('native/desktop/src-tauri/src/native_surface.rs');
  assert.match(src,/controller\.ParentWindow\(&mut hwnd\)/);
  assert.match(src,/GetWindowRect\(hwnd,&mut rect\)/);
  assert.match(src,/ScreenToClient\(parent,&mut point\)/);
  assert.match(src,/controller\.Bounds\(&mut viewport\)/);
  assert.match(src,/SetWindowPos\(hwnd,None,x,y,w,h,SWP_NOACTIVATE\|SWP_NOZORDER\)/);
  assert.match(src,/controller\.SetBounds\(RECT\{/);
  assert.match(src,/NotifyParentWindowPositionChanged/);
  assert.match(src,/if fixed\{/);
  assert.doesNotMatch(src,/location\.reload|clear_all_browsing_data|view\.hide\(|view\.navigate\(/);
});
test('reconciliation runs even when cached logical bounds are already correct',()=>{
  const src=get('native/desktop/src-tauri/src/main.rs');
  const start=src.indexOf('fn reconcile_visible_child_bounds(');
  const stop=src.indexOf('fn schedule_startup_bounds_reconciliation(',start);
  const part=src.slice(start,stop);
  assert.match(part,/native_surface::verify\(view,parent_hwnd/);
  assert.match(part,/window\.hwnd\(\)/);
  assert.match(part,/native_surface::verify[\s\S]*if let Some\(chrome\)/);
  assert.match(part,/notify_native_compositor\(view\)/);
});
test('CI corrupts real native rectangle and viewport instead of only Tauri coordinates',()=>{
  const src=get('native/desktop/src-tauri/src/main.rs');
  const native=get('native/desktop/src-tauri/src/native_surface.rs');
  const win=get('.github/workflows/native-windows.yml');
  assert.match(src,/native_surface::smoke\(&view/);
  assert.match(native,/wanted\[0\]\+192/);
  assert.match(native,/wanted\[1\]\+112/);
  assert.match(native,/actual\(hwnd,expected_parent\)/);
  assert.match(native,/viewport_right/);
  assert.match(win,/minternet-native-surface-/);
  assert.match(win,/Real Win32\/WebView2 compositor repair failed/);
  assert.match(win,/Native child HWND and WebView2 controller were not verified/);
});
test('ChatGPT no longer auto reloads while its layout or compositor is white',()=>{
  const src=get('native/desktop/src-tauri/src/main.rs');
  const section=src.slice(src.indexOf('if event.url().host_str()==Some("chatgpt.com")'),
    src.indexOf('// CI: write/read a persistent cookie',src.indexOf('if event.url().host_str()==Some("chatgpt.com")')));
  assert.doesNotMatch(section,/location\.reload\(\)/);
  assert.match(section,/minternet-surface\.invalid\/__repair/);
  assert.match(src,/background_color\(tauri::webview::Color\(13,17,29,255\)\)/);
  assert.match(src,/url\.as_str\(\)=="https:\/\/minternet-surface\.invalid\/__repair"/);
});
