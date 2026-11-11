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
  let current=null,url=null,sourceGeneration=0,normalizing=false,usedCodecFallback=false;
  const HIDE_DELAY=5000,DRAG_THRESHOLD=5,MIN_VIDEO_WIDTH=80;
  let controlsTimer=null,lastVideoRatio=16/9,gesture=null;
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
    const w=Math.max(MIN_VIDEO_WIDTH,width);
    await win.setSize(new tauri.window.LogicalSize(w,w/videoRatio()));
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
    const media=active();
    if(!quiet){
      error.textContent='Preparing this format with the local codec engine…';
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
      normalizing=false;
    }
  }
  async function maybeNormalize(selection,generation){
    const name=(selection.name||'').toLowerCase();
    // These containers commonly carry audio codecs absent from WebView2.
    if(!/\.(mkv|mka|avi|wmv|wma|flv|ape|ac3|eac3|dts|amr|aif|aiff)$/i.test(name))return;
    try{
      const available=await tauri?.core?.invoke('browser_action',
        {name:'media-player-codec-available',value:null});
      if(available?.ok&&generation===sourceGeneration){
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
       /^(mp3|aac|m4a|wav|flac|ogg|oga|opus|aiff|aif|wma|mid|midi)$/.test(ext))return 'audio';
    return 'video';
  }
  async function resizeWindow(mode){
    if(!win)return;
    try{
      await win.setSize(new tauri.window.LogicalSize(
        mode==='audio'?358:mode==='video'?410:368,
        mode==='audio'?76:mode==='video'?258:116));
    }catch{}
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
    error.hidden=true;
    current=kindFor({name:selection.name||'',type:selection.mime||''});
    document.body.dataset.mode=current;
    controls.hidden=false;resize.hidden=current!=='video';
    document.body.classList.remove('controls-idle');
    clearTimeout(controlsTimer);
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
      try{await media.play();}catch{
        void codecFallback(sourceGeneration);
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
    lastVideoRatio=videoRatio();
    void sizeToVideo(Math.max(MIN_VIDEO_WIDTH,Math.round(258*lastVideoRatio)));
  });
  const root=document.querySelector('.player-root');
  root.addEventListener('pointermove',showControls);
  root.addEventListener('pointerenter',showControls);
  function startGesture(event,isResize=false){
    if(event.button!==0||!win||current!=='video')return;
    event.preventDefault();
    event.stopPropagation();
    gesture={x:event.screenX,y:event.screenY,resize:isResize,
      width:window.innerWidth,dragged:false,pending:false};
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
      if(!g.pending){
        g.pending=true;
        void sizeToVideo(g.width+delta).finally(()=>{g.pending=false;});
      }
    }else{
      // Only begin native dragging when the pointer has moved beyond a click.
      gesture=null;
      void win.startDragging().catch(()=>{});
    }
  }
  function endGesture(event){
    if(!gesture)return;
    const g=gesture;gesture=null;
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
  // Use physical monitor coordinates for DPI-correct snap on every display.
  const SNAP=26;
  let snapTimer=null,snapping=false;
  async function snapToEdge(){
    if(!win||snapping)return;
    snapping=true;
    try{
      const [monitor,position,size]=await Promise.all([
        win.currentMonitor(),win.outerPosition(),win.outerSize()]);
      if(!monitor)return;
      const left=monitor.position.x,top=monitor.position.y;
      const right=left+monitor.size.width-size.width;
      const bottom=top+monitor.size.height-size.height;
      let x=position.x,y=position.y;
      if(Math.abs(x-left)<=SNAP)x=left;
      else if(Math.abs(x-right)<=SNAP)x=right;
      if(Math.abs(y-top)<=SNAP)y=top;
      else if(Math.abs(y-bottom)<=SNAP)y=bottom;
      if(x!==position.x||y!==position.y){
        await win.setPosition(new tauri.window.PhysicalPosition(x,y));
      }
    }catch{}finally{snapping=false;}
  }
  if(win){
    void win.onMoved(()=>{
      if(snapping)return;
      if(snapTimer!==null)clearTimeout(snapTimer);
      snapTimer=setTimeout(()=>{snapTimer=null;void snapToEdge();},230);
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
