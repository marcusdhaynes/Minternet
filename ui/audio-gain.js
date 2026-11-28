'use strict';
// No privileged IPC. Above unity, target perceived loudness rather than
// multiplying sample amplitude directly; use a shared compressor and peak guard.
(() => {
  if(window.__minternetAudioGain?.setLevel)return;
  const state={level:1,context:null,sources:new WeakMap(),graph:null,watcher:null,queued:false,resuming:false};
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
  // Approximate loudness doubling per +10 dB. This is a target, not
  // a guarantee: source crest factor, device headroom and hearing vary.
  const loudnessGain=ratio=>ratio<=1?ratio:Math.pow(ratio,10/(20*Math.log10(2)));
  const ceiling=Math.pow(10,-1.5/20),knee=0.65,scale=32;
  const threshold=-4,compressionRatio=20;
  // Web Audio's compressor has built-in makeup gain. Compensate its
  // nominal value so quiet samples retain the intended gain curve.
  const makeupCompensation=Math.pow(10,(threshold*(1-1/compressionRatio)*0.6)/20);
  function peakCurve(){
    // Scale the input before the waveshaper to leave room for peaks.
    // The curve is linear below the knee, monotonic and bounded; no hard
    // clipping at +/-1. Oversampling reduces distortion from the safety stage.
    const curve=new Float32Array(32769);
    for(let i=0;i<curve.length;i++){
      const x=(2*i/(curve.length-1)-1)*scale;
      const a=Math.abs(x);
      curve[i]=Math.sign(x)*(a<=knee?a:
        knee+(ceiling-knee)*(1-Math.exp(-(a-knee)/(ceiling-knee))));
    }
    return curve;
  }
  function updateGraph(graph,ratio){
    const boost=ratio>1;
    graph.dry.gain.value=boost?0:ratio;
    graph.drive.gain.value=boost?loudnessGain(ratio):1;
    graph.wet.gain.value=boost?1:0;
  }
  function graphFor(ctx){
    if(state.graph)return state.graph;
    const input=ctx.createGain(),dry=ctx.createGain(),drive=ctx.createGain();
    const compressor=ctx.createDynamicsCompressor(),pad=ctx.createGain();
    const peak=ctx.createWaveShaper(),wet=ctx.createGain();
    compressor.threshold.value=threshold;
    compressor.knee.value=0;
    compressor.ratio.value=compressionRatio;
    compressor.attack.value=0.003;
    compressor.release.value=0.12;
    pad.gain.value=makeupCompensation/scale;
    peak.curve=peakCurve();
    peak.oversample='4x';
    const graph={input,dry,drive,compressor,pad,peak,wet};
    updateGraph(graph,state.level);
    input.connect(dry).connect(ctx.destination);
    input.connect(drive).connect(compressor).connect(pad).connect(peak).connect(wet).connect(ctx.destination);
    state.graph=graph;
    return graph;
  }
  function connect(media){
    if(state.level===1||state.sources.has(media)||!allowed(media))return;
    const ctx=context();
    // Preserve the ordinary playback path until audio is actually running.
    if(ctx?.state!=='running')return;
    try{
      // Construct the full graph first so unsupported DSP cannot strand a
      // media element. All connected media in this document share the ceiling.
      const graph=graphFor(ctx);
      const source=ctx.createMediaElementSource(media);
      source.connect(graph.input);
      state.sources.set(media,source);
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
    if(state.graph)updateGraph(state.graph,n);
    if(n!==1){observe();activate();scan();schedule();}
  }
  window.__minternetAudioGain={setLevel};
})();
