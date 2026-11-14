'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../native/desktop/src-tauri/src/main.rs'),'utf8');
function section(a,b){const i=source.indexOf(a);const j=source.indexOf(b,i+a.length);assert.ok(i>=0&&j>i,'Missing '+a);return source.slice(i,j);}
test('01 inspect physical child rectangle instead of trusting cached logical dimensions',()=>{
 const s=section('fn reconcile_visible_child_bounds(', 'fn schedule_startup_bounds_reconciliation(');
 assert.match(s,/view\.position\(\),view\.size\(\)/);
 assert.match(s,/expected\.iter\(\)\.zip\(actual\.iter\(\)\)/);
});
test('02 correct off-center native WebView2 only when it physically differs',()=>{
 const s=section('fn reconcile_visible_child_bounds(', 'fn schedule_startup_bounds_reconciliation(');
 assert.match(s,/\.abs\(\)>3\.0/);
 assert.match(s,/view\.set_bounds\(rectangle\)/);
 assert.match(s,/notify_native_compositor\(view\)/);
 assert.doesNotMatch(s,/view\.navigate\(|view\.hide\(|view\.close\(/);
});
test('03 check child width, height, horizontal and vertical offsets',()=>{
 const s=section('fn reconcile_visible_child_bounds(', 'fn schedule_startup_bounds_reconciliation(');
 assert.match(s,/let expected=\[x\*scale,y\*scale,w\*scale,h\*scale\]/);
 assert.match(s,/let actual=\[pos\.x as f64,pos\.y as f64,size\.width as f64,size\.height as f64\]/);
});
test('04 startup verifies sizes after Windows finalizes maximize or restore',()=>{
 const s=section('fn schedule_startup_bounds_reconciliation(', 'fn start_geometry_smoke(');
 assert.match(s,/200u64,550,1100/);
 assert.match(s,/invalidate_layout\(&handle\)/);
 assert.match(s,/refresh_layout\(&handle\)/);
 assert.match(s,/reconcile_visible_child_bounds\(&handle\)/);
});
test('05 window size and focus events also repair drift, without page reload',()=>{
 const s=section('window.on_window_event(move |event|', '.run(tauri::generate_context!())');
 assert.match(s,/WindowEvent::Resized/);
 assert.match(s,/WindowEvent::Focused\(true\)/);
 assert.ok((s.match(/reconcile_visible_child_bounds\(/g)||[]).length>=2);
});
test('06 homepage chrome and visible split panes are independently checked',()=>{
 const s=section('fn reconcile_visible_child_bounds(', 'fn schedule_startup_bounds_reconciliation(');
 assert.match(s,/get_webview\("chrome"\)/);
 assert.match(s,/visible_split\(app\)/);
 assert.match(s,/split_rect\(index,count,width,available,top,ratios\.0,ratios\.1\)/);
});
test('07 only repaired geometry triggers native compositor notification',()=>{
 const s=section('fn reconcile_visible_child_bounds(', 'fn schedule_startup_bounds_reconciliation(');
 const guard=s.indexOf('if expected.iter().zip(actual.iter())');
 const repaint=s.indexOf('notify_native_compositor(view)');
 assert.ok(guard>=0&&repaint>guard);
});
test('08 maximized native smoke deliberately reproduces off-center white rectangle geometry',()=>{
 const s=section('fn start_geometry_smoke(', 'fn display_active(');
 assert.match(s,/window\.maximize\(\)/);
 assert.match(s,/LogicalPosition::new\(53\.0,top\)/);
 assert.match(s,/reconcile_visible_child_bounds\(&handle\)/);
 assert.match(s,/minternet-geometry-/);
});
test('09 runtime geometry smoke emits a clear failure instead of silent success',()=>{
 const s=section('fn start_geometry_smoke(', 'fn display_active(');
 assert.match(s,/if good \{"ok"\}else\{"failed"\}/);
 assert.match(s,/expected=\{expected:\?\}, actual=\{actual:\?\}/);
});
test('10 regular users never receive the test-only forced geometry disturbance',()=>{
 const s=section('schedule_startup_bounds_reconciliation(app.handle());', 'portable_updater::confirm_startup()');
 assert.match(s,/if geometry_smoke/);
 assert.match(s,/start_geometry_smoke\(app\.handle\(\),id\)/);
});
