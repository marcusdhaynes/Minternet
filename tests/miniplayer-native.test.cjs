'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');

test('media toolbar uses the native Windows Open File dialog on a normal button click',async()=>{
  const html=read('ui/index.html'),launcher=read('ui/media-launch.js');
  const native=read('native/desktop/src-tauri/src/main.rs');
  const cargo=read('native/desktop/src-tauri/Cargo.toml');
  assert.ok(html.indexOf('id="mediaPlayerButton"')<html.indexOf('id="tor"'));
  assert.match(html,/<button id="mediaPlayerButton"/);
  assert.doesNotMatch(html,/id="minternetMediaPicker"/);
  assert.doesNotMatch(launcher,/createObjectURL|picker\.click\(\)|getElementById\('minternetMediaPicker'\)/);
  assert.match(native,/if name=="media-player-pick"/);
  assert.match(native,/\.set_parent\(&main\)\.blocking_pick_file\(\)/);
  assert.match(native,/\.plugin\(tauri_plugin_dialog::init\(\)\)/);
  assert.match(cargo,/tauri-plugin-dialog = "2"/);
  new vm.Script(launcher);
});
test('click calls native IPC exactly once and cancel leaves the player closed',async()=>{
  const src=read('ui/media-launch.js');
  const handlers={},calls=[];
  const button={
    disabled:false,
    setAttribute(){},removeAttribute(){},
    addEventListener(name,handler){handlers[name]=handler}
  };
  const fakeWindow={__TAURI__:{core:{invoke:async(name,payload)=>{
    calls.push({name,payload});
    return {ok:true,cancelled:true};
  }}}};
  const fakeDocument={getElementById:id=>id==='mediaPlayerButton'?button:null};
  vm.runInNewContext(src,{window:fakeWindow,document:fakeDocument,setTimeout:()=>{}});
  assert.equal(typeof handlers.click,'function');
  await handlers.click();
  assert.equal(calls.length,1);
  assert.equal(calls[0].name,'browser_action');
  assert.equal(calls[0].payload.name,'media-player-pick');
  assert.equal(button.disabled,false);
});
test('errors from the native Windows dialog are visible to the user',async()=>{
  const src=read('ui/media-launch.js');
  const handlers={};
  const button={disabled:false,setAttribute(){},removeAttribute(){},
    addEventListener(n,fn){handlers[n]=fn}};
  const message={id:'minternetMediaStatus',textContent:'',hidden:true};
  const root={
    getElementById:id=>id==='mediaPlayerButton'?button:id==='minternetMediaStatus'?message:null
  };
  const fakeWindow={__TAURI__:{core:{invoke:async()=>{
    throw new Error('Windows file picker failed');
  }}}};
  vm.runInNewContext(src,{window:fakeWindow,document:root,setTimeout:()=>{}});
  await handlers.click();
  assert.match(message.textContent,/Windows file picker failed/);
  assert.equal(message.hidden,false);
  assert.equal(button.disabled,false);
});
test('native path picker gives scoped byte-range media URL, without file copies',()=>{
  const rust=read('native/desktop/src-tauri/src/main.rs');
  const conf=JSON.parse(read('native/desktop/src-tauri/tauri.conf.json'));
  const cargo=read('native/desktop/src-tauri/Cargo.toml');
  const player=read('ui/media-player.js');
  const html=read('ui/media-player.html');
  assert.equal(conf.app.security.assetProtocol.enable,true);
  assert.deepEqual(conf.app.security.assetProtocol.scope,[]);
  assert.match(conf.app.security.csp,/media-src 'self' blob: asset: http:\/\/asset\.localhost/);
  assert.match(cargo,/protocol-asset/);
  assert.match(rust,/state::<tauri::scope::Scopes>\(\)\.allow_file\(&path\)/);
  assert.match(rust,/player\.convert_file_src\(&path,None\)/);
  assert.match(rust,/if name=="media-player-current"/);
  assert.match(rust,/if name=="media-player-pick"/);
  assert.match(player,/asset\.localhost/);
  assert.match(player,/media-player-current/);
  assert.match(player,/startDragging/);
  assert.match(player,/sizeToVideo/);
  assert.match(player,/videoWidth\/v\.videoHeight/);
  assert.match(player,/DRAG_THRESHOLD=5/);
  assert.match(player,/HIDE_DELAY=5000/);
  assert.match(player,/controls-idle/);
  assert.doesNotMatch(player,/startResizeDragging/);
  assert.match(player,/minternet:media-volume/);
  assert.doesNotMatch(player,/createMediaElementSource|ensureGain|AudioContext/);
  assert.match(player,/media\.volume=level/);
  assert.match(player,/media-player-transcode/);
  assert.match(rust,/if name=="media-player-transcode"/);
  assert.match(rust,/fn minternet_transcode_file/);
  assert.match(rust,/fn minternet_ensure_ffmpeg/);
  assert.match(rust,/fn minternet_needs_audio_normalization/);
  assert.match(player,/available.needsNormalization/);
  assert.match(rust,/SHA256:&str/);
  assert.match(rust,/zip::ZipArchive/);
  assert.match(cargo,/zip = \{/);
  assert.doesNotMatch(html,/id="chooseFile"|id="mediaFile"/);
  assert.match(html,/http:\/\/asset\.localhost/);
  new vm.Script(player);
});
test('Windows workflow includes a real WAV playback smoke test',()=>{
  const rust=read('native/desktop/src-tauri/src/main.rs');
  const workflow=read('.github/workflows/native-windows.yml');
  const player=read('ui/media-player.js');
  assert.match(rust,/if name=="media-player-smoke-open"/);
  assert.match(rust,/if name=="media-player-smoke-proof"/);
  assert.match(rust,/wav\.extend_from_slice\(b"RIFF"\)/);
  assert.match(workflow,/--minternet-media-smoke/);
  assert.match(workflow,/minternet-media-/);
  assert.match(player,/loadedmetadata/);
});
test('white-screen compositor fix remains enabled',()=>{
  const native=read('native/desktop/src-tauri/src/main.rs');
  assert.match(native,/NotifyParentWindowPositionChanged/);
  assert.match(native,/schedule_surface_restore/);
  assert.doesNotMatch(native,/view\.eval\("location\.reload\(\)"/);
});

test('mini-player gestures and controls respect the video surface',()=>{
  const player=read('ui/media-player.js');
  const css=read('ui/media-player.css');
  const native=read('native/desktop/src-tauri/src/main.rs');
  assert.match(player,/root\.addEventListener\('pointerdown',startGesture,true\)/);
  assert.match(player,/Math\.hypot\(g\.deltaX,g\.deltaY\)<DRAG_THRESHOLD/);
  assert.match(player,/toggle\.click\(\)/);
  assert.match(player,/geometry\.aspectSize/);
  assert.match(player,/media-player-snap-targets/);
  assert.match(css,/controls-idle \.player-controls/);
  assert.match(native,/\.min_inner_size\(80\.0,45\.0\)/);
});

test('local audio never routes a cross-origin asset through WebAudio and falls back to FFmpeg',()=>{
  const script=read('ui/media-player.js');
  const rust=read('native/desktop/src-tauri/src/main.rs');
  assert.doesNotMatch(script,/createMediaElementSource/);
  assert.match(script,/media\.muted=volume\.muted/);
  assert.match(script,/media\.src=url;media\.load\(\)/);
  assert.match(script,/codecFallback\(sourceGeneration\)/);
  assert.match(rust,/\-c:a","aac"/);
  assert.match(rust,/\-map","0:a:0\?"/);
  assert.match(rust,/LocalMediaPath/);
  assert.match(rust,/\.min_inner_size\(80\.0,45\.0\)/);
});

test('mini-player settings persist in browser profile and apply live',()=>{
  const native=read('native/desktop/src-tauri/src/main.rs');
  const settings=read('ui/browser-settings.js');
  const sections=read('ui/settings-sections.js');
  const html=read('ui/index.html');
  const player=read('ui/media-player.js');
  assert.match(native,/miniplayer_fade_seconds:u16/);
  assert.match(native,/fn default_miniplayer_fade_seconds\(\)->u16\{5\}/);
  assert.match(native,/"miniplayer-fade-set"/);
  assert.match(native,/persist_preferences\(&app,&updated\)/);
  assert.match(native,/"media-player-settings-get"/);
  assert.match(native,/"minternet:miniplayer-settings"/);
  assert.match(settings,/miniplayerFadeSeconds/);
  assert.match(settings,/updateMiniplayerFade/);
  assert.match(sections,/section\('Mini-player'\)/);
  assert.match(html,/id="miniplayerSettings"/);
  assert.match(html,/id="miniplayerFadeSeconds"/);
  assert.match(player,/setFadeSeconds\(event.payload\?\.fadeSeconds\)/);
  assert.match(player,/if\(controlsDelay>0\)/);
});
test('mini-player resizes at every edge, with anywhere-resize gesture',()=>{
  const player=read('ui/media-player.js');
  const caps=JSON.parse(read('native/desktop/src-tauri/capabilities/media-player.json'));
  assert.match(player,/const EDGE_HIT=13/);
  assert.match(player,/event.shiftKey\|\|event.button===2/);
  assert.match(player,/side.includes\('l'\)/);
  assert.match(player,/side.includes\('t'\)/);
  assert.match(player,/anchoredPosition/);
  assert.match(player,/win\.outerPosition\(\)/);
  assert.match(player,/win\.scaleFactor\(\)/);
  assert.ok(caps.permissions.includes('core:window:allow-outer-position'));
  assert.ok(caps.permissions.includes('core:window:allow-scale-factor'));
});
test('Windows icon generation retains the ring with transparent inset',()=>{
  const icon=read('native/desktop/scripts/generate_icons.py');
  assert.match(icon,/ring_side = round\(512 \* 0\.95\)/);
  assert.match(icon,/Image\.new\("RGBA", \(512, 512\), \(0, 0, 0, 0\)\)/);
  assert.match(icon,/windows_symbol\.alpha_composite\(ring_artwork, \(inset, inset\)\)/);
  assert.doesNotMatch(icon,/windows_symbol\.crop\(/);
});
