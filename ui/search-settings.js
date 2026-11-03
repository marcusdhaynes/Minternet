'use strict';
// Local-only preferences. Each new address/search is forwarded with the chosen
// engine; the native browser allows only its own fixed HTTPS search providers.
(() => {
  const key='minternet.search-engine.v1';
  const supported=['google','duckduckgo','bing','brave','startpage','ecosia'];
  const valid=value=>supported.includes(value)?value:'google';
  let current='google';
  try { current=valid(localStorage.getItem(key)); } catch {}
  const select=document.getElementById('defaultSearchEngine');
  if(select) {
    select.value=current;
    select.addEventListener('change',()=>{
      current=valid(select.value);
      select.value=current;
      try {localStorage.setItem(key,current);} catch {
        window.minternetToast?.('Default search setting could not be saved.');
      }
    });
  }
  window.minternetSearch={
    getEngine:()=>current,
    setEngine:engine=>{
      current=valid(engine);
      if(select) select.value=current;
      try {localStorage.setItem(key,current);} catch {}
      return current;
    }
  };
})();
