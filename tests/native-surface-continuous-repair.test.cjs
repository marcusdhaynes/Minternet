'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const load=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');

test('real HWND client geometry drives layout rather than stale cached inner size',()=>{
  const native=load('native/desktop/src-tauri/src/native_surface.rs');
  const main=load('native/desktop/src-tauri/src/main.rs');
  assert.match(native,/GetClientRect\(HWND\(parent as _\),&mut rect\)/);
  assert.match(native,/pub fn parent_client_size\(parent:isize\)/);
  assert.match(main,/fn dimensions\(window: &tauri::Window\)/);
  assert.match(main,/native_surface::parent_client_size\(hwnd\.0 as isize\)/);
  assert.match(main,/size=tauri::PhysicalSize::new\(w,h\)/);
  assert.match(main,/physical=tauri::PhysicalSize::new\(w,h\)/);
});

test('native recovery is independent of a failing Tauri geometry read',()=>{
  const main=load('native/desktop/src-tauri/src/main.rs');
  const part=main.slice(main.indexOf('fn reconcile_visible_child_bounds('),
    main.indexOf('fn schedule_startup_bounds_reconciliation('));
  assert.match(part,/if let \(Ok\(pos\),Ok\(size\)\)=\(view\.position\(\),view\.size\(\)\)/);
  assert.match(part,/native_surface::verify\(view,parent_hwnd/);
  assert.doesNotMatch(part,/let \(Ok\(pos\),Ok\(size\)\)=\(view\.position\(\),view\.size\(\)\) else\{return\}/);
});

test('continuous watchdog detects late native drift with no page reload',()=>{
  const main=load('native/desktop/src-tauri/src/main.rs');
  const section=main.slice(main.indexOf('fn schedule_startup_bounds_reconciliation('),
    main.indexOf('fn start_geometry_smoke('));
  assert.match(section,/loop \{/);
  assert.match(section,/Duration::from_secs\(if cycles<60\{2\}else\{12\}\)/);
  assert.match(section,/original\.get_window\("main"\)\.is_none\(\)\{break;\}/);
  assert.match(section,/reconcile_visible_child_bounds\(&task\)/);
  assert.doesNotMatch(section,/view\.reload\(|view\.hide\(|view\.close\(|clear_all_browsing_data/);
});

test('CI verifies automatic delayed native HWND and COM controller repair',()=>{
  const main=load('native/desktop/src-tauri/src/main.rs');
  const native=load('native/desktop/src-tauri/src/native_surface.rs');
  const pipeline=load('.github/workflows/native-windows.yml');
  assert.match(main,/native_surface::watchdog_disturb\(&view/);
  assert.match(main,/native_surface::watchdog_check\(&view/);
  assert.match(native,/wanted\[0\]\+163,wanted\[1\]\+81/);
  assert.match(native,/minternet-watchdog-disturbed-/);
  assert.match(native,/minternet-watchdog-\{\}\.\{\}/);
  assert.match(pipeline,/Automatic watchdog did not repair delayed native white rectangle/);
  assert.match(pipeline,/Updated EXE failed its automatic late compositor watchdog/);
  assert.match(pipeline,/minternet-watchdog-\$\(\$p\.Id\)/);
});

test('verified displaced host rebinds compositor; healthy hosts are never force-resized',()=>{
  const native=load('native/desktop/src-tauri/src/native_surface.rs');
  assert.match(native,/if host_moved && !viewport_resized && w>16/);
  assert.match(native,/right:w-1,bottom:h/);
  assert.match(native,/controller.SetBounds\(RECT\{/);
  assert.match(native,/NotifyParentWindowPositionChanged/);
});
test('manual surface repair rebinds only visible website WebView2 without navigation',()=>{
  const main=load('native/desktop/src-tauri/src/main.rs');
  const src=main.slice(main.indexOf('if name=="render-surface-repair"'),
    main.indexOf('if matches!(name.as_str(),"site-media-get"',main.indexOf('if name=="render-surface-repair"')));
  assert.match(src,/native_surface::force_compositor_rebind\(&view\)/);
  assert.match(src,/reconcile_visible_child_bounds\(&app\)/);
  assert.match(src,/visible_split\(&app\)/);
  assert.doesNotMatch(src,/view\.reload\(|view\.navigate\(|view\.hide\(|view\.close\(/);
  const native=load('native/desktop/src-tauri/src/native_surface.rs');
  assert.match(native,/pub fn force_compositor_rebind\(view:&tauri::Webview\)/);
  assert.match(native,/controller.SetBounds\(nudge\)/);
  assert.match(native,/controller.SetBounds\(original\)/);
});
