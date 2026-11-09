'use strict';
// Controls the native site's audio gain (not just the slider appearance).
// Preference storage is confined to the trusted, local browser chrome.
(() => {
  const $=id=>document.getElementById(id);
  const slider=$('volumeSlider'),button=$('volumeButton');
  const input=$('volumeNumber'),display=$('volumeValue'),hold=$('volumeHoldDelay');
  if(!slider||!button||!input||!display||!hold||!window.minternet)return;
  const KEY='minternet.volume.v1';
  const clamp=n=>Math.max(0,Math.min(300,Math.round(n)));
  const anchors=[0,100,200,300];
  const snap=(raw,isPointer)=>{
    const n=clamp(raw);
    // Gentle 2-unit magnetism when dragged; keyboard and text preserve 1% steps.
    if(isPointer)for(const v of anchors)if(Math.abs(v-n)<=2)return v;
    return n;
  };
  let level=100,muted=false,holdSeconds=0.25;
  try{
    const saved=JSON.parse(localStorage.getItem(KEY)||'null');
    if(Number.isInteger(saved?.level)&&saved.level>=0&&saved.level<=300)level=saved.level;
    if(typeof saved?.muted==='boolean')muted=saved.muted;
    if(Number.isFinite(saved?.holdSeconds)&&saved.holdSeconds>=0.1&&saved.holdSeconds<=2)
      holdSeconds=saved.holdSeconds;
  }catch{}
  const persist=()=>{
    try{localStorage.setItem(KEY,JSON.stringify({level,muted,holdSeconds}));}catch{}
  };
  let pending=false,dirty=false;
  async function flush(){
    if(pending||!window.__TAURI__)return;
    pending=true;
    try{
      while(dirty){
        dirty=false;
        const state={level,muted};
        await window.minternet.command('volume-set',state);
      }
    }catch(error){
      window.minternetToast?.('Audio level could not be applied: '+String(error?.message||error));
    }finally{pending=false;}
  }
  let frame=false;
  function requestApply(){
    dirty=true;
    if(frame)return;
    frame=true;
    requestAnimationFrame(()=>{frame=false;void flush();});
  }
  function render(){
    slider.value=String(level);
    slider.setAttribute('aria-valuetext',level+' percent');
    button.setAttribute('aria-pressed',String(muted||level===0));
    button.title=muted?'Unmute Browser Audio · Hold for Exact Volume':
      'Mute Browser Audio · Hold for Exact Volume';
    display.textContent=level+'%';
  }
  function update(next){
    level=clamp(next);
    muted=false;
    render();persist();requestApply();
  }
  function toggle(){
    muted=!muted;
    render();persist();requestApply();
  }
  let editing=false,pressTimer=null,held=false,pointerDragging=false;
  const cancelPress=()=>{if(pressTimer!==null)clearTimeout(pressTimer);pressTimer=null;};
  function edit(){
    if(editing)return;
    editing=true;held=true;cancelPress();
    input.value=String(level);
    button.hidden=true;input.hidden=false;input.focus();input.select();
  }
  function closeEdit(submit){
    if(!editing)return;
    const raw=input.value.trim();
    editing=false;input.hidden=true;button.hidden=false;
    if(submit&&raw!==''&&Number.isFinite(Number(raw))){
      update(clamp(Number(raw)));
    }else render();
  }
  button.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;
    held=false;cancelPress();
    pressTimer=setTimeout(edit,Math.round(holdSeconds*1000));
  });
  for(const kind of ['pointerup','pointercancel','pointerleave','lostpointercapture']){
    button.addEventListener(kind,cancelPress);
  }
  button.addEventListener('click',event=>{
    if(held){held=false;event.preventDefault();return;}
    toggle();
  });
  button.addEventListener('keydown',event=>{
    if(event.key==='F2'){event.preventDefault();edit();}
  });
  slider.addEventListener('pointerdown',()=>{pointerDragging=true;});
  for(const kind of ['pointerup','pointercancel','lostpointercapture']){
    slider.addEventListener(kind,()=>{pointerDragging=false;});
  }
  slider.addEventListener('input',()=>update(snap(Number(slider.value),pointerDragging)));
  input.addEventListener('keydown',event=>{
    if(event.key==='Enter'){event.preventDefault();closeEdit(true);button.focus();}
    if(event.key==='Escape'){event.preventDefault();closeEdit(false);button.focus();}
  });
  input.addEventListener('blur',()=>closeEdit(true));
  hold.value=String(holdSeconds);
  function changeHold(){
    const n=Number(hold.value);
    if(!Number.isFinite(n)||n<0.1||n>2){hold.value=String(holdSeconds);return;}
    holdSeconds=Math.round(n*100)/100;
    hold.value=String(holdSeconds);
    persist();
  }
  hold.addEventListener('change',changeHold);
  render();
  requestApply();
  window.minternetVolume={get:()=>({level,muted,holdSeconds})};
})();
