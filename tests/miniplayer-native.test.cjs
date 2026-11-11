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
  assert.match(read('ui/index.html'),/id="minternetMediaPicker" type="file"/);
  assert.doesNotMatch(launch,/picker\.click\(\)/);
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

test('direct media chooser accepts a real user click and cancellation opens nothing',()=>{
 const markup=read('ui/index.html'),launch=read('ui/media-launch.js');
 const native=read('native/desktop/src-tauri/src/main.rs'),styles=read('ui/styles.css');
 const start=markup.indexOf('<label id="mediaPlayerButton"');
 const end=markup.indexOf('</label>',start);
 assert.ok(start>=0&&end>start);
 const label=markup.slice(start,end);
 assert.match(label,/id="minternetMediaPicker" type="file"/);
 assert.match(styles,/#minternetMediaPicker\{/);
 assert.match(styles,/opacity:0!important;display:block!important/);
 assert.doesNotMatch(launch,/picker\.click\(\)|picker\.hidden=true|if\(!button\|\|!window\.minternet\)return/);
 assert.match(launch,/if\(!file\|\|busy\)return/);
 assert.match(launch,/picker\.addEventListener\('change'/);
 assert.match(launch,/window\.minternet\.command\('media-player-open'/);
 assert.match(launch,/Native Minternet bridge is unavailable/);
 assert.match(native,/\.visible\(false\)/);
 assert.match(native,/if name=="media-player-current"/);
});
test('media chooser reports the real native failure instead of silently doing nothing',async()=>{
 const launch=read('ui/media-launch.js');
 const events={},toasts=[];
 let picker={files:[{name:'clip.mp4',size:1200,type:'video/mp4'}],value:'sample',
   disabled:false,addEventListener(n,fn){events[n]=fn}};
 let button={classList:{add(){},remove(){}}};
 const fakeWindow={
   minternet:{command:async()=>({message:'Local media could not be opened'})},
   minternetToast:s=>toasts.push(s),addEventListener(){},
 };
 const fakeDocument={getElementById(id){
   if(id==='mediaPlayerButton')return button;
   if(id==='minternetMediaPicker')return picker;
   return null;
 }};
 vm.runInNewContext(launch,{window:fakeWindow,document:fakeDocument,
   URL:{createObjectURL:()=> 'blob:http://tauri.localhost/1234',
        revokeObjectURL(){}},setTimeout});
 assert.equal(typeof events.change,'function');
 await events.change();
 assert.equal(toasts.length,1);
 assert.match(toasts[0],/Local media could not be opened/);
 assert.equal(picker.disabled,false);
});
