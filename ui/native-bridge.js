'use strict';
// Shared frontend: replaces the Electron preload only inside the Tauri native app.
if (window.__TAURI__ && !window.minternet) {
  const api=window.__TAURI__;
  const listeners=[];
  window.minternet={
    command:async (name,value)=>{
      try { return await api.core.invoke('browser_action',{name,value:value===undefined?null:value}); }
      catch(err){ return {message:String(err)}; }
    },
    onState:cb=>{
      let alive=true,unlisten=()=>{};
      api.event.listen('minternet:state',event=>{if(alive)cb(event.payload)})
        .then(unsub=>{unlisten=unsub;})
        .catch(()=>{});
      api.event.listen('minternet:open-tab',event=>{
        if(alive)api.core.invoke('browser_action',{name:'new-url',value:event.payload}).catch(()=>{});
      }).then(unsub=>listeners.push(unsub)).catch(()=>{});
      api.core.invoke('browser_snapshot').then(state=>{if(alive)cb(state)}).catch(()=>{});
      return ()=>{alive=false;unlisten();};
    },
    onFocusAddress:()=>()=>{}
  };
}
