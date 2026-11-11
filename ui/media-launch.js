'use strict';
// Opens a separate native mini-player. No website can pick local files.
(()=>{
  const button=document.getElementById('mediaPlayerButton');
  if(!button||!window.minternet)return;
  button.addEventListener('click',async()=>{
    button.disabled=true;
    try{
      const result=await window.minternet.command('media-player-open',null);
      if(!result?.ok)throw Error(result?.message||'Player unavailable');
    }catch(error){
      window.minternetToast?.('Cannot open local media player: '+String(error?.message||error));
    }finally{button.disabled=false;}
  });
})();
