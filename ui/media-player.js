'use strict';
(()=>{
  const $=id=>document.getElementById(id);
  const tauri=window.__TAURI__;
  const win=tauri?.window?.getCurrentWindow?.();
  const mediaElements={video:$('localVideo'),audio:$('localAudio')};
  const error=$('mediaError');
  const controls=$('playerControls'),toggle=$('togglePlayback'),scrubber=$('playbackPosition');
  const close=$('playerClose'),resize=$('resizeCorner'),drag=$('dragZone');
  const volume={level:100,muted:false};
  let current=null,url=null,sourceGeneration=0,normalizing=false,normalizingGeneration=0,usedCodecFallback=false;
  const HIDE_DELAY=5000,DRAG_THRESHOLD=5,MIN_VIDEO_WIDTH=80;
  const geometry=window.MinternetMediaGeometry;
  let controlsTimer=null,lastVideoRatio=16/9,gesture=null;
  let pendingVideoSize=null,resizingVideo=false,metadataSizedGeneration=0;
  function showControls(){
    if(current!=='video')return;
    document.body.classList.remove('controls-idle');
    clearTimeout(controlsTimer);
    controlsTimer=setTimeout(()=>{
      if(!gesture)document.body.classList.add('controls-idle');
    },HIDE_DELAY);
  }
  function videoRatio(){
    const v=mediaElements.video;
    return v.videoWidth>0&&v.videoHeight>0?v.videoWidth/v.videoHeight:lastVideoRatio;
  }
  async function sizeToVideo(width){
    if(!win||current!=='video')return;
    pendingVideoSize=geometry.aspectSize(width,videoRatio(),MIN_VIDEO_WIDTH,45);
    if(resizingVideo)return;
    resizingVideo=true;
    try{
      while(pendingVideoSize&&current==='video'){
        const size=pendingVideoSize;
        pendingVideoSize=null;
        await win.setSize(new tauri.window.LogicalSize(size.width,size.height));
      }
    }catch{/* Window may have closed during resize. */}
    finally{resizingVideo=false;}
  }
  const active=()=>current&&mediaElements[current];
  // The local asset protocol is not the webview page's origin. Passing it through
  // a Web Audio media-source node can permanently silence the media element
  // under Web Audio's cross-origin security rules, even for ordinary WAV/MP3.
  // Use the media element's own native output path for ALL local files.
  function applyVolume(){
    const level=volume.muted?0:Math.max(0,Math.min(1,volume.level/100));
    for(const media of Object.values(mediaElements)){
      media.muted=volume.muted;
      media.volume=level;
    }
  }
  async function codecFallback(generation,quiet=false){
    if(generation!==sourceGeneration||normalizing||usedCodecFallback)return false;
    if(!tauri?.core?.invoke)return false;
    normalizing=true;
    normalizingGeneration=generation;
    const media=active();
    if(!quiet){
      error.textContent='Preparing this format with the local codec engine (first use may download codecs)…';
      error.hidden=false;
    }
    try{
      const result=await tauri.core.invoke('browser_action',
        {name:'media-player-transcode',value:{kind:current}});
      if(generation!==sourceGeneration)return false;
      if(typeof result?.url!=='string')throw Error('Codec engine returned no playable media');
      usedCodecFallback=true;
      media.pause();
      media.src=result.url;
      media.load();
      error.hidden=true;
      try{await media.play();}catch{/* User can play explicitly. */}
      updateControls();
      return true;
    }catch(e){
      if(generation===sourceGeneration&&!quiet){
        fail('This codec could not be decoded: '+String(e?.message||e));
      }
      return false;
    }finally{
      if(normalizingGeneration===generation)normalizing=false;
    }
  }
  async function maybeNormalize(selection,generation){
    const name=(selection.name||'').toLowerCase();
    // Probe audio streams when the decoder is installed. This also detects
    // AC-3/E-AC-3/DTS in otherwise supported MP4 video, where Chromium can
    // render video but silently omit the incompatible audio track.
    const unusual=/\.(mkv|mka|avi|wmv|wma|flv|ape|ac3|eac3|dts|amr|aif|aiff)$/i.test(name);
    try{
      const available=await tauri?.core?.invoke('browser_action',
        {name:'media-player-codec-available',value:null});
      if(available?.ok&&(unusual||available.needsNormalization)&&generation===sourceGeneration){
        await codecFallback(generation,false);
      }
    }catch{/* Native playback still works for supported tracks. */}
  }
  function fail(message){
    error.textContent=message;error.hidden=false;
  }
  function updateControls(){
    const media=active();if(!media)return;
    toggle.textContent=media.paused?'▶':'Ⅱ';
    toggle.setAttribute('aria-label',media.paused?'Play':'Pause');
    scrubber.value=Number.isFinite(media.duration)&&media.duration>0?
      String(Math.round(media.currentTime/media.duration*1000)):'0';
    scrubber.disabled=!Number.isFinite(media.duration)||media.duration<=0;
  }
  function kindFor(file){
    const ext=(file.name.split('.').pop()||'').toLowerCase();
    if(file.type.startsWith('audio/')||
       /^(mp3|aac|m4a|wav|flac|ogg|oga|opus|aiff|aif|wma|mid|midi|ape|ac3|eac3|dts|amr|mka|alac|caf|wv|tta|tak)$/.test(ext))return 'audio';
    return 'video';
  }
  async function resizeWindow(mode){
    if(!win)return;
    if(mode==='video')return sizeToVideo(410);
    try{await win.setSize(new tauri.window.LogicalSize(358,76));}catch{}
  }
  async function selectSource(selection){
    if(!selection || typeof selection.url!=='string' ||
       !(['http://asset.localhost/','https://asset.localhost/','asset://localhost/']
            .some(prefix=>selection.url.startsWith(prefix)))){
      fail('Cannot open the selected local file.');
      return;
    }
    // Only a native OS-selected local file is accessible via Tauri's
    // single-file scoped, byte-range streaming asset protocol.
    for(const media of Object.values(mediaElements)){
      media.pause();media.removeAttribute('src');media.hidden=true;media.load();
    }
    url=selection.url;
    const generation=++sourceGeneration;
    usedCodecFallback=false;
    normalizing=false;
    normalizingGeneration=0;
    error.hidden=true;
    current=kindFor({name:selection.name||'',type:selection.mime||''});
    document.body.dataset.mode=current;
    controls.hidden=false;resize.hidden=current!=='video';
    document.body.classList.remove('controls-idle');
    clearTimeout(controlsTimer);
    metadataSizedGeneration=0;
    const media=active();
    media.hidden=false;
    if(selection.smoke){
      media.addEventListener('loadedmetadata',()=>{
        void tauri?.core?.invoke('browser_action',{
          name:'media-player-smoke-proof',value:{duration:media.duration}
        }).catch(()=>{});
      },{once:true});
    }
    media.src=url;media.load();
    // Native audio delivery avoids the Web Audio cross-origin silence bug.
    applyVolume();
    await resizeWindow(current);
    if(current==='video')showControls();
    await win?.show(); // the native file picker has already finished
    updateControls();
    try{await media.play();}catch{/* A codec fallback may still succeed. */}
    updateControls();
    void maybeNormalize(selection,generation);
  }
  // Query the latest selection after initial load, eliminating the race
  // where the window opens before the event listener is installed.
  async function startSelectedMedia(){
    try{
      const selected=await tauri?.core?.invoke('browser_action',
        {name:'media-player-current',value:null});
      if(selected?.url)await selectSource(selected);
      else await win?.close();
    }catch{await win?.close();}
  }
  if(tauri?.event){
    void tauri.event.listen('minternet:media-selected',event=>{
      void selectSource(event.payload);
    }).catch(()=>{});
  }
  void startSelectedMedia();
  toggle.addEventListener('click',async()=>{
    const media=active();if(!media)return;
    if(media.paused){
      try{await media.play();}catch(e){
        if(e?.name==='NotSupportedError')void codecFallback(sourceGeneration);
        else if(e?.name!=='NotAllowedError')fail('Playback failed: '+String(e?.message||e));
      }
    }else media.pause();
    updateControls();
  });
  scrubber.addEventListener('input',()=>{
    const media=active();
    if(media&&Number.isFinite(media.duration)&&media.duration>0){
      media.currentTime=media.duration*Number(scrubber.value)/1000;
    }
  });
  for(const media of Object.values(mediaElements)){
    for(const name of ['durationchange','loadedmetadata','timeupdate','play','pause','ended','seeked'])
      media.addEventListener(name,updateControls);
    media.addEventListener('error',()=>{
      if(media!==active())return;
      if(usedCodecFallback){
        fail('The local codec engine could not play this file.');
      }else if(!normalizing){
        void codecFallback(sourceGeneration);
      }
    });
  }
  mediaElements.video.addEventListener('loadedmetadata',()=>{
    const ratio=videoRatio();
    if(Number.isFinite(ratio)&&ratio>0)lastVideoRatio=ratio;
    const first=metadataSizedGeneration!==sourceGeneration;
    metadataSizedGeneration=sourceGeneration;
    // Codec fallback may fire loadedmetadata a second time. Keep chosen size.
    void sizeToVideo(first?Math.round(258*lastVideoRatio):window.innerWidth);
  });
  const root=document.querySelector('.player-root');
  root.addEventListener('pointermove',showControls);
  root.addEventListener('pointerenter',showControls);
  root.addEventListener('pointerdown',showControls);
  controls.addEventListener('focusin',showControls);
  controls.addEventListener('input',showControls);
  function startGesture(event,isResize=false){
    if(event.button!==0||!win||current!=='video')return;
    event.preventDefault();
    event.stopPropagation();
    gesture={x:event.screenX,y:event.screenY,resize:isResize,
      width:window.innerWidth,dragged:false,requestedWidth:window.innerWidth};
    event.currentTarget.setPointerCapture?.(event.pointerId);
    showControls();
  }
  function moveGesture(event){
    if(!gesture)return;
    const g=gesture,dx=event.screenX-g.x,dy=event.screenY-g.y;
    if(!g.dragged&&Math.hypot(dx,dy)<DRAG_THRESHOLD)return;
    g.dragged=true;
    if(g.resize){
      const delta=Math.abs(dx)>Math.abs(dy)*videoRatio()?dx:dy*videoRatio();
      g.requestedWidth=g.width+delta;
      void sizeToVideo(g.requestedWidth);
    }else{
      // Only begin native dragging when the pointer has moved beyond a click.
      gesture=null;
      void win.startDragging().catch(()=>{});
    }
  }
  function endGesture(event){
    if(!gesture)return;
    const g=gesture;gesture=null;
    if(g.resize&&g.dragged)void sizeToVideo(g.requestedWidth);
    if(!g.dragged&&!g.resize&&event.type==='pointerup')toggle.click();
    showControls();
  }
  for(const surface of [mediaElements.video,drag]){
    surface.addEventListener('pointerdown',event=>startGesture(event));
  }
  resize.addEventListener('pointerdown',event=>startGesture(event,true));
  window.addEventListener('pointermove',moveGesture);
  window.addEventListener('pointerup',endGesture);
  window.addEventListener('pointercancel',()=>{gesture=null;});
  close.addEventListener('click',()=>{
    for(const media of Object.values(mediaElements))media.pause();
    // Native scope grants live only for the media selected in this session.
    void win?.close();
  });
  // Resizing is managed above to preserve the selected video's aspect ratio.
  // Snap flush to the browser's inner content edges (not just the outer
  // desktop corners) and to the monitor work area, which excludes taskbars.
  // Every coordinate in snapPosition is a physical pixel for DPI correctness.
  const SNAP=26;
  let snapTimer=null,snapping=false;
  async function snapToEdge(){
    if(!win||snapping||current!=='video')return;
    snapping=true;
    try{
      const [monitor,position,size,targets]=await Promise.all([
        win.currentMonitor(),win.outerPosition(),win.outerSize(),
        tauri?.core?.invoke('browser_action',
          {name:'media-player-snap-targets',value:null}).catch(()=>null)
      ]);
      if(!monitor)return;
      const area=monitor.workArea||{position:monitor.position,size:monitor.size};
      const workArea={
        left:area.position.x,top:area.position.y,
        right:area.position.x+area.size.width,
        bottom:area.position.y+area.size.height
      };
      const next=geometry.snapPosition(position,size,targets?.viewport,workArea,SNAP);
      if(next.x!==position.x||next.y!==position.y){
        await win.setPosition(new tauri.window.PhysicalPosition(next.x,next.y));
      }
    }catch{}finally{snapping=false;}
  }
  if(win){
    void win.onMoved(()=>{
      if(snapping||current!=='video')return;
      if(snapTimer!==null)clearTimeout(snapTimer);
      snapTimer=setTimeout(()=>{snapTimer=null;void snapToEdge();},175);
    }).catch(()=>{});
  }
  if(tauri?.event){
    void tauri.event.listen('minternet:media-volume',event=>{
      const v=event.payload||{};
      if(Number.isFinite(v.level))volume.level=v.level;
      if(typeof v.muted==='boolean')volume.muted=v.muted;
      void applyVolume();
    }).catch(()=>{});
  }
  if(tauri?.core){
    void tauri.core.invoke('browser_action',{name:'volume-get',value:null})
      .then(v=>{
        if(Number.isFinite(v?.level))volume.level=v.level;
        if(typeof v?.muted==='boolean')volume.muted=v.muted;
        return applyVolume();
      }).catch(()=>{});
  }
  window.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&current)close.click();
    if(event.key===' '&&current&&event.target!==scrubber){
      event.preventDefault();toggle.click();
    }
  });
})();
