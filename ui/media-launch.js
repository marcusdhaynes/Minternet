'use strict';
// Show the OS file picker on the original click, before creating any window.
(()=>{
 const button=document.getElementById('mediaPlayerButton');
 if(!button||!window.minternet)return;
 const picker=document.createElement('input');
 picker.type='file';picker.hidden=true;
 picker.id='minternetMediaPicker';
 picker.setAttribute('aria-label','Select Local Video or Audio');
 document.body.append(picker);
 let busy=false,activeBlob=null;
 button.addEventListener('click',()=>{
   if(!busy)picker.click(); // synchronous user gesture
 });
 picker.addEventListener('change',async()=>{
   const file=picker.files?.[0];
   picker.value='';
   if(!file||busy)return; // cancel: no media window
   busy=true;button.disabled=true;
   const selectedUrl=URL.createObjectURL(file);
   try{
     const answer=await window.minternet.command('media-player-open',
       {url:selectedUrl,name:file.name,mime:file.type||'',size:file.size});
     if(!answer?.ok)throw Error(answer?.message||'Cannot open media player');
     if(activeBlob&&activeBlob!==selectedUrl)URL.revokeObjectURL(activeBlob);
     activeBlob=selectedUrl;
   }catch(error){
     URL.revokeObjectURL(selectedUrl);
     window.minternetToast?.('Unable to play selected media: '+String(error?.message||error));
   }finally{busy=false;button.disabled=false;}
 });
 window.addEventListener('pagehide',()=>{
   if(activeBlob)URL.revokeObjectURL(activeBlob);
   activeBlob=null;
 });
})();
