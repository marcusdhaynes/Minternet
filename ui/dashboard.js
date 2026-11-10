'use strict';
// The dashboard deliberately creates no website WebView, network requests,
// timers, DOM widgets, or database. Future command-hub items can use snap().
(() => {
  const $=id=>document.getElementById(id);
  const grid=$('dashboardGrid');
  const size=$('dashboardGridSpacing');
  const snapping=$('dashboardSnap');
  if(!grid||!size||!snapping)return;
  const STORE='minternet.dashboard.grid.v1';
  const clamp=n=>Number.isFinite(n)?Math.max(12,Math.min(96,Math.round(n/2)*2)):24;
  let options={spacing:24,snap:true};
  try{
    const saved=JSON.parse(localStorage.getItem(STORE)||'{}');
    options.spacing=clamp(Number(saved.spacing));
    options.snap=saved.snap!==false;
  }catch{}
  function apply(){
    grid.style.setProperty('--dashboard-grid-spacing',options.spacing+'px');
    size.value=String(options.spacing);
    snapping.checked=options.snap;
  }
  function save(){
    try{localStorage.setItem(STORE,JSON.stringify(options));}catch{}
  }
  function refresh(){
    options.spacing=clamp(Number(size.value));
    options.snap=snapping.checked;
    apply();save();
    $('dashboardStatus').textContent='Dashboard grid settings saved';
  }
  size.addEventListener('change',refresh);
  size.addEventListener('keydown',event=>{
    if(event.key==='Enter'){event.preventDefault();size.blur();refresh();}
  });
  snapping.addEventListener('change',refresh);
  apply();
  window.minternetDashboard={
    settings:()=>({...options}),
    snap:(x,y)=>options.snap
      ?{x:Math.round(x/options.spacing)*options.spacing,
         y:Math.round(y/options.spacing)*options.spacing}
      :{x,y},
  };
})();
