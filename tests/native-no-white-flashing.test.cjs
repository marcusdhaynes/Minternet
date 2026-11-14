'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');
const native=read('native/desktop/src-tauri/src/main.rs');
const css=read('ui/styles.css');
const workflow=read('.github/workflows/native-windows.yml');
function block(start,end){
  const a=native.indexOf(start);
  assert.notEqual(a,-1,'Missing function '+start);
  const b=native.indexOf(end,a+start.length);
  assert.notEqual(b,-1,'Missing next function '+end);
  return native.slice(a,b);
}
test('active WebView2 is never toggled off/on to recover its paint surface',()=>{
  const restore=block('fn restore_visible_surfaces(','fn display_active(');
  assert.doesNotMatch(restore,/\.hide\s*\(/,'Do not hide the active renderer during recovery');
  assert.doesNotMatch(restore,/\.show\s*\(/,'Do not show repeatedly during every window move');
  assert.match(restore,/notify_native_compositor\(&view\)/);
  assert.doesNotMatch(restore,/invalidate_layout\(app\)/,
    'No forced full resize/layout every focus and window move');
});
test('opaque dark window and website backgrounds are established before first paint',()=>{
  assert.match(native,/WindowBuilder::new\(app, "main"\)\s*\.background_color\(tauri::window::Color\(10,15,27,255\)\)/);
  assert.match(native,/WebviewBuilder::new\(label\.clone\(\),url\)\s*\.background_color\(tauri::webview::Color\(10,15,27,255\)\)/);
  assert.match(native,/WebviewBuilder::new\("chrome",WebviewUrl::App\("index\.html"\.into\(\)\)\)[\s\S]{0,400}?\.background_color\(tauri::webview::Color\(0,0,0,0\)\)/);
  assert.match(css,/:root\s*\{[^}]*background:\s*#0a0f1b/s);
});
test('flash prevention preserves regular tab changes and reflows',()=>{
  const switching=block('fn display_active(','fn is_real_page_url(');
  assert.match(switching,/state\.shown==targets/);
  assert.match(switching,/for label in to_hide/);
  assert.match(switching,/for label in to_show/);
  assert.match(native,/tauri::WindowEvent::Resized/);
  assert.match(native,/tauri::WindowEvent::Focused\(true\)/);
  assert.match(native,/tauri::WindowEvent::Moved/);
});
test('crash recovery does not clear profiles or stored login sessions',()=>{
  const crash=block('fn attach_webview_process_recovery(','fn create_webview(');
  assert.doesNotMatch(crash,/clear_(cookies|storage)|remove_dir_all|reset_profile/);
  assert.match(crash,/schedule_surface_restore/);
  assert.match(crash,/record\.1>=2/,
    'Crash recovery must stop after repeated failures instead of flashing indefinitely');
  assert.match(crash,/Duration::from_secs\(60\)/);
  assert.match(crash,/Automatic reload was stopped to prevent flashing/);
});
test('no-flash regression is included in the Windows workflow',()=>{
  assert.match(workflow,/native-no-white-flashing\.test\.cjs/);
});
