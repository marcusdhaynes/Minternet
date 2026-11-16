/* Runs in site WebViews, not Minternet chrome.
   The native host independently checks WebView2.ContainsFullScreenElement;
   a forged web message cannot trigger OS fullscreen without real DOM fullscreen. */
(()=>{
  if(window.top!==window||window.__minternetFullscreenBridge)return;
  Object.defineProperty(window,'__minternetFullscreenBridge',{value:true,configurable:false});
  const report=()=>{
    try{window.chrome?.webview?.postMessage({minternetFullscreen:'change'});}catch{}
  };
  document.addEventListener('fullscreenchange',report,true);
  document.addEventListener('webkitfullscreenchange',report,true);
  window.addEventListener('pageshow',()=>{
    if(document.fullscreenElement||document.webkitFullscreenElement)report();
  });
})();
