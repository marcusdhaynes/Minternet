'use strict';
// Evaluated only inside a website's own child WebView, never in privileged chrome.
// Applies Web Audio gain to eligible HTML audio/video. The WebView2 native mute
// layer handles muting DRM/cross-origin sources that cannot be amplified.
// Cross-origin unapproved sources are deliberately never routed into Web Audio,
// because MediaElementAudioSourceNode could otherwise silence their playback.
(() => {
  if(window.__minternetAudioGain?.setLevel)return;
  const state={level:1,context:null,sources:new WeakMap(),watcher:null,queued:false};
  const allowed=media=>{
    if(media.mediaKeys)return false;
    if(media.srcObject)return true;
    const address=media.currentSrc||media.src;
    if(!address)return false;
    try{
      const url=new URL(address,location.href);
      return url.origin===location.origin || Boolean(media.crossOrigin);
    }catch{return false;}
  };
  function connect(media){
    if(state.sources.has(media)||!allowed(media))return;
    try{
      const AudioContext=window.AudioContext||window.webkitAudioContext;
      if(!AudioContext)return;
      if(!state.context)state.context=new AudioContext();
      // Never reroute a playing site into a suspended AudioContext: that can
      // silence it. Keep the original output until a real user gesture lets
      // the browser start its audio graph.
      if(state.context.state!=='running')return;
      const source=state.context.createMediaElementSource(media);
      const gain=state.context.createGain();
      gain.gain.value=state.level;
      source.connect(gain).connect(state.context.destination);
      state.sources.set(media,gain);
      state.nodes.add(gain);
      if(!media.paused&&state.context.state==='suspended')
        void state.context.resume().catch(()=>{});
    }catch{
      // A site may already own the media source; never interrupt its graph.
    }
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
  function install(){
    if(state.watcher||!document.documentElement)return;
    state.watcher=new MutationObserver(schedule);
    state.watcher.observe(document.documentElement,{childList:true,subtree:true});
    const activate=()=>{
      if(state.context?.state==='suspended')
        void state.context.resume().then(schedule).catch(()=>{});
    };
    // Capture normal playback gestures without intercepting site input.
    document.addEventListener('pointerdown',activate,true);
    document.addEventListener('keydown',activate,true);
    document.addEventListener('playing',event=>{
      const media=event.target;
      if(!media?.matches?.('audio,video'))return;
      connect(media);
      if(state.context?.state==='suspended')
        void state.context.resume().catch(()=>{});
    },true);
    document.addEventListener('loadedmetadata',event=>{
      if(event.target?.matches?.('audio,video'))connect(event.target);
    },true);
  }
  function setLevel(raw){
    const n=Number(raw);
    if(!Number.isFinite(n)||n<0||n>6)return;
    state.level=n;
    // Gain is updated on all previously connected elements without changing
    // media.volume or site mute settings.
    for(const node of state.nodes)node.gain.value=n;
    if(n!==1){install();schedule();}
  }
  // Keep a small set of graph gains so updates don't rewire media each time.
  state.nodes=new Set();
  state.sources=new WeakMap();
  // Note: createGain sources are held only for the life of their document.
  window.__minternetAudioGain={setLevel};
})();
