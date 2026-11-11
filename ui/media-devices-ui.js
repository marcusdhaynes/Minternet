'use strict';
// Trusted chrome media flyout. Page scripts cannot invoke browser_action.
// Device names are obtained from the active site's enumerateDevices(), not
// from guessing Windows registry hardware IDs.
(()=>{
  const api=window.minternet;
  const trigger=document.getElementById('mediaDevicesButton');
  if(!api||!trigger)return;
  let panel=null,activeId=null,lastState=null,refreshing=false,activeStatus=false;
  const command=(name,value)=>api.command(name,value);
  const fieldIds=['speakerDevice','microphoneDevice','cameraDevice'];
  const deviceKinds={speakerDevice:'audiooutput',microphoneDevice:'audioinput',cameraDevice:'videoinput'};
  const labels={speakerDevice:'Speaker',microphoneDevice:'Microphone',cameraDevice:'Webcam'};
  const $=id=>panel?.querySelector('#'+id);
  function close(){
    if(!panel)return;
    panel.remove();panel=null;
    trigger.setAttribute('aria-expanded','false');
    document.removeEventListener('pointerdown',outside,true);
    document.removeEventListener('keydown',keyboard,true);
    if(window.__TAURI__)void command('chrome-overlay',false);
    trigger.hidden=!activeStatus;
  }
  function outside(event){
    if(panel&&!panel.contains(event.target)&&!trigger.contains(event.target))close();
  }
  function keyboard(event){
    if(event.key==='Escape'){event.preventDefault();close();trigger.focus();}
  }
  function position(){
    if(!panel)return;
    const rect=trigger.getBoundingClientRect();
    const width=panel.offsetWidth||298;
    panel.style.left=Math.max(4,Math.min(innerWidth-width-4,rect.left))+'px';
    panel.style.top=Math.min(innerHeight-(panel.offsetHeight||310)-4,rect.bottom+5)+'px';
  }
  const make=(tag,className,text)=>{
    const el=document.createElement(tag);
    if(className)el.className=className;
    if(text!==undefined)el.textContent=text;
    return el;
  };
  function ruleOptions(select){
    for(const [value,label] of [
      ['ask','Ask Every Time'],['once','Allow Once'],
      ['session','Allow for This Session'],['allow','Always Allow'],
      ['block','Block']
    ]){
      const o=make('option','',label);o.value=value;select.append(o);
    }
  }
  function deviceOptions(select,field,settings,devices){
    select.replaceChildren();
    // Disabled MUST always be first, even if the selected device is default.
    for(const [value,label] of [['disabled','Disabled'],['default','System Default']]){
      const opt=make('option','',label);opt.value=value;select.append(opt);
    }
    const names=new Set(['default','disabled']);
    for(const device of devices||[]){
      if(device.kind!==deviceKinds[field]||!device.id||names.has(device.id))continue;
      names.add(device.id);
      const o=make('option','',device.label||labels[field]+' '+names.size);
      o.value=device.id;select.append(o);
    }
    const selected=settings[field]||'default';
    if(!names.has(selected)){
      const unavailable=make('option','','Previous device (not connected)');
      unavailable.value=selected;select.append(unavailable);
    }
    select.value=selected;
  }
  function activeLine(status){
    const active=[];
    if(status?.microphone)active.push('Microphone');
    if(status?.camera)active.push('Webcam');
    if(status?.speaker)active.push('Speaker');
    return active.length?'In Use: '+active.join(' · '):
      status?.requested?'Media Permission Requested':'No Active Capture';
  }
  function setMessage(message){
    const el=$('mediaDeviceMessage');
    if(el)el.textContent=String(message||'');
  }
  function render(data){
    lastState=data||lastState;
    if(!panel||!lastState)return;
    const {origin='',settings={},status={},private:incognito=false}=lastState;
    $('mediaDeviceOrigin').textContent=origin||'No Secure Site Selected';
    $('mediaDeviceUsage').textContent=activeLine(status);
    $('mediaDevicePrivacy').textContent=incognito?
      'Private Tab · Permissions Are Temporary':
      'Permissions Are Saved Per Website';
    for(const field of fieldIds){
      const select=$(field);
      if(select)deviceOptions(select,field,settings,status.devices||[]);
    }
    for(const field of ['microphone','camera']){
      const select=$(field+'Permission');
      if(select)select.value=settings[field]||'ask';
    }
    position();
  }
  async function refresh(){
    if(refreshing)return;
    refreshing=true;
    try{
      const data=await command('site-media-get');
      if(data?.message){setMessage(data.message);return;}
      if(data?.origin)render(data);
    }catch(e){setMessage(String(e));}
    finally{refreshing=false;}
  }
  async function save(field,value){
    setMessage('Applying…');
    try{
      const result=await command('site-media-set',{field,value});
      if(result?.message)throw Error(result.message);
      render(result);
      setMessage(field.endsWith('Device')?
        'Device updated. Reload the calling site if it does not switch automatically.':
        'Permission updated. Retry the microphone or webcam request.');
    }catch(e){setMessage('Could not update: '+String(e.message||e));await refresh();}
  }
  async function revoke(){
    try{
      const data=await command('site-media-revoke');
      if(data?.message)throw Error(data.message);
      render(data);
      setMessage('Camera and microphone stopped. Permissions revoked. Select System Default and allow access again to resume.');
    }catch(e){setMessage(String(e.message||e));}
  }
  function build(){
    const host=make('section','system-popup-root minternet-context-menu media-devices-popup');
    host.id='mediaDevicesPopup';host.setAttribute('role','dialog');
    host.setAttribute('aria-label','Media Devices And Site Permissions');
    const header=make('div','media-devices-head');
    const title=make('strong','','Media Devices');
    const x=make('button','media-devices-close','×');x.type='button';x.setAttribute('aria-label','Close Media Devices');
    x.addEventListener('click',close);header.append(title,x);
    const origin=make('div','media-devices-origin');origin.id='mediaDeviceOrigin';
    const usage=make('div','media-devices-usage');usage.id='mediaDeviceUsage';
    const rows=make('div','media-devices-rows');
    for(const field of fieldIds){
      const line=make('label','media-devices-row');
      const caption=make('span','',labels[field]);
      const select=make('select','');select.id=field;
      select.setAttribute('aria-label','Active '+labels[field]);
      select.addEventListener('change',()=>void save(field,select.value));
      line.append(caption,select);rows.append(line);
    }
    const divider=make('div','media-devices-divider');
    const subtitle=make('strong','media-devices-subtitle','Site Permissions');
    const permissions=make('div','media-devices-permissions');
    for(const [field,label] of [['microphone','Microphone'],['camera','Webcam']]){
      const line=make('label','media-devices-row');
      line.append(make('span','',label));
      const select=make('select','');select.id=field+'Permission';
      select.setAttribute('aria-label',label+' Permission Rule');
      ruleOptions(select);
      select.addEventListener('change',()=>void save(field,select.value));
      line.append(select);permissions.append(line);
    }
    const footer=make('div','media-devices-bottom');
    const revokeButton=make('button','media-devices-revoke','Revoke Site Access');
    revokeButton.type='button';revokeButton.addEventListener('click',()=>void revoke());
    footer.append(revokeButton);
    const privacy=make('small','media-devices-privacy');privacy.id='mediaDevicePrivacy';
    const message=make('small','media-devices-message');message.id='mediaDeviceMessage';
    message.setAttribute('role','status');message.setAttribute('aria-live','polite');
    host.append(header,origin,usage,rows,divider,subtitle,permissions,footer,privacy,message);
    return host;
  }
  async function open(){
    if(panel){close();return;}
    if(window.__TAURI__)await command('chrome-overlay',true);
    panel=build();document.body.append(panel);
    trigger.hidden=false;trigger.setAttribute('aria-expanded','true');
    position();
    document.addEventListener('pointerdown',outside,true);
    document.addEventListener('keydown',keyboard,true);
    await refresh();
  }
  trigger.addEventListener('click',()=>void open());
  window.minternetMediaDevices={open,close};
  window.addEventListener('resize',position);
  function onState(state){
    if(!state)return;
    const id=state.activeId;
    if(id!==activeId){
      activeId=id;lastState=null;
      if(panel)void refresh();
    }
    const tab=(state.tabs||[]).find(t=>t.id===id);
    activeStatus=Boolean(tab?.audioPlaying);
    // Native media events have the authoritative capture/request status.
    if(!panel)trigger.hidden=!activeStatus;
  }
  api.onState?.(onState);
  if(window.__TAURI__?.event?.listen){
    window.__TAURI__.event.listen('minternet:media-devices',async event=>{
      if(event.payload?.tabId!==activeId)return;
      const result=await command('site-media-get');
      if(result?.message)return;
      if(result?.origin){
        lastState=result;
        activeStatus=Boolean(result.status?.microphone||result.status?.camera||
          result.status?.speaker||result.status?.requested);
        trigger.hidden=!activeStatus&&!panel;
        if(panel)render(result);
      }
    }).catch(()=>{});
  }
})();