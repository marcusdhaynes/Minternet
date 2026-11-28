'use strict';
// No privileged IPC. Amplification is a linear sample-amplitude multiplier.
// Native WebView2 mute remains responsible for unsupported/protected sources.
(() => {
  if(window.__minternetAudioGain?.setLevel)return;
  const state={level:1,context:null,sources:new WeakMap(),nodes:new Set(),watcher:null,queued:false,resuming:false};
  const allowed=media=>{
    if(media.mediaKeys)return false;
    if(media.srcObject)return true;
    // A successfully loaded CORS-enabled media element is eligible. Do not
    // attach before metadata: a CORS failure would otherwise silence it.
    if(typeof media.readyState==='number'&&media.readyState<1)return false;
    const address=media.currentSrc||media.src;
    if(!address)return false;
    try{
      const url=new URL(address,location.href);
      return url.origin===location.origin ||
        (media.crossOrigin!==null&&media.crossOrigin!==undefined);
    }catch{return false;}
  };
  function context(){
    if(state.context?.state==='closed')return null;
    try{
      const AudioContext=window.AudioContext||window.webkitAudioContext;
      if(!AudioContext)return null;
      if(!state.context)state.context=new AudioContext();
      return state.context;
    }catch{return null;}
  }
  function connect(media){
    if(state.level===1||state.sources.has(media)||!allowed(media))return;
    const ctx=context();
    // Preserve the ordinary playback path until audio is actually running.
    if(ctx?.state!=='running')return;
    try{
      const gain=ctx.createGain();
      gain.gain.value=state.level;
      const source=ctx.createMediaElementSource(media);
      source.connect(gain).connect(ctx.destination);
      state.sources.set(media,gain);
      state.nodes.add(gain);
    }catch{/* Site may already own the media graph. */}
  }
  function scan(){
    state.queued=false;
    if(state.level===1)return;
    for(const media of document.querySelectorAll('audio,video'))connect(media);
  }
  function schedule(){
    if(state.queued||state.level===1)return;
    state.queued=true;
    requestAnimationFrame(scan);
  }
  function activate(){
    const ctx=context();
    if(!ctx)return;
    if(ctx.state==='running'){scan();return;}
    if(state.resuming||ctx.state==='closed')return;
    state.resuming=true;
    try{
      Promise.resolve(ctx.resume()).then(()=>{
        if(ctx.state==='running')scan();
      }).catch(()=>{}).finally(()=>{state.resuming=false;});
    }catch{state.resuming=false;}
  }
  function observe(){
    if(state.watcher||!document.documentElement)return;
    state.watcher=new MutationObserver(schedule);
    state.watcher.observe(document.documentElement,{childList:true,subtree:true});
  }
  // Warm the context during an ordinary playback gesture, even at 100%.
  // Later toolbar changes must not require a second gesture inside the site.
  document.addEventListener('pointerdown',activate,true);
  document.addEventListener('keydown',activate,true);
  for(const eventName of ['playing','loadedmetadata']){
    document.addEventListener(eventName,event=>{
      if(!event.target?.matches?.('audio,video'))return;
      if(state.level!==1){activate();connect(event.target);}
    },true);
  }
  document.addEventListener('DOMContentLoaded',()=>{observe();schedule();},{once:true});
  function setLevel(raw){
    const n=Number(raw);
    if(!Number.isFinite(n)||n<0||n>6)return;
    state.level=n;
    for(const node of state.nodes)node.gain.value=n;
    if(n!==1){observe();activate();scan();schedule();}
  }
  window.__minternetAudioGain={setLevel};
})();
