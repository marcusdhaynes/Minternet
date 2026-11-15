'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('Every successful native platform build is saved under a distinct permanent GitHub Release tag',()=>{
  const workflow=read('.github/workflows/publish-current-portable.yml');
  for(const platform of [
    'Minternet Windows portable single EXE (under 50 MB)',
    'Native Minternet macOS and Linux (under 50 MB)',
    'Native Minternet Android APK (< 50 MB)',
    'Native Minternet iOS simulator build (under 50 MB)'
  ]) assert.ok(workflow.includes(platform),platform);
  assert.match(workflow,/workflow_run:/);
  assert.match(workflow,/conclusion == 'success'/);
  assert.match(workflow,/TAG="minternet-build-\$RUN_ID"/);
  assert.match(workflow,/gh release create "\$TAG"/);
  assert.match(workflow,/SHA256SUMS\.txt/);
  assert.match(workflow,/--target "\$SHA"/);
  assert.match(workflow,/gh api "repos\/\$GITHUB_REPOSITORY\/releases\/tags\/\$TAG"/);
  assert.doesNotMatch(workflow,/--clobber/);
  // Legacy draft recovery is allowed, but completed releases and their
  // existing executable assets must never be overwritten.
  assert.match(workflow,/matching_draft=.*draft==true/);
  assert.match(workflow,/releases\/\$draft_id" -F draft=false/);
  assert.doesNotMatch(workflow,/--draft --prerelease/);
  assert.ok(workflow.includes('if published=$(gh api "repos/$GITHUB_REPOSITORY/releases/tags/minternet-build-$run_id" 2>/dev/null); then'));
  assert.match(workflow,/gh release edit "\$TAG" --draft=false/);
  assert.doesNotMatch(workflow,/LATEST=.*gh run list/);
});

test('No WebView2 controller destruction or password JS injection occurs directly in its callback',()=>{
  const main=read('native/desktop/src-tauri/src/main.rs');
  const callback=main.slice(main.indexOf('fn check_idle_tabs('),main.indexOf('fn navigate_tab(')>0?main.indexOf('fn navigate_tab('):undefined);
  assert.match(main,/schedule_surface_restore\(&for_load\)/);
  assert.match(main,/fill_saved_credential\(&task,id,false,None\)/);
  assert.match(main,/std::thread::sleep\(Duration::from_millis\(40\)\)/);
  assert.match(main,/if let Some\(view\)=task\.get_webview\(&label\)\{let _=view\.close\(\);\}/);
  assert.match(main,/schedule_session_save\(app\)/);
  assert.match(main,/SessionSaveQueued\(AtomicBool\)/);
  // Only one fill is scheduled per load (extra direct call was a regression).
  const loadStart=main.indexOf('.on_page_load(move |view, event| {',main.indexOf('fn create_webview('));
  const load=main.slice(loadStart,main.indexOf('.on_document_title_changed(',loadStart));
  assert.equal((load.match(/fill_saved_credential\(/g)||[]).length,1);
});

test('Crash recovery preserves tabs and does not automatically load a previously crashing page',()=>{
  const main=read('native/desktop/src-tauri/src/main.rs');
  assert.match(main,/fn start_crash_guard\(/);
  assert.match(main,/fn clear_crash_guard\(/);
  assert.match(main,/install_panic_diagnostics\(app\.handle\(\)\)/);
  assert.match(main,/if previous_crash \{/);
  assert.match(main,/b\.active_id=0/);
  assert.match(main,/clear_crash_guard\(&handle\)/);
  assert.match(main,/Saved tabs were recovered from an interrupted session/);
  assert.doesNotMatch(main,/Previous session ended unexpectedly/);
  const lifecycle=read('native/desktop/src-tauri/src/session_lifecycle.rs');
  assert.match(lifecycle,/minternet-running\.v2\./);
  assert.match(lifecycle,/scan_prior\(dir,pid,is_running\)/);
  assert.match(lifecycle,/legacy update marker/i);
  const updater=read('native/desktop/src-tauri/src/portable_updater.rs');
  assert.match(updater,/super::clear_crash_guard\(&handle\);\s*handle\.exit\(0\)/);
  assert.match(main,/--minternet-cookie-set-smoke/);
  assert.match(main,/--minternet-cookie-check-smoke/);
  assert.match(main,/minternet_ci_profile_v1/);
  const win=read('.github/workflows/native-windows.yml');
  assert.match(win,/EXE replacement did not retain WebView2 cookie and localStorage/);
  assert.match(win,/real WebView2 cookie \+ localStorage survived portable EXE replacement/);
  assert.doesNotMatch(main,/panic payloads in logs.*writeln!\([^;]*info\.payload\(/s);
});

test('Browser defaults to low-churn idle cleanup, bounded session polling and asynchronous favicon decode',()=>{
  const chrome=read('ui/app.js');
  assert.match(chrome,/const n=raw===null\?10:Number\(raw\)/);
  assert.match(chrome,/},30000\)/);
  assert.match(chrome,/},6000\)/);
  assert.match(chrome,/sessionRefreshPending/);
  assert.match(chrome,/unloadPending/);
  assert.match(chrome,/img\.decoding='async'/);
  assert.doesNotMatch(chrome,/img\.decoding='sync'/);
  const groups=read('ui/tab-group-ui.js');
  assert.match(groups,/updated!==lastStoredGroupJson/);
});
