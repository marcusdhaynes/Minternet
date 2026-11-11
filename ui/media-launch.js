'use strict';
// The toolbar icon contains a real transparent <input type="file">.
// Native WebView2 sees a genuine mouse click on the input: no hidden-input
// synthetic file-dialog activation, dialog plugin, or intermediate window.
(()=>{
  const icon=document.getElementById('mediaPlayerButton');
  const picker=document.getElementById('minternetMediaPicker');
  if(!icon||!picker)return;
  let busy=false,activeBlob=null;
  function report(message){
    if(typeof window.minternetToast==='function')window.minternetToast(message);
    else{
      // A visible fallback prevents a failed player start from appearing to
      // do nothing if the toast subsystem has not loaded.
      let status=document.getElementById('minternetMediaStatus');
      if(!status){
        status=document.createElement('div');
        status.id='minternetMediaStatus';
        status.setAttribute('role','alert');
        document.body.append(status);
      }
      status.textContent=message;
      status.hidden=false;
      setTimeout(()=>{status.hidden=true;},7500);
    }
  }
  picker.addEventListener('change',async()=>{
    const file=picker.files?.[0];
    picker.value='';
    if(!file||busy)return; // Cancel never opens the player.
    busy=true;icon.classList.add('media-loading');
    picker.disabled=true;
    let selectedUrl=null;
    try{
      if(!window.minternet?.command)throw Error('Native Minternet bridge is unavailable');
      selectedUrl=URL.createObjectURL(file);
      const answer=await window.minternet.command('media-player-open',{
        url:selectedUrl,name:file.name,mime:file.type||'',size:file.size
      });
      if(!answer?.ok)throw Error(answer?.message||'The media window did not open');
      if(activeBlob&&activeBlob!==selectedUrl)URL.revokeObjectURL(activeBlob);
      activeBlob=selectedUrl;
      selectedUrl=null; // owned by the trusted chrome while the player runs
    }catch(error){
      report('Media player: '+String(error?.message||error));
    }finally{
      if(selectedUrl)URL.revokeObjectURL(selectedUrl);
      busy=false;picker.disabled=false;
      icon.classList.remove('media-loading');
    }
  });
  window.addEventListener('pagehide',()=>{
    if(activeBlob)URL.revokeObjectURL(activeBlob);
    activeBlob=null;
  });
})();
