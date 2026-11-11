'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const {parse,toSeconds}=require('../ui/media-player-subtitles.js');

test('SRT, VTT and ASS subtitle parsing remains local and safe',()=>{
  const srt='1\n00:00:01,000 --> 00:00:04,250\nمرحبا بالعالم\n\n2\n00:00:05,000 --> 00:00:09,000\nHello';
  const vtt='WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<em>Caption</em>';
  const ass='[Script Info]\nTitle: test\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.25,Default,,0,0,0,,Arabic\\Ntest';
  assert.deepEqual(parse(srt,'test.srt'),[
    {start:1,end:4.25,text:'مرحبا بالعالم'},
    {start:5,end:9,text:'Hello'}
  ]);
  assert.deepEqual(parse(vtt,'test.vtt'),[{start:1,end:3,text:'Caption'}]);
  assert.deepEqual(parse(ass,'test.ass'),[{start:1,end:2.25,text:'Arabic\ntest'}]);
  assert.equal(toSeconds('01:02:03.500'),3723.5);
});
test('mini-player contains only the requested transport actions, with native fullscreen and subtitle dialog',()=>{
  const html=read('ui/media-player.html');
  const css=read('ui/media-player.css');
  const js=read('ui/media-player.js');
  const rust=read('native/desktop/src-tauri/src/main.rs');
  const caps=JSON.parse(read('native/desktop/src-tauri/capabilities/media-player.json'));
  for(const id of ['togglePlayback','playbackPosition','subtitleToggle','fullscreenToggle'])
    assert.match(html,new RegExp('id="'+id+'"'));
  assert.doesNotMatch(html,/id="resizeCorner"/);
  assert.doesNotMatch(css,/#resizeCorner/);
  assert.match(js,/function stopPlayback/);
  assert.match(js,/stopHoldTimer=setTimeout/);
  assert.match(js,/win\.setFullscreen/);
  assert.match(js,/win\.startDragging\(\)\.then/);
  assert.match(rust,/if name=="media-player-subtitle-pick"/);
  assert.ok(caps.permissions.includes('core:window:allow-set-fullscreen'));
});
test('persisted download acknowledgements prevent badge resurfacing across restarts',()=>{
  const js=read('ui/downloads-ui.js');
  const rust=read('native/desktop/src-tauri/src/main.rs');
  assert.match(js,/downloads-acknowledge/);
  assert.match(js,/entry\.unread===true/);
  assert.match(rust,/\#\[serde\(default\)\]\s+unread:bool/);
  assert.match(rust,/entry\.unread=false/);
  assert.match(rust,/download\.unread=false/);
  assert.match(rust,/"downloads-acknowledge"/);
  assert.match(rust,/save_recent_downloads\(&app\)/);
});
test('browser folder selection, open and safe Unicode filenames have native support',()=>{
  const html=read('ui/index.html');
  const settings=read('ui/browser-settings.js');
  const popup=read('ui/downloads-ui.js');
  const rust=read('native/desktop/src-tauri/src/main.rs');
  assert.match(html,/id="downloadFolderBrowse"/);
  assert.match(settings,/downloads-folder-choose/);
  assert.match(popup,/downloads-folder-open/);
  assert.match(rust,/blocking_pick_folder/);
  assert.match(rust,/"downloads-folder-open"/);
  assert.match(rust,/fn safe_download_filename/);
  assert.match(rust,/DownloadEvent::Requested/);
  assert.match(rust,/DownloadEvent::Finished/);
  assert.match(rust,/repair_download_extension/);
});
