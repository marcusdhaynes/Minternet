'use strict';
(()=>{
  const $=id=>document.getElementById(id);
  const tauri=window.__TAURI__;
  const win=tauri?.window?.getCurrentWindow?.();
  const mediaElements={video:$('localVideo'),audio:$('localAudio')};
  const error=$('mediaError');
  const controls=$('playerControls'),toggle=$('togglePlayback'),scrubber=$('playbackPosition');
  const close=$('playerClose'),drag=$('dragZone'),playbackIcon=$('playbackIcon');
  const currentTime=$('currentTime'),durationTime=$('durationTime');
  const subtitleToggle=$('subtitleToggle'),subtitlePanel=$('subtitlePanel');
  const subtitlePick=$('subtitlePick'),subtitleOff=$('subtitleOff');
  const subtitleOverlay=$('subtitleOverlay'),subtitleName=$('subtitleName');
  const fullscreenToggle=$('fullscreenToggle');
  let subtitleCues=[],subtitleEnabled=false,stopHoldTimer=null,holdFired=false,fullscreenActive=false;
  const volume={level:100,muted:false};
  let current=null,url=null,sourceGeneration=0,normalizing=false,normalizingGeneration=0,usedCodecFallback=false;
  const HIDE_DELAY=5000,DRAG_THRESHOLD=5,MIN_VIDEO_WIDTH=80;
  let controlsDelay=HIDE_DELAY;
  const geometry=window.MinternetMediaGeometry;
  let controlsTimer=null,lastVideoRatio=16/9,gesture=null;
  let pendingVideoSize=null,resizingVideo=false,metadataSizedGeneration=0;
  function showControls(){
    if(current!=='video')return;
    document.body.classList.remove('controls-idle');
    clearTimeout(controlsTimer);
    if(controlsDelay>0){
      controlsTimer=setTimeout(()=>{
        if(!gesture)document.body.classList.add('controls-idle');
      },controlsDelay);
    }
  }
  function setFadeSeconds(seconds){
    if(!Number.isInteger(seconds)||seconds<0||seconds>300)return;
    controlsDelay=seconds*1000;
    showControls();
  }
  function videoRatio(){
    const v=mediaElements.video;
    return v.videoWidth>0&&v.videoHeight>0?v.videoWidth/v.videoHeight:lastVideoRatio;
  }
  async function sizeToVideo(width,anchoredPosition=null){
    if(!win||current!=='video')return;
    const dims=geometry.aspectSize(width,videoRatio(),MIN_VIDEO_WIDTH,45);
    pendingVideoSize={...dims,anchoredPosition};
    if(resizingVideo)return;
    resizingVideo=true;
    try{
      while(pendingVideoSize&&current==='video'){
        const size=pendingVideoSize;
        pendingVideoSize=null;
        await win.setSize(new tauri.window.LogicalSize(size.width,size.height));
        if(size.anchoredPosition){
          await win.setPosition(new tauri.window.PhysicalPosition(
            size.anchoredPosition.x,size.anchoredPosition.y));
        }
      }
    }catch{/* Window may have closed during resize. */}
    finally{
      resizingVideo=false;
      // Drain a pointer event that arrived during an unsuccessful size request.
      if(pendingVideoSize&&current==='video'){
        const pending=pendingVideoSize;
        pendingVideoSize=null;
        void sizeToVideo(pending.width,pending.anchoredPosition);
      }
    }
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
  function clock(seconds){
    if(!Number.isFinite(seconds)||seconds<0)return '0:00';
    const s=Math.floor(seconds),m=Math.floor(s/60),h=Math.floor(m/60);
    return (h?h+':'+String(m%60).padStart(2,'0'):String(m))+
      ':'+String(s%60).padStart(2,'0');
  }
  function renderCaptions(){
    const media=active(),t=media?.currentTime||0;
    const cue=subtitleEnabled&&current==='video'
      ?subtitleCues.find(c=>c.start<=t&&c.end>=t):null;
    subtitleOverlay.textContent=cue?.text||'';
    subtitleOverlay.hidden=!cue;
  }
  function updateControls(){
    const media=active();if(!media)return;
    playbackIcon.innerHTML=media.paused
      ?'<path d="m8.5 5.5 10.5 6.5-10.5 6.5V5.5Z"/>'
      :'<path d="M8 5.5v13m8-13v13"/>';
    toggle.setAttribute('aria-label',media.paused?'Play · Hold to Stop':'Pause · Hold to Stop');
    scrubber.value=Number.isFinite(media.duration)&&media.duration>0?
      String(Math.round(media.currentTime/media.duration*1000)):'0';
    scrubber.disabled=!Number.isFinite(media.duration)||media.duration<=0;
    currentTime.textContent=clock(media.currentTime);
    durationTime.textContent=clock(media.duration);
    renderCaptions();
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
    controls.hidden=false;
    subtitlePanel.hidden=true;
    subtitleOverlay.hidden=true;
    subtitleCues=[];subtitleEnabled=false;
    subtitleName.textContent='Off';
    subtitleToggle.setAttribute('aria-pressed','false');
    subtitleToggle.setAttribute('aria-expanded','false');
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
  // Marmalade-style play/pause; a deliberate hold stops and rewinds without
  // opening Explorer or discarding the current selected media file.
  function stopPlayback(){
    const media=active();if(!media)return;
    media.pause();
    try{media.currentTime=0;}catch{}
    updateControls();
    showControls();
  }
  toggle.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;
    holdFired=false;
    clearTimeout(stopHoldTimer);
    stopHoldTimer=setTimeout(()=>{holdFired=true;stopPlayback();},600);
  });
  for(const type of ['pointerup','pointercancel','pointerleave'])
    toggle.addEventListener(type,()=>clearTimeout(stopHoldTimer));
  toggle.addEventListener('click',async()=>{
    if(holdFired){holdFired=false;return;}
    const media=active();if(!media)return;
    if(media.paused){
      try{await media.play();}catch(e){
        if(e?.name==='NotSupportedError')void codecFallback(sourceGeneration);
        else if(e?.name!=='NotAllowedError')fail('Playback failed: '+String(e?.message||e));
      }
    }else media.pause();
    updateControls();
  });
  subtitleToggle.addEventListener('click',()=>{
    if(current!=='video')return;
    subtitlePanel.hidden=!subtitlePanel.hidden;
    subtitleToggle.setAttribute('aria-expanded',String(!subtitlePanel.hidden));
    showControls();
  });
  subtitlePick.addEventListener('click',async()=>{
    if(!tauri?.core?.invoke)return;
    try{
      const chosen=await tauri.core.invoke('browser_action',
        {name:'media-player-subtitle-pick',value:null});
      if(chosen?.cancelled)return;
      const parsed=window.MinternetSubtitles.parse(chosen.content||'',chosen.name||'');
      if(!parsed.length){fail('No valid subtitle cues found in this file.');return;}
      subtitleCues=parsed;subtitleEnabled=true;
      subtitleName.textContent=chosen.name;
      subtitleToggle.setAttribute('aria-pressed','true');
      subtitlePanel.hidden=true;
      subtitleToggle.setAttribute('aria-expanded','false');
      error.hidden=true;
      renderCaptions();showControls();
    }catch(e){fail('Could not load subtitles: '+String(e?.message||e));}
  });
  subtitleOff.addEventListener('click',()=>{
    subtitleEnabled=false;subtitleCues=[];
    subtitleOverlay.textContent='';subtitleOverlay.hidden=true;
    subtitleName.textContent='Off';
    subtitleToggle.setAttribute('aria-pressed','false');
    subtitleToggle.setAttribute('aria-expanded','false');
    subtitlePanel.hidden=true;showControls();
  });
  fullscreenToggle.addEventListener('click',async()=>{
    if(!win||current!=='video')return;
    try{
      const full=await win.isFullscreen();
      await win.setFullscreen(!full);
      fullscreenActive=!full;
      fullscreenToggle.setAttribute('aria-pressed',String(!full));
      fullscreenToggle.title=full?'Full Screen':'Exit Full Screen';
      showControls();
    }catch(e){fail('Full screen failed: '+String(e?.message||e));}
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
  // All four edges and all corners resize. In addition, Shift+drag or
  // right-drag anywhere in the video resizes without sacrificing left-drag
  // to move, or a click to toggle playback.
  const EDGE_HIT=13;
  function edgeAt(event){
    const bounds=root.getBoundingClientRect();
    const x=event.clientX-bounds.left,y=event.clientY-bounds.top;
    return (x<=EDGE_HIT?'l':x>=bounds.width-EDGE_HIT?'r':'')+
           (y<=EDGE_HIT?'t':y>=bounds.height-EDGE_HIT?'b':'');
  }
  function edgeCursor(edges){
    if(edges==='lt'||edges==='rb')return 'nwse-resize';
    if(edges==='rt'||edges==='lb')return 'nesw-resize';
    if(edges==='l'||edges==='r')return 'ew-resize';
    if(edges==='t'||edges==='b')return 'ns-resize';
    return 'grab';
  }
  function startGesture(event){
    if(!win||current!=='video'||(event.button!==0&&event.button!==2))return;
    if(event.target.closest?.('.player-controls,.player-close,.subtitle-popover,#mediaError'))
      return;
    const edges=edgeAt(event);
    const isResize=Boolean(edges)||event.shiftKey||event.button===2;
    // Arbitrary-surface resizes anchor at the lower-right corner.
    const anchor=edges||'rb';
    event.preventDefault();
    event.stopPropagation();
    const g={x:event.screenX,y:event.screenY,resize:isResize,edges:anchor,
      width:window.innerWidth,height:window.innerHeight,
      dragged:false,requestedWidth:window.innerWidth,
      initialPosition:null,scale:1,desiredPosition:null};
    gesture=g;
    root.setPointerCapture?.(event.pointerId);
    if(isResize){
      void Promise.all([win.outerPosition(),win.scaleFactor()]).then(([position,scale])=>{
        g.initialPosition=position;
        g.scale=Number.isFinite(scale)&&scale>0?scale:1;
        if(g.dragged)applyResizeGesture(g);
      }).catch(()=>{});
    }
    showControls();
  }
  function applyResizeGesture(g){
    if(!g.initialPosition)return;
    const ratio=videoRatio(),dx=g.deltaX||0,dy=g.deltaY||0;
    const side=g.edges;
    const xWidth=side.includes('l')?-dx:dx;
    const yWidth=(side.includes('t')?-dy:dy)*ratio;
    let change;
    if(side.length===2){
      change=Math.abs(xWidth)>=Math.abs(yWidth)?xWidth:yWidth;
    }else if(side.includes('l')||side.includes('r'))change=xWidth;
    else change=yWidth;
    const dims=geometry.aspectSize(g.width+change,ratio,MIN_VIDEO_WIDTH,45);
    g.requestedWidth=dims.width;
    const pos={
      x:Math.round(g.initialPosition.x+
        (side.includes('l')?(g.width-dims.width)*g.scale:0)),
      y:Math.round(g.initialPosition.y+
        (side.includes('t')?(g.height-dims.height)*g.scale:0))
    };
    g.desiredPosition=pos;
    void sizeToVideo(g.requestedWidth,pos);
  }
  function moveGesture(event){
    if(!gesture)return;
    const g=gesture;
    g.deltaX=event.screenX-g.x;
    g.deltaY=event.screenY-g.y;
    if(!g.dragged&&Math.hypot(g.deltaX,g.deltaY)<DRAG_THRESHOLD)return;
    g.dragged=true;
    if(g.resize)applyResizeGesture(g);
    else{
      gesture=null;
      // startDragging may enter the native Windows modal move loop. Snap on
      // its release as well as onMoved; relying on debounced onMoved alone
      // misses the final position on some WebView2 runtimes.
      void win.startDragging().then(()=>{
        void snapToEdge();
        setTimeout(()=>{void snapToEdge();},140);
      }).catch(()=>{});

    }
  }
  function endGesture(event){
    if(!gesture)return;
    const g=gesture;gesture=null;
    if(g.resize&&g.dragged){
      applyResizeGesture(g);
      setTimeout(()=>{void snapToEdge();},140);
    }
    if(!g.dragged&&!g.resize&&event.type==='pointerup')toggle.click();
    showControls();
  }
  root.addEventListener('pointerdown',startGesture,true);
  mediaElements.video.addEventListener('pointermove',event=>{
    if(!gesture&&current==='video')mediaElements.video.style.cursor=
      edgeCursor(edgeAt(event));
  });
  root.addEventListener('contextmenu',event=>{
    if(current==='video')event.preventDefault();
  });
  window.addEventListener('pointermove',moveGesture);
  window.addEventListener('pointerup',endGesture);
  window.addEventListener('pointercancel',()=>{gesture=null;});
  // Audio-only mini-player remains movable through its unobtrusive title strip.
  drag.addEventListener('pointerdown',event=>{
    if(current!=='audio'||event.button!==0||!win)return;
    event.preventDefault();
    void win.startDragging().then(()=>{
      void snapToEdge();setTimeout(()=>{void snapToEdge();},140);
    }).catch(()=>{});
  });
  close.addEventListener('click',()=>{
    for(const media of Object.values(mediaElements))media.pause();
    // Native scope grants live only for the media selected in this session.
    void win?.close();
  });
  // Resizing is managed above to preserve the selected video's aspect ratio.
  // Snap flush to the browser's inner content edges (not just the outer
  // desktop corners) and to the monitor work area, which excludes taskbars.
  // Every coordinate in snapPosition is a physical pixel for DPI correctness.
  const SNAP=40; // Physical pixels: usable even at 125–200% display scaling.
  let snapTimer=null,snapping=false;
  async function snapToEdge(){
    if(!win||snapping||fullscreenActive||gesture?.resize||resizingVideo)return;
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
      if(snapping||fullscreenActive)return;
      if(snapTimer!==null)clearTimeout(snapTimer);
      snapTimer=setTimeout(()=>{snapTimer=null;void snapToEdge();},175);
    }).catch(()=>{});
  }
  if(tauri?.event){
    void tauri.event.listen('minternet:miniplayer-settings',event=>{
      setFadeSeconds(event.payload?.fadeSeconds);
    }).catch(()=>{});
  }
  if(tauri?.core){
    void tauri.core.invoke('browser_action',
      {name:'media-player-settings-get',value:null})
      .then(preferences=>setFadeSeconds(preferences?.fadeSeconds)).catch(()=>{});
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
    if(event.key==='Escape'&&!subtitlePanel.hidden){
      subtitlePanel.hidden=true;subtitleToggle.setAttribute('aria-expanded','false');return;
    }
    if(event.key==='Escape'&&current){
      void win?.isFullscreen().then(full=>{
        if(full){
          fullscreenActive=false;
          void win.setFullscreen(false);
          fullscreenToggle.setAttribute('aria-pressed','false');
        }
        else close.click();
      }).catch(()=>close.click());return;
    }
    if(event.key===' '&&current&&event.target!==scrubber){
      event.preventDefault();toggle.click();
    }
  });
})();
