'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const root=join(__dirname,'..');
const get=path=>readFileSync(join(root,path),'utf8');
const main=get('native/desktop/src-tauri/src/main.rs');
const visual=get('native/desktop/src-tauri/src/render_visual.rs');
const win=get('.github/workflows/native-windows.yml');
function chunk(start,end){
 const a=main.indexOf(start),b=main.indexOf(end,a+start.length);
 assert.ok(a>=0&&b>a,'section missing: '+start);return main.slice(a,b);
}
test('reopens last active tab on normal and interrupted launches, not an empty dashboard',()=>{
 const startup=chunk('restore_session(app.handle());','let builder = WindowBuilder::new(app, "main")');
 assert.doesNotMatch(startup,/active_id\s*=\s*0/);
 const launch=chunk('if let Some((address,_private))=new_window_target','window.on_window_event(move |event|');
 assert.match(launch,/activated\(app\.handle\(\)\)/);
 assert.match(main,/Restoring your last active tab after an interrupted session/);
 assert.doesNotMatch(main,/Select a tab to reopen it/);
});
test('saved active index maps to the actual surviving tab, not the filtered array position',()=>{
 const saved=chunk('fn save_session(', 'fn snapshot(app:');
 assert.match(saved,/let saved_active=data\.get\("active"\)/);
 assert.match(saved,/for \(saved_index,record\) in saved\.iter\(\)\.enumerate\(\)/);
 assert.match(saved,/if Some\(saved_index\)==saved_active\{restored_active=Some\(id\);\}/);
 assert.match(saved,/browser\.active_id=restored_active/);
 assert.match(saved,/\.rev\(\)\.find\(\|t\|t\.url!=HOME\)/);
});
test('never writes private or secret tab locations to the persisted session',()=>{
 const saved=chunk('fn save_session(', 'fn snapshot(app:');
 assert.match(saved,/!tab\.private && !tab\.tor &&\s*tab\.secret_id\.is_none\(\)/);
 assert.match(saved,/!t\.private && !t\.tor && t\.secret_id\.is_none\(\)/);
 assert.match(saved,/tab\.sync_id/);
 assert.doesNotMatch(saved,/document\.cookie|localStorage/);
});
test('visual white-surface check is independent of DOM health and survives blank navigation',()=>{
 assert.match(main,/mod render_visual/);
 assert.match(main,/render_visual::schedule\(&for_load,id/);
 assert.match(main,/render_visual::schedule\(&task,id,url,800\)/);
 assert.match(visual,/CapturePreviewCompletedHandler::create/);
 assert.match(visual,/COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG/);
 assert.match(visual,/fully_white\(&pixels\)/);
 assert.match(visual,/stage==1[\s\S]*force_compositor_rebind/);
 assert.match(visual,/stage>=2[\s\S]*SAFE_TO_RESTART/);
 assert.match(visual,/white_seen\(id,&url,white\)/);
 assert.match(visual,/Duration::from_secs\(18\)/);
 const cargo=get('native/desktop/src-tauri/Cargo.toml');
 assert.match(cargo,/png = "0\.17"/);
 assert.match(cargo,/Win32_System_Com_StructuredStorage/);
});
test('no capture pixels or visited URLs are persisted by the visual checker',()=>{
 assert.doesNotMatch(visual,/fs::write|std::fs::write|OpenOptions|document\.cookie|localStorage/);
 assert.match(visual,/MAX_CAPTURE_BYTES/);
 assert.match(visual,/SAFE_TO_RESTART/);
 assert.match(visual,/tab\.private\|\|tab\.tor\|\|tab\.secret_id\.is_some\(\)/);
});
test('Windows CI injects a fully white overlay over healthy HTTPS DOM and requires pixel recovery',()=>{
 assert.match(main,/minternet-ci-white-mask/);
 assert.match(main,/render_visual::smoke_confirmed\(\)/);
 assert.match(main,/localStorage\.getItem\('minternet_visual_ci'\)/);
 assert.match(win,/--minternet-white-surface-smoke/);
 assert.match(win,/A real HTTPS page covered with an all-white compositor frame did not recover/);
});
test('session uses validated primary, temporary and backup checkpoints after updates',()=>{
 const checkpoint=main.slice(main.indexOf('fn read_session_data('),
   main.indexOf('fn save_session('));
 assert.match(checkpoint,/path\.with_extension\("tmp"\)/);
 assert.match(checkpoint,/path\.with_extension\("bak"\)/);
 assert.match(checkpoint,/serde_json::from_slice::<Value>/);
 assert.match(main,/mod session_checkpoint_tests/);
 assert.match(main,/browser\.tab_limit=0;/);
 assert.match(main,/browser\.tab_limit=configured_limit;/);
});
test('Windows release is gated by actual native executable and Rust tests',()=>{
 assert.match(win,/npm run build/);
 assert.match(win,/cargo test --manifest-path src-tauri\/Cargo\.toml/);
 assert.match(win,/--minternet-blank-render-smoke/);
 assert.match(win,/--minternet-geometry-smoke/);
 assert.match(win,/Publish verified portable EXE as a GitHub Release/);
});

test('visual recovery diagnostics use valid parent module entrypoints',()=>{
 assert.doesNotMatch(visual,/startup_super/);
 assert.match(visual,/super::startup_smoke_stage\("painted-frame-dom-ready"\)/);
 assert.match(visual,/super::white_smoke_stage\("preview-scheduled"\)/);
});

test('Windows only builds newest main commit and retains Rust compilation cache on late test failure',()=>{
 assert.match(win,/group: minternet-windows-\$\{\{ github\.ref \}\}/);
 assert.match(win,/cancel-in-progress: true/);
 assert.match(win,/cache-on-failure: true/);
});
test('visual recovery proof requires actual repaint and retained browser storage',()=>{
 assert.match(visual,/pub fn smoke_repainted\(\)->bool/);
 assert.match(visual,/VISUAL_SMOKE_REPAINTED\.store\(true/);
 assert.match(main,/render_visual::smoke_repainted\(\)/);
 assert.match(main,/const cookie=document\.cookie\.includes\('minternet_visual_ci=retained'\)/);
 assert.match(main,/const storage=localStorage\.getItem\('minternet_visual_ci'\)==='retained'/);
 assert.match(main,/if flags==63/);
 assert.match(main,/reconstruct-unusable-page/);
 assert.match(main,/recover_stalled_site_if_url\(&closer,id,&expected,"visual-white"\)/);
 assert.match(main,/proof-cookie-missing/);
 assert.match(main,/proof-storage-missing/);
});
