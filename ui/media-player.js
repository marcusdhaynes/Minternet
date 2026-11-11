'use strict';
(()=>{
  const $=id=>document.getElementById(id);
  const tauri=window.__TAURI__;
  const win=tauri?.window?.getCurrentWindow?.();
  const mediaElements={video:$('localVideo'),audio:$('localAudio')};
  const picker=$('mediaFile'),chooser=$('chooseSection'),error=$('mediaError');
  const controls=$('playerControls'),toggle=$('togglePlayback'),scrubber=$('playbackPosition');
  const close=$('playerClose'),resize=$('resizeCorner'),drag=$('dragZone');
  const volume={level:100,muted:false};
  let current=null,url=null,audioContext=null,gainNode=null;
  const active=()=>current&&mediaElements[current];
  async function applyVolume(){
    const value=volume.muted?0:Math.max(0,Math.min(3,volume.level/100));
    for(const media of Object.values(mediaElements)){
      // WebAudio is required for Minternet's 100-300% amplification.
      media.muted=volume.muted;
      media.volume=gainNode?1:Math.min(1,value);
    }
    if(gainNode)gainNode.gain.value=value;
  }
  function ensureGain(media){
    if(!window.AudioContext&&!window.webkitAudioContext)return;
    try{
      if(!audioContext)audioContext=new (window.AudioContext||window.webkitAudioContext)();
      if(!gainNode){gainNode=audioContext.createGain();gainNode.connect(audioContext.destination);}
      if(!media.dataset.audioRouted){
        audioContext.createMediaElementSource(media).connect(gainNode);
        media.dataset.audioRouted='true';
      }
      void audioContext.resume().catch(()=>{});
    }catch{/* Normal 0-100% HTMLMediaElement volume remains available. */}
    void applyVolume();
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
  async function selectFile(file){
    if(!file)return;
    // File is an OS-mediated user selection. The file never enters a tab,
    // cloud service, or any network request; it stays in this local WebView.
    for(const media of Object.values(mediaElements)){media.pause();media.removeAttribute('src');media.hidden=true;media.load();}
    if(url)URL.revokeObjectURL(url);
    url=URL.createObjectURL(file);
    error.hidden=true;
    current=kindFor(file);
    document.body.dataset.mode=current;
    chooser.hidden=true;controls.hidden=false;resize.hidden=current!=='video';
    const media=active();
    media.hidden=false;media.src=url;media.load();
    ensureGain(media);
    await resizeWindow(current);
    updateControls();
    try{await media.play();}catch{/* Play button remains available for codecs/autoplay blocks. */}
    updateControls();
  }
  $('chooseFile').addEventListener('click',()=>picker.click());
  picker.addEventListener('change',()=>{
    const file=picker.files?.[0];
    if(file)void selectFile(file);
    picker.value='';
  });
  toggle.addEventListener('click',async()=>{
    const media=active();if(!media)return;
    if(media.paused){
      if(audioContext)void audioContext.resume().catch(()=>{});
      try{await media.play();}catch{fail('Playback could not start. Try a supported codec.');}
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
    media.addEventListener('error',()=>fail(
      'This file uses a codec unavailable in the installed Windows media runtime. Select another format; files are never uploaded.'));
  }
  close.addEventListener('click',()=>{
    for(const media of Object.values(mediaElements))media.pause();
    if(url)URL.revokeObjectURL(url);
    void win?.close();
  });
  drag.addEventListener('pointerdown',event=>{
    if(event.button!==0||!win)return;
    void win.startDragging().catch(()=>{});
  });
  resize.addEventListener('pointerdown',event=>{
    if(event.button!==0||!win)return;
    event.preventDefault();
    void win.startResizeDragging('SouthEast').catch(()=>{});
  });
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
