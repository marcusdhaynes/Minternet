'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {aspectSize,snapPosition}=require('../ui/media-player-geometry.js');
const fs=require('node:fs');
const path=require('node:path');
const read=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');

test('video sizes are proportional for 16:9, portrait, ultrawide, and tiny windows',()=>{
  assert.deepEqual(aspectSize(320,16/9),{width:320,height:180});
  assert.deepEqual(aspectSize(160,4/3),{width:160,height:120});
  assert.deepEqual(aspectSize(90,9/16),{width:90,height:160});
  assert.deepEqual(aspectSize(20,21/9),{width:105,height:45});
  assert.deepEqual(aspectSize(10,16/9),{width:80,height:45});
  for(const ratio of [16/9,4/3,9/16,21/9,2.39,1]){
    for(const width of [80,93,223,410,1920]){
      const size=aspectSize(width,ratio);
      assert.ok(Math.abs(size.width/size.height-ratio)<=0.025);
      assert.ok(size.width>=80&&size.height>=45);
    }
  }
});

const viewport={left:100,top:200,right:1000,bottom:800};
const workArea={left:0,top:0,right:1920,bottom:1040};
const size={width:200,height:112};

test('snap to any segment of the browser content perimeter, independent of corners',()=>{
  assert.deepEqual(snapPosition({x:109,y:440},size,viewport,workArea),{x:100,y:440});
  assert.deepEqual(snapPosition({x:796,y:440},size,viewport,workArea),{x:800,y:440});
  assert.deepEqual(snapPosition({x:470,y:210},size,viewport,workArea),{x:470,y:200});
  assert.deepEqual(snapPosition({x:470,y:680},size,viewport,workArea),{x:470,y:688});
  assert.deepEqual(snapPosition({x:794,y:207},size,viewport,workArea),{x:800,y:200});
});

test('snap to Windows taskbar-facing work area instead of the full screen edge',()=>{
  assert.deepEqual(snapPosition({x:610,y:935},size,viewport,workArea),{x:610,y:928});
  assert.deepEqual(snapPosition({x:1725,y:490},size,viewport,workArea),{x:1720,y:490});
  assert.deepEqual(snapPosition({x:450,y:450},size,viewport,workArea),{x:450,y:450});
});

test('preserve aspect-lock, five-second fade and native content/taskbar queries',()=>{
  const player=read('ui/media-player.js');
  const css=read('ui/media-player.css');
  const native=read('native/desktop/src-tauri/src/main.rs');
  const html=read('ui/media-player.html');
  assert.match(player,/HIDE_DELAY=5000/);
  assert.match(player,/geometry\.aspectSize/);
  assert.match(player,/geometry\.snapPosition/);
  assert.match(player,/monitor\.workArea/);
  assert.match(player,/media-player-snap-targets/);
  assert.match(player,/win\.onMoved/);
  assert.doesNotMatch(css,/\.player-controls:focus-within/);
  assert.match(css,/controls-idle \.player-controls\{opacity:0;pointer-events:none;\}/);
  assert.match(native,/\.resizable\(false\)/);
  assert.match(native,/if name=="media-player-snap-targets"/);
  assert.match(native,/chrome_top\(&app\)/);
  assert.match(html,/media-player-geometry\.js/);
});
