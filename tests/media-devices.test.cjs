'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('microphone and camera no longer have unconditional native Deny',()=>{
  const main=read('native/desktop/src-tauri/src/main.rs');
  const module=read('native/desktop/src-tauri/src/media_devices.rs');
  assert.match(main,/PermissionKind::Microphone \| PermissionKind::Camera\s*=>\s*PermissionResponse::Default/);
  assert.match(main,/media_devices::attach\(app,id,&created,private\)/);
  assert.match(main,/media_devices::MediaDeviceState::default\(\)/);
  assert.match(module,/args\.Uri\(&mut wide\)/);
  assert.match(module,/SetSavesInProfile\(false\)/);
  assert.match(module,/COREWEBVIEW2_PERMISSION_STATE_ALLOW/);
  assert.match(module,/COREWEBVIEW2_PERMISSION_STATE_DENY/);
  assert.match(module,/SetPermissionState\(kind,PCWSTR/);
  assert.match(module,/media-devices/);
  assert.match(module,/private/);
});
function uiHtml(){return read('ui/media-devices-ui.js');}
test('active-media icon is directly after Favorites and popover matches existing surface',()=>{
  const html=read('ui/index.html');
  const star=html.indexOf('id="bookmarkThisPage"');
  const icon=html.indexOf('id="mediaDevicesButton"');
  const end=html.indexOf('</form>',star);
  assert.ok(star>=0&&icon>star&&icon<end);
  assert.match(html,/media-devices-ui\.js/);
  assert.match(html,/mediaDevicesButton" class="media-devices-button" hidden/);
  const css=read('ui/styles.css');
  assert.match(css,/\.media-devices-popup/);
  assert.match(uiHtml(),/system-popup-root minternet-context-menu/);
});
test('all device dropdowns show Disabled first, then System Default',()=>{
  const ui=read('ui/media-devices-ui.js');
  const script=new vm.Script(ui,{filename:'ui/media-devices-ui.js'});
  assert.ok(script);
  const first=ui.indexOf("[['disabled','Disabled'],['default','System Default']]");
  assert.ok(first>0,'Disabled-first option order');
  for(const id of ['speakerDevice','microphoneDevice','cameraDevice']){
    assert.ok(ui.includes(id));
  }
  for(const permission of ['ask','once','session','allow','block']){
    assert.match(ui,new RegExp("'"+permission+"'"));
  }
});
test('media probes only report capture status to native host, never native methods',()=>{
  const script=read('ui/site-media-bridge.js');
  new vm.Script(script);
  assert.match(script,/window\.chrome\.webview\.postMessage/);
  assert.match(script,/media\.getUserMedia/);
  assert.match(script,/track\.stop=function/);
  assert.match(script,/deviceId=\{exact:/);
  assert.match(script,/element\.setSinkId/);
  assert.doesNotMatch(script,/window\.__TAURI__/);
});
