'use strict';
// Shared frontend: replaces the Electron preload only inside the Tauri native app.
if (window.__TAURI__ && !window.minternet) {
  const api=window.__TAURI__;
  // Register the native popup event ONCE, not once per onState subscriber.
  // Several browser subsystems subscribe to state; each was opening a tab
  // independently for the same Ctrl-click or window.open event.
  let popupListenerStarted=false;
  function ensurePopupListener(){
    if(popupListenerStarted)return;
    popupListenerStarted=true;
    api.event.listen('minternet:open-tab',event=>{
      const url=event.payload;
      if(typeof url==='string'&&url.startsWith('https://')){
        void api.core.invoke('browser_action',{name:'new-url',value:url}).catch(()=>{});
      }
    }).catch(()=>{popupListenerStarted=false;});
  }
  ensurePopupListener();
  window.minternet={
    command:async (name,value)=>{
      try {
        // Search choice is transported with each navigation, avoiding a race
        // between restoring preferences and the first typed query.
        const payload=name==='navigate'&&typeof value==='string'
          ? {address:value,searchEngine:window.minternetSearch?.getEngine?.()||'google'}
          : value===undefined?null:value;
        return await api.core.invoke('browser_action',{name,value:payload});
      }
      catch(err){ return {message:String(err)}; }
    },
    onState:cb=>{
      let alive=true,unlisten=()=>{};
      api.event.listen('minternet:state',event=>{if(alive)cb(event.payload)})
        .then(unsub=>{unlisten=unsub;})
        .catch(()=>{});
      api.core.invoke('browser_snapshot').then(state=>{if(alive)cb(state)}).catch(()=>{});
      return ()=>{alive=false;unlisten();};
    },
    onFocusAddress:()=>()=>{}
  };
}
