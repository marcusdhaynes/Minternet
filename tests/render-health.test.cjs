'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=(p)=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
test('WebView2 browser and renderer failures are observed rather than treated as page loads',()=>{
 const src=read('native/desktop/src-tauri/src/render_health.rs');
 const main=read('native/desktop/src-tauri/src/main.rs');
 assert.match(src,/ProcessFailedEventHandler::create/);
 assert.match(src,/add_ProcessFailed\(&process_handler/);
 assert.match(src,/NavigationCompletedEventHandler::create/);
 assert.match(src,/args\.IsSuccess\(&mut success\)/);
 assert.match(src,/COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED/);
 assert.match(src,/COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED/);
 assert.match(src,/recoverable_failure\(kind\)/);
 assert.match(main,/render_health::attach\(app,id,&created\)/);
});
test('a truly blank SPA gets one bounded recovery without clearing user data',()=>{
 const src=read('native/desktop/src-tauri/src/render_health.rs');
 const main=read('native/desktop/src-tauri/src/main.rs');
 assert.match(src,/BLANK_PROBE/);
 assert.match(src,/document\.readyState/);
 assert.match(src,/document\.visibilityState/);
 assert.match(src,/visibleText<25/);
 assert.match(src,/hasUsableEditor/);
 assert.match(src,/if flags!=127\{hits\.store\(0,Ordering::Release\);return;\}/);
 assert.match(src,/if !smoke && hits\.fetch_add\(1,Ordering::AcqRel\)==0\{return;\}/);
 assert.match(src,/smoke_stage\(&format!\("probe-flags:\{flags\}"\)\)/);
 assert.match(src,/let entry=map\.entry\(id\)/);
 assert.match(src,/Some\(Recovery::Reload\)/);
 assert.match(src,/Some\(Recovery::Recreate\)/);
 assert.match(main,/recover_stalled_site_if_url/);
 assert.match(main,/cache\.shown\.remove\(label\)/);
 assert.match(main,/tab\.view=None/);
 assert.match(main,/navigate_tab\(app,id,Some\(target\),false\)/);
 const probe=src.slice(src.indexOf('pub const BLANK_PROBE'),src.indexOf('// A failed renderer'));
 assert.doesNotMatch(probe,/clear_all_browsing_data|reset_profile|remove_dir_all|document\.cookie|localStorage/);
});
test('blank UI recovery does not accidentally destroy a populated editor or GPU process',()=>{
 const src=read('native/desktop/src-tauri/src/render_health.rs');
 assert.match(src,/if\(!hasUsableEditor\)bits\|=8/);
 assert.match(src,/if\(!busy\)bits\|=16/);
 assert.match(src,/if\(!media\)bits\|=32/);
 assert.match(src,/assert!\(!recoverable_failure\(COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED\)\)/);
});
test('real Windows CI intentionally blanks HTTPS content and verifies recovery',()=>{
 const src=read('native/desktop/src-tauri/src/main.rs');
 const win=read('.github/workflows/native-windows.yml');
 assert.match(src,/BLANK_PHASE:std::sync::atomic::AtomicU8/);
 assert.match(src,/BLANK_PHASE\.compare_exchange\(0,1/);
 assert.match(src,/location\.hostname==='example\.com'/);
 assert.match(src,/document\.readyState==='complete'/);
 assert.match(src,/document\.body\?\.innerText\|\|''/);
 assert.match(src,/document\.body\.replaceChildren\(\)/);
 assert.match(src,/minternet-blank-render-.*\.ok/);
 assert.match(win,/--minternet-blank-render-smoke/);
 assert.match(win,/A real blank native WebView2 document was not restored/);
});
test('render health log contains events but no website URL, form data or screenshots',()=>{
 const src=read('native/desktop/src-tauri/src/render_health.rs');
 assert.match(src,/render-health\.log/);
 assert.match(src,/reason=\{reason\}/);
 assert.doesNotMatch(src,/format!\(".*url=|CapturePreview|document\.body\.innerHTML/);
});

test('healthy blank DOM reloads its existing WebView2 controller once before full reconstruction',()=>{
  const main=read('native/desktop/src-tauri/src/main.rs');
  const health=read('native/desktop/src-tauri/src/render_health.rs');
  const recovery=main.slice(main.indexOf('fn recover_stalled_site_if_url('),
     main.indexOf('fn is_real_page_url('));
  assert.match(recovery,/if reason=="blank-document"/);
  assert.match(recovery,/if view.reload\(\).is_ok\(\)/);
  assert.ok(recovery.indexOf('view.reload().is_ok()') < recovery.indexOf('let _=view.close()'));
  assert.match(recovery,/render_health::claim\(id,&current\.0,reason\)/);
  assert.match(health,/"reloaded"/);
  assert.match(main,/proof-flags:\{flags\}/);
});

test('active page is checked beyond startup and completed navigations',()=>{
 const main=read('native/desktop/src-tauri/src/main.rs');
 const watchdog=main.slice(main.indexOf('fn schedule_startup_bounds_reconciliation('),
   main.indexOf('fn schedule_page_bounds_reconciliation('));
 assert.match(watchdog,/loop \{/);
 assert.match(watchdog,/reconcile_visible_child_bounds\(&task\)/);
 assert.match(watchdog,/render_health::schedule_blank_probe\(&task,id,url\.clone\(\)\)/);
 assert.match(watchdog,/render_visual::schedule\(&task,id,url,800\)/);
 assert.match(watchdog,/!tab\.loading && is_real_page_url\(&tab\.url\)/);
});
test('real GPU process loss rebinds the compositor without discarding user data',()=>{
 const health=read('native/desktop/src-tauri/src/render_health.rs');
 const surface=read('native/desktop/src-tauri/src/native_surface.rs');
 const gpu=health.slice(health.indexOf('else if kind==COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED'),
   health.indexOf('Ok(())',health.indexOf('else if kind==COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED')));
 assert.match(gpu,/force_compositor_rebind\(&view\)/);
 assert.match(gpu,/schedule_surface_restore\(&main\)/);
 assert.doesNotMatch(gpu,/view\.reload\(|view\.close\(|remove_dir_all/);
 assert.match(surface,/fn force_compositor_rebind\(/);
 assert.match(surface,/controller\.SetBounds\(nudge\)/);
 assert.match(surface,/controller\.SetBounds\(original\)/);
});
