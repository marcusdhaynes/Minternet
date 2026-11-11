'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
test('Minternet has a separate trusted media window and compact button before Tor',()=>{
  const native=read('native/desktop/src-tauri/src/main.rs');
  const html=read('ui/index.html');
  const caps=JSON.parse(read('native/desktop/src-tauri/capabilities/default.json'));
  assert.match(native,/if name=="media-player-open"/);
  assert.match(native,/WebviewUrl::App\("media-player.html"\.into\(\)\)/);
  assert.match(native,/\.always_on_top\(true\)/);
  assert.match(native,/\.transparent\(true\)/);
  assert.ok(html.indexOf('id="mediaPlayerButton"')<html.indexOf('id="tor"'));
  const player=JSON.parse(read('native/desktop/src-tauri/capabilities/media-player.json'));
  assert.deepEqual(caps.webviews,['chrome']);
  assert.deepEqual(caps.windows,['main']);
  assert.deepEqual(player.webviews,['minternet-media-player']);
  assert.ok(player.permissions.includes('core:window:allow-start-resize-dragging'));
});
test('media player uses local user-picked Blob and supports floating audio/video modes',()=>{
  const js=read('ui/media-player.js');
  new vm.Script(js);
  const launch=read('ui/media-launch.js');
  new vm.Script(launch);
  assert.match(launch,/picker\.files\?\.\[0\]/);
  assert.match(launch,/URL\.createObjectURL\(file\)/);
  assert.match(js,/selectSource\(selected\)/);
  assert.match(js,/media-player-current/);
  assert.match(js,/body\.dataset\.mode=current/);
  assert.match(js,/win\.startDragging\(\)/);
  assert.match(js,/startResizeDragging\('SouthEast'\)/);
  assert.match(js,/win\.currentMonitor\(\)/);
  assert.match(js,/PhysicalPosition\(x,y\)/);
  assert.match(js,/audioContext\.createGain\(\)/);
  assert.match(js,/minternet:media-volume/);
  assert.match(js,/volume\.level\/100/);
  assert.doesNotMatch(js,/fetch\(|XMLHttpRequest|\.send\(/);
});
test('browser compositor is notified after bounds and window move, preserving site DOM',()=>{
 const native=read('native/desktop/src-tauri/src/main.rs');
 assert.match(native,/NotifyParentWindowPositionChanged/);
 assert.match(native,/notify_native_compositor\(&view\)/);
 assert.match(native,/WindowEvent::Moved\(_\)/);
 assert.match(native,/schedule_surface_restore\(&handle\)/);
 assert.doesNotMatch(native,/view\.eval\("location\.reload\(\)"/);
});

test('toolbar selects file before opening player, and cancellation opens nothing',()=>{
 const launch=read('ui/media-launch.js');
 const native=read('native/desktop/src-tauri/src/main.rs');
 assert.ok(launch.indexOf('picker.click()')<launch.indexOf("command('media-player-open'"));
 assert.match(launch,/if\(!file\|\|busy\)return/);
 assert.match(native,/\.visible\(false\)/);
 assert.match(native,/if name=="media-player-current"/);
 assert.match(native,/Only local media can be opened/);
});
