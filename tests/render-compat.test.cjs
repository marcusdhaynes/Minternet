'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const get=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
test('hardware rendering remains default; opt-in compatibility happens before any WebView2 controller',()=>{
 const src=get('native/desktop/src-tauri/src/render_compat.rs');
 const main=get('native/desktop/src-tauri/src/main.rs');
 assert.match(src,/decode\(bytes:&\[u8\]\)->bool/);
 assert.match(src,/--disable-gpu/);
 assert.match(src,/fn defaults_to_hardware_acceleration/);
 assert.match(src,/render-compat\.v1\.json/);
 assert.match(main,/render_compat::configure\(app\.handle\(\)\)/);
 assert.ok(main.indexOf('render_compat::configure(app.handle())') <
   main.indexOf('window.add_child('));
});
test('user controls rendering and repairs surface without reloading or profile reset',()=>{
 const html=get('ui/index.html'),js=get('ui/render-compat-ui.js');
 const main=get('native/desktop/src-tauri/src/main.rs');
 assert.match(html,/Hardware Accelerated \(Recommended\)/);
 assert.match(html,/Compatibility Mode \(Software\)/);
 assert.match(html,/id="renderSurfaceRepair"/);
 assert.match(js,/render-compat-get/);
 assert.match(js,/render-compat-set/);
 assert.match(js,/render-surface-repair/);
 assert.match(main,/schedule_surface_restore\(&app\)/);
 assert.doesNotMatch(js,/localStorage\.clear|cookie|reset-profile|window\.location\.reload/);
});
test('blank recovery smoke must verify a document body before blanking',()=>{
 const main=get('native/desktop/src-tauri/src/main.rs');
 assert.match(main,/document\.readyState!=='complete'/);
 assert.match(main,/\(document\.body\.innerText\|\|''\)\.trim\(\)\.length<25/);
});
