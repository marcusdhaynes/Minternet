'use strict';
// Controls the native site's audio gain (not just the slider appearance).
// Preference storage is confined to the trusted, local browser chrome.
(() => {
  const $=id=>document.getElementById(id);
  const slider=$('volumeSlider'),button=$('volumeButton');
  const input=$('volumeNumber'),display=$('volumeValue'),hold=$('volumeHoldDelay');
  const increment1=$('volumeIncrement1'),increment10=$('volumeIncrement10'),maxSelect=$('volumeMax');
  if(!slider||!button||!input||!display||!hold||!window.minternet)return;
  const KEY='minternet.volume.v1';
  let maxVolume=300;
  const clamp=n=>Math.max(0,Math.min(maxVolume,Math.round(n)));
  const anchors=()=>Array.from({length:maxVolume/100+1},(_,i)=>i*100);
  // Magnetic snap is deliberately stronger than before: 9% capture,
  // 13% release hysteresis. Keyboard and exact-value entry retain 1% control.
  let magnet=null;
  const snap=(raw,isPointer)=>{
    const n=clamp(raw);
    if(!isPointer){magnet=null;return n;}
    if(magnet!==null&&Math.abs(n-magnet)<=13)return magnet;
    magnet=null;
    for(const anchor of anchors()){
      if(Math.abs(n-anchor)<=9){magnet=anchor;return anchor;}
    }
    return n;
  };
  let level=100,muted=false,holdSeconds=0.25,increments=10;
  try{
    const saved=JSON.parse(localStorage.getItem(KEY)||'null');
    if([100,200,300,400,500,600].includes(saved?.maxVolume))maxVolume=saved.maxVolume;
    if(Number.isInteger(saved?.level)&&saved.level>=0&&saved.level<=600)level=Math.min(saved.level,maxVolume);
    if(typeof saved?.muted==='boolean')muted=saved.muted;
    if(saved?.increments===1||saved?.increments===10)increments=saved.increments;
    if(Number.isFinite(saved?.holdSeconds)&&saved.holdSeconds>=0.1&&saved.holdSeconds<=2)
      holdSeconds=saved.holdSeconds;
  }catch{}
  const persist=()=>{
    try{localStorage.setItem(KEY,JSON.stringify({level,muted,holdSeconds,increments,maxVolume}));}catch{}
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
    slider.max=String(maxVolume);
    input.max=String(maxVolume);
    slider.setAttribute('aria-label','Browser Volume from 0 to '+maxVolume+' Percent');
    if(maxSelect)maxSelect.value=String(maxVolume);
    const wrap=slider.closest('.volume-slider-wrap');
    if(wrap){
      wrap.querySelectorAll('.volume-tick').forEach(tick=>tick.remove());
      for(let pct=100;pct<maxVolume;pct+=100){
        const tick=document.createElement('span');
        tick.className='volume-tick';
        tick.setAttribute('aria-hidden','true');
        // Account for the range thumb's half-width at either end.
        tick.style.left='calc('+((pct/maxVolume)*100)+'% + '+(7*(1-2*pct/maxVolume))+'px)';
        wrap.append(tick);
      }
    }
    slider.value=String(level);
    // Native step stays 1 to allow exact typed values; pointer and keyboard
    // selection are quantized below using the selected step of 1 or 10.
    slider.step='1';
    slider.setAttribute('aria-valuetext',level+' percent');
    slider.setAttribute('data-increments',String(increments));
    if(increment1)increment1.setAttribute('aria-pressed',String(increments===1));
    if(increment10)increment10.setAttribute('aria-pressed',String(increments===10));
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
  // Some WebView2 configurations suppress the click after a long press when
  // the button becomes hidden. Release the suppression on the next task so
  // the next intentional short click always toggles mute.
  button.addEventListener('pointerup',()=>{
    if(held)setTimeout(()=>{held=false;},0);
  });
  button.addEventListener('click',event=>{
    if(held){held=false;event.preventDefault();return;}
    toggle();
  });
  button.addEventListener('keydown',event=>{
    if(event.key==='F2'){event.preventDefault();edit();held=false;}
  });
  slider.addEventListener('pointerdown',()=>{pointerDragging=true;});
  for(const kind of ['pointerup','pointercancel','lostpointercapture']){
    slider.addEventListener(kind,()=>{pointerDragging=false;magnet=null;});
  }
  // Mouse/touch and keyboard selection obey the 1% / 10% setting.
  // The held speaker icon still allows an exact typed percentage.
  slider.addEventListener('input',()=>{
    const value=Math.round(Number(slider.value)/increments)*increments;
    update(snap(value,pointerDragging));
  });
  slider.addEventListener('keydown',event=>{
    const keys={ArrowRight:increments,ArrowUp:increments,
      ArrowLeft:-increments,ArrowDown:-increments,
      PageUp:increments*10,PageDown:-increments*10};
    if(Object.hasOwn(keys,event.key)){
      event.preventDefault();
      update(clamp(level+keys[event.key]));
    }else if(event.key==='Home'||event.key==='End'){
      event.preventDefault();
      update(event.key==='Home'?0:maxVolume);
    }
  });
  function setIncrements(value){
    if(value!==1&&value!==10)return;
    increments=value;
    magnet=null;
    render();persist();
  }
  increment1?.addEventListener('click',()=>setIncrements(1));
  increment10?.addEventListener('click',()=>setIncrements(10));
  maxSelect?.addEventListener('change',()=>{
    const next=Number(maxSelect.value);
    if(![100,200,300,400,500,600].includes(next))return;
    maxVolume=next;level=Math.min(level,maxVolume);magnet=null;
    render();persist();requestApply();
  });
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
  window.minternetVolume={get:()=>({level,muted,holdSeconds,increments,maxVolume})};
})();
