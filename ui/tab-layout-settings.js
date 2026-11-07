'use strict';
// The tab strip is native app chrome, so these preferences are kept in its
// local storage, not in any website's browsing context.
(() => {
  const root=document.documentElement;
  const key='minternet.tab-layout.v1';
  const defaults={group:56,regular:38,pinned:27,showAppIcon:true};
  const specs=[
    {id:'groupTabWidth',key:'group',css:'--minternet-group-tab-width',min:32,max:320},
    {id:'regularTabWidth',key:'regular',css:'--minternet-regular-tab-width',min:32,max:320},
    {id:'pinnedTabWidth',key:'pinned',css:'--minternet-pinned-tab-width',min:24,max:200}
  ];
  const $=id=>document.getElementById(id);
  const usable=(v,s)=>Number.isInteger(v)&&v>=s.min&&v<=s.max;
  function read(){
    let saved;
    try{saved=JSON.parse(localStorage.getItem(key));}catch{return {...defaults};}
    if(!saved||typeof saved!=='object'||Array.isArray(saved))return {...defaults};
    const result={...defaults};
    for(const spec of specs){
      if(usable(saved[spec.key],spec))result[spec.key]=saved[spec.key];
    }
    if(typeof saved.showAppIcon==='boolean')result.showAppIcon=saved.showAppIcon;
    return result;
  }
  let current=read();
  function apply(){
    for(const spec of specs)
      root.style.setProperty(spec.css,current[spec.key]+'px');
    root.classList.toggle('minternet-app-icon-hidden',!current.showAppIcon);
  }
  function save(){
    try{localStorage.setItem(key,JSON.stringify(current));}catch{
      // Still apply this session's settings when storage is unavailable.
    }
  }
  function refreshControls(){
    for(const spec of specs){
      const input=$(spec.id);
      if(input)input.value=String(current[spec.key]);
    }
    const icon=$('showTabBarAppIcon');
    if(icon)icon.checked=current.showAppIcon;
  }
  // Apply synchronously on startup, before the deferred tab renderer paints.
  apply();
  refreshControls();
  for(const spec of specs){
    const input=$(spec.id);
    if(!input)continue;
    const commit=clamp=>{
      const numeric=Number(input.value);
      if(!Number.isFinite(numeric) || input.value.trim()===''){
        if(clamp)input.value=String(current[spec.key]);
        return;
      }
      if(!clamp&&!usable(numeric,spec))return;
      const next=Math.max(spec.min,Math.min(spec.max,Math.round(numeric)));
      if(next!==current[spec.key]){
        current[spec.key]=next;apply();save();
      }
      if(clamp)input.value=String(next);
    };
    input.addEventListener('input',()=>commit(false));
    input.addEventListener('change',()=>commit(true));
  }
  const icon=$('showTabBarAppIcon');
  icon?.addEventListener('change',()=>{
    current.showAppIcon=Boolean(icon.checked);
    apply();save();
  });
  $('resetTabWidths')?.addEventListener('click',()=>{
    for(const spec of specs)current[spec.key]=defaults[spec.key];
    apply();save();refreshControls();
  });
  window.addEventListener('storage',event=>{
    if(event.key!==key)return;
    current=read();apply();refreshControls();
  });
  window.minternetTabLayout={defaults:{...defaults},get:()=>({...current})};
})();
