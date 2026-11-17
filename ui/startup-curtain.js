'use strict';
// The restored tab is already selected natively before the browser is shown.
// Keep the browser window hidden until this trusted, opaque chrome surface is
// rendered; do not reveal a white or unpainted website WebView2 at startup.
(() => {
  if (!window.__minternetStartupArmed) return;
  const root=document.documentElement;
  const curtain=document.getElementById('startupCurtain');
  const status=document.getElementById('startupCurtainStatus');
  const retry=document.getElementById('startupCurtainRetry');
  if (!curtain) return;
  root.classList.add('minternet-startup-armed');
  let completed=false,requested=false;
  let failureTimer=null;
  function failure(){
    if(completed)return;
    if(status)status.textContent='The last tab has not rendered yet. You can retry without losing your session, or select another tab above.';
    if(retry)retry.hidden=false;
  }
  window.minternetStartup={
    finish(){
      if(completed)return;
      completed=true;
      clearTimeout(failureTimer);
      root.classList.remove('minternet-startup-armed');
      curtain.setAttribute('aria-hidden','true');
    },
    failed:failure
  };
  retry?.addEventListener('click',async()=>{
    if(completed)return;
    retry.disabled=true;
    if(status)status.textContent='Retrying the last tab…';
    // The native startup curtain remains in place while reloading.
    await window.minternet?.command('reload');
    retry.disabled=false;
    failureTimer=setTimeout(failure,12000);
  });
  async function present(){
    if(completed||requested)return;
    const box=curtain.getBoundingClientRect();
    const style=getComputedStyle(curtain);
    // This proof is local: no untrusted website can decide when the
    // parent window is shown.
    if(style.display==='none'||style.backgroundColor==='rgba(0, 0, 0, 0)'||
       box.height<120||box.width<300){
      requestAnimationFrame(present);
      return;
    }
    requested=true;
    const result=await window.minternet?.command('startup-present',{curtainReady:true});
    if(result?.message){
      requested=false;
      if(status)status.textContent='Preparing the browser window…';
      setTimeout(()=>requestAnimationFrame(present),350);
    }
  }
  requestAnimationFrame(()=>requestAnimationFrame(present));
  failureTimer=setTimeout(failure,12000);
})();
