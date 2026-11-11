'use strict';
// This script runs inside each remote website WebView, not browser chrome.
// It never exposes native commands or site data; the host receives only
// capture status and the browser MediaDevices labels/IDs for the current page.
(()=>{
  if(window.top!==window || !navigator.mediaDevices?.getUserMedia)return;
  if(window.__minternetMediaApply)return;
  const media=navigator.mediaDevices;
  const nativeGet=media.getUserMedia.bind(media);
  const nativeEnumerate=media.enumerateDevices?.bind(media);
  const tracked=new Map();
  let config={microphoneDevice:'default',cameraDevice:'default',speakerDevice:'default'};
  let previous='',active=false;
  const report=(kind,fields={})=>{
    if(!window.chrome?.webview?.postMessage)return;
    try{
      const data={minternetMedia:1,kind,origin:location.origin,...fields};
      const encoded=JSON.stringify(data);
      if(encoded.length<22000)window.chrome.webview.postMessage(data);
    }catch{}
  };
  const live=()=>{
    let microphone=false,camera=false;
    for(const [track,kind] of tracked){
      if(track.readyState==='ended')tracked.delete(track);
      else if(track.readyState==='live'){
        if(kind==='audio')microphone=true;
        if(kind==='video')camera=true;
      }
    }
    return {microphone,camera};
  };
  let speaker=false;
  function update(){
    const status={...live(),speaker,origin:location.origin};
    const now=JSON.stringify(status);
    if(now!==previous){previous=now;report('state',status);}
  }
  function register(stream){
    for(const track of stream.getTracks()){
      if(tracked.has(track))continue;
      tracked.set(track,track.kind);
      track.addEventListener('ended',update);
      const stop=track.stop.bind(track);
      track.stop=function(){stop();tracked.delete(track);update();};
    }
    update();
    void collectDevices();
    return stream;
  }
  async function collectDevices(){
    if(!nativeEnumerate)return;
    try{
      const choices=(await nativeEnumerate()).filter(d=>
        ['audioinput','videoinput','audiooutput'].includes(d.kind))
        .slice(0,48).map(d=>({
          kind:d.kind,id:String(d.deviceId||'').slice(0,256),
          label:String(d.label||'').slice(0,100)
        }));
      report('devices',{devices:choices});
    }catch{}
  }
  media.getUserMedia=async function(request){
    const original=Object(request||{});
    const needsMic=Boolean(original.audio),needsCam=Boolean(original.video);
    if(needsMic&&config.microphoneDevice==='disabled' ||
       needsCam&&config.cameraDevice==='disabled'){
      throw new DOMException('Device disabled in Minternet Media Devices','NotAllowedError');
    }
    const choices={...original};
    if(needsMic&&config.microphoneDevice!=='default'){
      const a=typeof original.audio==='object'?{...original.audio}:{};
      a.deviceId={exact:config.microphoneDevice};choices.audio=a;
    }
    if(needsCam&&config.cameraDevice!=='default'){
      const v=typeof original.video==='object'?{...original.video}:{};
      v.deviceId={exact:config.cameraDevice};choices.video=v;
    }
    try{return register(await nativeGet(choices));}
    catch(error){report('request-failed',{requestedMicrophone:needsMic,requestedCamera:needsCam});throw error;}
  };
  async function setSpeaker(){
    const outputs=[...document.querySelectorAll('audio,video')];
    const selected=config.speakerDevice;
    for(const element of outputs){
      if(selected==='disabled'){
        if(!element.hasAttribute('data-minternet-silent')){
          element.setAttribute('data-minternet-silent',element.muted?'yes':'no');
        }
        element.muted=true;continue;
      }
      if(element.hasAttribute('data-minternet-silent')){
        element.muted=element.getAttribute('data-minternet-silent')==='yes';
        element.removeAttribute('data-minternet-silent');
      }
      if(typeof element.setSinkId==='function'){
        try{await element.setSinkId(selected==='default'?'':selected);}
        catch(error){report('output-error',{message:String(error?.name||'Sink unavailable')});}
      }
    }
  }
  // Only the host can call this through WebView2 evaluation. The method is
  // intentionally not security-sensitive: websites already control their
  // own media constraints and DOM.
  window.__minternetMediaApply=next=>{
    if(!next||typeof next!=='object')return;
    for(const key of Object.keys(config)){
      if(typeof next[key]==='string'&&next[key].length<=256)config[key]=next[key];
    }
    for(const [track,kind] of tracked){
      if(kind==='audio'&&config.microphoneDevice==='disabled'||
         kind==='video'&&config.cameraDevice==='disabled')track.stop();
    }
    void setSpeaker();
    void collectDevices();
    update();
  };
  window.__minternetMediaStop=()=>{
    for(const track of [...tracked.keys()])track.stop();
    tracked.clear();update();
  };
  media.addEventListener?.('devicechange',()=>void collectDevices());
  document.addEventListener('play',event=>{
    if(event.target?.tagName==='AUDIO'||event.target?.tagName==='VIDEO'){
      speaker=true;update();void setSpeaker();
    }
  },true);
  document.addEventListener('pause',()=>{
    speaker=[...document.querySelectorAll('audio,video')].some(v=>!v.paused&&!v.muted);
    update();
  },true);
  const observer=new MutationObserver(()=>void setSpeaker());
  document.addEventListener('DOMContentLoaded',()=>{
    observer.observe(document.documentElement,{childList:true,subtree:true});
    void collectDevices();void setSpeaker();
  },{once:true});
  window.addEventListener('pagehide',()=>{tracked.clear();speaker=false;update();});
  // Track health from RTCPeerConnection: a stream can end outside the page.
  setInterval(()=>{if(tracked.size)update();},1200);
  update();
})();